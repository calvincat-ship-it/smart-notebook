'use strict';

/* ---------------- Storage ---------------- */
const STORAGE_KEY = 'smart_notebook_v1';
const SETTINGS_KEY = 'smart_notebook_settings_v1';
const USAGE_KEY = 'smart_notebook_usage_v1';

// ---- Cloud sync (Google Drive appDataFolder) — consts declared up top on
// purpose: loadCloudState() runs with the other top-level state below and reads
// CLOUD_KEY, so leaving these lower would cause a TDZ error that halts init.
// GOOGLE_CLIENT_ID is filled in once the user creates a new OAuth Web client
// (its own client = its own private appDataFolder, isolated from other apps).
// Shown after the app name in the header so the user can see which build they're
// on. Versioning follows the blood-pressure app's rule: form vNN.MM — small
// changes bump the minor directly (v9 → v9.01), big features confirm first.
// Keep in step with the sw.js CACHE_NAME on every deploy.
const APP_VERSION = 'v11.03';

const CLOUD_KEY = 'smart_notebook_cloud_v1';
const GOOGLE_CLIENT_ID = '682239566772-bl0vpkhi4hj1ih33gv6uheic2iqqojp6.apps.googleusercontent.com';
const DRIVE_SCOPE = 'openid email https://www.googleapis.com/auth/drive.appdata';
const CLOUD_FILENAME = 'notebook-backup.json';

// Attachments: any file type, capped at 10MB each. The binary lives locally in
// IndexedDB and, when cloud sync is on, as its own file in the Drive
// appDataFolder (so the frequently-synced JSON bundle stays small). The bundle
// only carries lightweight metadata (id/name/type/size/driveFileId/link).
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;

// Every note bullet gets a stable id (編號). Tasks and attachments reference the
// same id, so a note item, its task, and its file always correspond — and stay
// linked across Claude's re-merges (ids are preserved by text-matching, see
// mergeCategories). The app owns ids; Claude's own I/O stays text-based.
function genId() {
  return 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const defaultState = { categories: [], tasks: [], attachments: [], expenses: [], drafts: [] };
let state = loadState();
let settings = loadSettings();
let usage = loadUsage();
let cloudState = loadCloudState();
// Files staged in the input card, awaiting 整理:
let pendingFiles = [];       // [{ ref, name, type, size, blob }] from 📎 附加檔案 (kept as attachments)
let attachedPdf = null;      // { ref, name, type, size, blob, text } from 📄 上傳 PDF (text-extracted; kept only if user confirms)
let pendingFocus = null;     // category index whose newly-added item should get focus

/* ---------------- Attachment blob store (IndexedDB) ---------------- */
// localStorage can't hold binary; blobs are cached here keyed by attachment id.
// On another device an attachment's blob is fetched from Drive on first open.
let _idbPromise = null;
function idb() {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('smart_notebook_files', 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('blobs')) req.result.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _idbPromise;
}
async function idbTx(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', mode);
    const store = tx.objectStore('blobs');
    let out;
    const r = fn(store);
    if (r) r.onsuccess = () => { out = r.result; };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
const idbPutBlob = (id, blob) => idbTx('readwrite', (s) => s.put(blob, id));
const idbGetBlob = (id) => idbTx('readonly', (s) => s.get(id));
const idbDelBlob = (id) => idbTx('readwrite', (s) => s.delete(id));
const idbClearBlobs = () => idbTx('readwrite', (s) => s.clear());

// Cloud runtime (in-memory only)
let gisToken = null;      // access token, never persisted
let tokenClient = null;   // GIS token client
let cloudTimer = null;    // debounce handle for auto-backup
let suppressCloud = false; // true while applying a restore, to avoid backup loop

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(defaultState);
    const parsed = JSON.parse(raw);
    return normalizeState({
      categories: Array.isArray(parsed.categories) ? parsed.categories : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
      expenses: Array.isArray(parsed.expenses) ? parsed.expenses : [],
      drafts: Array.isArray(parsed.drafts) ? parsed.drafts : [],
    });
  } catch (e) {
    return structuredClone(defaultState);
  }
}

// Bring any stored/loaded/restored state up to the current shape:
//  - bullets: plain string  → { id, text }
//  - tasks:   linkedBullets (text) → linkedItemIds (bullet ids), matched by text
//  - attachments: array of { id, name, type, size, driveFileId, addedAt, linkedItemIds }
// Idempotent, so it's safe to run on load and after a cloud restore.
function normalizeState(s) {
  const textToIds = new Map(); // bullet text → queue of ids (for task migration)
  const cats = Array.isArray(s.categories) ? s.categories : [];
  for (const c of cats) {
    c.subsections = Array.isArray(c.subsections) ? c.subsections : [];
    for (const sub of c.subsections) {
      sub.bullets = (Array.isArray(sub.bullets) ? sub.bullets : []).map((b) => {
        const bullet = (typeof b === 'string')
          ? { id: genId(), text: b }
          : { id: b && b.id ? b.id : genId(), text: b && typeof b.text === 'string' ? b.text : '' };
        if (!textToIds.has(bullet.text)) textToIds.set(bullet.text, []);
        textToIds.get(bullet.text).push(bullet.id);
        return bullet;
      });
    }
  }
  const takeIdForText = (t) => {
    const q = textToIds.get(t);
    return q && q.length ? q[0] : null; // first match; don't consume (a text may map several tasks)
  };
  const tasks = (Array.isArray(s.tasks) ? s.tasks : []).map((t) => {
    let linkedItemIds = Array.isArray(t.linkedItemIds) ? t.linkedItemIds.filter((x) => typeof x === 'string') : null;
    if (!linkedItemIds) {
      // migrate from old text-based linkedBullets
      linkedItemIds = [];
      for (const bt of (Array.isArray(t.linkedBullets) ? t.linkedBullets : [])) {
        const id = takeIdForText(bt);
        if (id) linkedItemIds.push(id);
      }
    }
    return {
      id: t.id || ('tk_' + genId()),
      task: t.task || '',
      dueDate: t.dueDate || '',
      importance: ['high', 'medium', 'low'].includes(t.importance) ? t.importance : 'medium',
      sourceCategory: t.sourceCategory || '',
      linkedItemIds,
      done: !!t.done,
      ...(['urgent', 'normal', 'low'].includes(t.priorityOverride) ? { priorityOverride: t.priorityOverride } : {}),
      ...(t.completedAt ? { completedAt: t.completedAt } : {}),
    };
  });
  const attachments = (Array.isArray(s.attachments) ? s.attachments : []).map((a) => ({
    id: a.id || genId(),
    name: a.name || '附件',
    type: a.type || '',
    size: a.size || 0,
    driveFileId: a.driveFileId || '',
    addedAt: a.addedAt || '',
    linkedItemIds: Array.isArray(a.linkedItemIds) ? a.linkedItemIds.filter((x) => typeof x === 'string') : [],
  }));
  // Expenses: consumption records pulled out of the notes by Claude. They live
  // here (not in categories), and only surface in the 記帳 view.
  const expenses = (Array.isArray(s.expenses) ? s.expenses : []).map((e) => {
    const amount = Number(e.amount);
    return {
      id: e.id || ('ex_' + genId()),
      item: typeof e.item === 'string' ? e.item : '',
      amount: isFinite(amount) ? amount : 0,
      date: /^\d{4}-\d{2}-\d{2}$/.test(e.date || '') ? e.date : '',
      category: (typeof e.category === 'string' && e.category.trim()) ? e.category.trim() : '其他',
      createdAt: e.createdAt || '',
    };
  });
  // Drafts: text (and optionally files) stashed locally in the input card, not
  // yet sent to Claude. Device-local scratch — kept out of the cloud bundle on
  // purpose. Each draft's file blobs live in IndexedDB keyed by the file ref;
  // here we only keep the lightweight metadata.
  const drafts = (Array.isArray(s.drafts) ? s.drafts : [])
    .map((d) => ({
      id: d.id || ('df_' + genId()),
      text: typeof d.text === 'string' ? d.text : '',
      createdAt: d.createdAt || '',
      files: (Array.isArray(d.files) ? d.files : []).map((f) => ({
        ref: f.ref || ('a' + genId()),
        name: f.name || '附件',
        type: f.type || '',
        size: f.size || 0,
        isPdf: !!f.isPdf,
        pdfText: typeof f.pdfText === 'string' ? f.pdfText : '',
      })),
    }))
    .filter((d) => d.text.trim() !== '' || d.files.length > 0);
  return { categories: cats, tasks, attachments, expenses, drafts };
}
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  scheduleCloudBackup();
}
// Persist without scheduling a cloud backup — used after filling in attachment
// driveFileIds during a backup, so we don't retrigger the backup loop.
function saveStateQuiet() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
function loadSettings() {
  let s;
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { s = {}; }
  return {
    apiKey: s.apiKey || '',
    model: s.model || 'claude-opus-4-8',
    autoDeleteDays: s.autoDeleteDays || 'never', // 'never' | '1' | '3' | '7' | '14' | '30'
    workerUrl: s.workerUrl || '',   // optional Cloudflare Worker relay endpoint
    accessCode: s.accessCode || '', // shared access code the relay checks
  };
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
// Local, per-device tally of tokens used through this app, accumulated from the
// `usage` field of each Claude response. It is a this-device estimate only — the
// authoritative billing/total lives in the Anthropic console.
function loadUsage() {
  let u;
  try { u = JSON.parse(localStorage.getItem(USAGE_KEY)) || {}; } catch (e) { u = {}; }
  return {
    calls: u.calls || 0,
    inputTokens: u.inputTokens || 0,
    outputTokens: u.outputTokens || 0,
    since: u.since || '',
  };
}
function saveUsage() {
  localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
}
function recordUsage(u) {
  if (!u) return;
  if (!usage.since) usage.since = todayStr();
  usage.calls += 1;
  usage.inputTokens +=
    (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  usage.outputTokens += u.output_tokens || 0;
  saveUsage();
}
function loadCloudState() {
  let c;
  try { c = JSON.parse(localStorage.getItem(CLOUD_KEY)) || {}; } catch (e) { c = {}; }
  return {
    enabled: !!c.enabled,
    fileId: c.fileId || '',
    lastSyncedAt: c.lastSyncedAt || '', // ISO of the bundle we last uploaded/restored
    email: c.email || '',
    deviceId: c.deviceId || 'dev_' + Math.random().toString(36).slice(2, 10),
    pendingBackup: !!c.pendingBackup,
    backupFailed: !!c.backupFailed,
  };
}
function saveCloudState() {
  localStorage.setItem(CLOUD_KEY, JSON.stringify(cloudState));
}

/* ---------------- Elements ---------------- */
const $ = (id) => document.getElementById(id);
const els = {
  inputText: $('inputText'),
  micBtn: $('micBtn'),
  micHint: $('micHint'),
  pdfInput: $('pdfInput'),
  attachInput: $('attachInput'),
  pendingAttach: $('pendingAttach'),
  processBtn: $('processBtn'),
  stashBtn: $('stashBtn'),
  draftsBox: $('draftsBox'),
  draftsList: $('draftsList'),
  draftsCount: $('draftsCount'),
  emptyHint: $('emptyHint'),
  tasksSection: $('tasksSection'),
  tasksList: $('tasksList'),
  categoriesSection: $('categoriesSection'),
  categoriesList: $('categoriesList'),
  clearBtn: $('clearBtn'),
  expenseHintBtn: $('expenseHintBtn'),
  expenseBtn: $('expenseBtn'),
  expenseModal: $('expenseModal'),
  closeExpenseBtn: $('closeExpenseBtn'),
  expStartDate: $('expStartDate'),
  expStartClear: $('expStartClear'),
  expRangeNote: $('expRangeNote'),
  expTotal: $('expTotal'),
  expCount: $('expCount'),
  expByCat: $('expByCat'),
  expByMonth: $('expByMonth'),
  expList: $('expList'),
  expEmpty: $('expEmpty'),
  expDoneBtn: $('expDoneBtn'),
  settingsBtn: $('settingsBtn'),
  settingsModal: $('settingsModal'),
  closeSettingsBtn: $('closeSettingsBtn'),
  saveSettingsBtn: $('saveSettingsBtn'),
  apiKeyInput: $('apiKeyInput'),
  workerUrlInput: $('workerUrlInput'),
  accessCodeInput: $('accessCodeInput'),
  modelSelect: $('modelSelect'),
  autoDeleteSelect: $('autoDeleteSelect'),
  usageCalls: $('usageCalls'),
  usageIn: $('usageIn'),
  usageOut: $('usageOut'),
  usageSince: $('usageSince'),
  usageResetBtn: $('usageResetBtn'),
  cloudSection: $('cloudSection'),
  cloudDisconnected: $('cloudDisconnected'),
  cloudConnected: $('cloudConnected'),
  cloudStatus: $('cloudStatus'),
  cloudConnectBtn: $('cloudConnectBtn'),
  cloudBackupBtn: $('cloudBackupBtn'),
  cloudRestoreBtn: $('cloudRestoreBtn'),
  cloudSwitchBtn: $('cloudSwitchBtn'),
  cloudDisconnectBtn: $('cloudDisconnectBtn'),
  loadingOverlay: $('loadingOverlay'),
  loadingText: $('loadingText'),
  toast: $('toast'),
};

/* ---------------- Toast ---------------- */
let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
}

/* ---------------- PDF extraction ---------------- */
async function extractPdfText(file) {
  if (!window.pdfjsLib) throw new Error('PDF 元件尚未載入，請檢查網路連線。');
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(' ') + '\n';
  }
  return text.trim();
}

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
function fileIcon(type, name) {
  const t = (type || '').toLowerCase();
  const n = (name || '').toLowerCase();
  if (t.startsWith('image/')) return '🖼';
  if (t === 'application/pdf' || n.endsWith('.pdf')) return '📄';
  if (t.includes('word') || /\.docx?$/.test(n)) return '📝';
  if (t.includes('sheet') || t.includes('excel') || /\.xlsx?$|\.csv$/.test(n)) return '📊';
  return '📎';
}

// 📎 附加檔案 — any file type, kept as an attachment (not used as text input).
// Guarded so a stale-cache mismatch (e.g. old index.html + new app.js during a
// PWA update) can't throw here and halt the rest of the init.
if (els.attachInput) els.attachInput.addEventListener('change', (e) => {
  for (const file of e.target.files) {
    if (file.size > MAX_ATTACH_BYTES) {
      toast(`「${file.name}」超過 10MB，無法附加。`);
      continue;
    }
    pendingFiles.push({
      ref: 'a' + genId(),
      name: file.name,
      type: file.type || '',
      size: file.size,
      blob: file,
    });
  }
  els.attachInput.value = '';
  renderPending();
});

// 📄 上傳 PDF — text is extracted and fed to Claude. The file itself is kept
// only if the user confirms after 整理 (per the "keep this document?" rule).
if (els.pdfInput) els.pdfInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  els.pdfInput.value = '';
  if (!file) return;
  attachedPdf = { ref: 'a' + genId(), name: file.name, type: file.type || 'application/pdf', size: file.size, blob: file, text: '', reading: true };
  renderPending();
  try {
    attachedPdf.text = await extractPdfText(file);
    attachedPdf.reading = false;
    if (!attachedPdf.text) toast('這份 PDF 抽不到文字（可能是掃描圖檔）。');
  } catch (err) {
    attachedPdf = null;
    toast('PDF 讀取失敗：' + err.message);
  }
  renderPending();
});

function clearPending() {
  pendingFiles = [];
  attachedPdf = null;
  renderPending();
}

function renderPending() {
  if (!els.pendingAttach) return; // tolerate a stale/mismatched HTML
  const chips = [];
  if (attachedPdf) {
    const note = attachedPdf.reading ? '讀取中…' : `${attachedPdf.text.length} 字，作為文字輸入`;
    chips.push({ kind: 'pdf', ref: attachedPdf.ref, label: `${fileIcon(attachedPdf.type, attachedPdf.name)} ${attachedPdf.name}（${note}）` });
  }
  for (const f of pendingFiles) {
    chips.push({ kind: 'file', ref: f.ref, label: `${fileIcon(f.type, f.name)} ${f.name}（${fmtSize(f.size)}）` });
  }
  els.pendingAttach.innerHTML = '';
  els.pendingAttach.hidden = chips.length === 0;
  for (const c of chips) {
    const chip = document.createElement('span');
    chip.className = 'attach-chip';
    const label = document.createElement('span');
    label.className = 'attach-chip-label';
    label.textContent = c.label;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.title = '移除';
    rm.setAttribute('aria-label', '移除');
    rm.textContent = '✕';
    rm.addEventListener('click', () => {
      if (c.kind === 'pdf') attachedPdf = null;
      else pendingFiles = pendingFiles.filter((f) => f.ref !== c.ref);
      renderPending();
    });
    chip.appendChild(label);
    chip.appendChild(rm);
    els.pendingAttach.appendChild(chip);
  }
}

/* ---------------- Voice input (Web Speech API) ---------------- */
// Android Chrome supports SpeechRecognition natively. It requires a secure
// context (https / localhost) and sends audio to the browser vendor for
// transcription, so it needs an internet connection. Unsupported browsers
// (e.g. iOS Safari) simply keep the mic button hidden.
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let recognizing = false;   // true while the user wants recording to continue
let recordBase = '';       // textarea content captured when recording started
let recordFinal = '';      // finalized transcript accumulated this session

function initRecognition() {
  const r = new SpeechRec();
  r.lang = 'zh-TW';
  r.continuous = true;
  r.interimResults = true;

  r.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) recordFinal += res[0].transcript;
      else interim += res[0].transcript;
    }
    els.inputText.value = recordBase + recordFinal + interim;
    els.inputText.scrollTop = els.inputText.scrollHeight;
  };

  r.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      toast('麥克風權限被拒，請在瀏覽器允許麥克風後再試。');
      recognizing = false;
    } else if (e.error === 'no-speech' || e.error === 'aborted') {
      // benign — onend will restart while still recording, or just stop
    } else {
      toast('語音辨識錯誤：' + e.error);
    }
  };

  // Android Chrome ends a run every so often (or after silence). While the user
  // is still recording, restart to make it feel continuous; otherwise finalize.
  r.onend = () => {
    if (recognizing) {
      try { r.start(); return; } catch (_) { recognizing = false; }
    }
    updateMicUI(false);
  };

  return r;
}

function startRecording() {
  if (!recognition) recognition = initRecognition();
  const existing = els.inputText.value.replace(/\s+$/, '');
  recordBase = existing ? existing + '\n' : '';
  recordFinal = '';
  recognizing = true;
  try {
    recognition.start();
    updateMicUI(true);
  } catch (_) {
    // start() throws if a run is already active; treat as already recording
    updateMicUI(true);
  }
}

function stopRecording() {
  recognizing = false;
  if (recognition) { try { recognition.stop(); } catch (_) { /* ignore */ } }
  els.inputText.value = (recordBase + recordFinal).trimEnd();
  updateMicUI(false);
}

function toggleRecording() {
  if (recognizing) stopRecording();
  else startRecording();
}

function updateMicUI(on) {
  els.micBtn.classList.toggle('recording', on);
  els.micBtn.innerHTML = on ? '⏹ 停止' : '🎤 語音';
  els.micHint.hidden = !on;
}

if (SpeechRec) {
  els.micBtn.hidden = false;
  els.micBtn.addEventListener('click', toggleRecording);
}

/* ---------------- Claude API ---------------- */
// Claude works in text (bullets are plain strings in its I/O). The app owns the
// stable ids. When this batch carries attachments, we also ask Claude to return
// `attachmentLinks`, mapping each attachment ref → the exact bullet text(s) it
// belongs to, so the app can bind the file to that note item's id.
function buildSchema(hasAttachments) {
  const schema = {
    type: 'object',
    properties: {
      categories: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            subsections: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  heading: { type: 'string' },
                  bullets: { type: 'array', items: { type: 'string' } },
                },
                required: ['heading', 'bullets'],
                additionalProperties: false,
              },
            },
          },
          required: ['title', 'subsections'],
          additionalProperties: false,
        },
      },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            task: { type: 'string' },
            dueDate: { type: 'string' },
            importance: { type: 'string', enum: ['high', 'medium', 'low'] },
            sourceCategory: { type: 'string' },
            linkedBullets: { type: 'array', items: { type: 'string' } },
          },
          required: ['task', 'dueDate', 'importance', 'sourceCategory', 'linkedBullets'],
          additionalProperties: false,
        },
      },
      expenses: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            item: { type: 'string' },
            amount: { type: 'number' },
            date: { type: 'string' },
            category: { type: 'string' },
          },
          required: ['item', 'amount', 'date', 'category'],
          additionalProperties: false,
        },
      },
    },
    required: ['categories', 'tasks', 'expenses'],
    additionalProperties: false,
  };
  if (hasAttachments) {
    schema.properties.attachmentLinks = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          bulletTexts: { type: 'array', items: { type: 'string' } },
        },
        required: ['ref', 'bulletTexts'],
        additionalProperties: false,
      },
    };
    schema.required.push('attachmentLinks');
  }
  return schema;
}

const SYSTEM_PROMPT = [
  '你是一個上班族的記事本整理助理。使用者會提供零散的內容（打字、語音轉文字、或 PDF 文件文字）。',
  '你的工作：',
  '1. 把內容整理成「有邏輯層次的階層式標題與條列」。分類的類別（categories 的 title）由你自行決定，不需要問使用者。相近的內容歸到同一類，每一類底下用 subsections（子標題 heading + 條列 bullets）呈現。',
  '2. 從內容中找出「需要執行的任務」與「截止日期」，放進 tasks。dueDate 一律用 YYYY-MM-DD 格式；若內容沒有明確日期就留空字串。相對日期（例如「下週三」「月底前」）請依照使用者提供的今天日期換算成實際日期。',
  '   每個任務還要判斷 importance（重要性），值只能是 high / medium / low：依「任務本身的影響與後果」判斷——攸關考核／法規期限／對他人有重大影響＝high；例行、可有可無、影響很小＝low；其餘＝medium。importance 只看任務本身的份量，不要把「時間急不急」算進去（急迫程度由 App 依截止日另外計算）。',
  '3. 你會收到目前既有的分類（現有 categories 的 JSON）。請把新內容「合併」進去：能歸入既有類別就歸入，需要新類別就新增。',
  '重要：既有條列與子標題的文字請「原封不動保留」，不要改寫或刪除使用者既有的內容，只新增。回傳的 categories 必須是「合併後的完整結果」（包含既有的與新增的）。',
  '4. tasks 只回傳「這次新內容」中新發現的任務，不要重複回傳既有內容裡的任務。',
  '5. 每個任務要附上 linkedBullets：把 categories 裡「對應到這個任務的那幾條 bullets 文字」原封不動複製進來（通常就是你為這個任務所建立的那一條或幾條條列）。文字必須和 categories 裡的完全一致——之後任務完成刪除時會用它來一併清掉對應的條列。若某任務沒有對應的具體條列，linkedBullets 給空陣列 []。',
  '6. 消費／支出類的內容（例如買了東西、花了多少錢、付款、繳費、帳單、含金額的開銷）請「只」整理進 expenses，「不要」放進 categories 或 bullets，也「不要」為它建立「財務紀錄」「花費」之類的分類——這些消費紀錄會呈現在獨立的「記帳」介面，不放在首頁分類。每筆 expense 欄位：item＝品項或用途（簡短，例如「午餐便當」「加油」）；amount＝金額，只放阿拉伯數字（不含貨幣符號、不含逗號，台幣通常是整數）；date＝消費日期 YYYY-MM-DD（內容沒寫日期就用上面提供的今天日期）；category＝你判斷的消費分類，用繁體中文簡短詞（例如 餐飲／交通／購物／娛樂／居家／醫療／教育／其他）。',
  '7. expenses 只回傳「這次新內容」中的消費紀錄，不要重複既有的；若這次內容完全沒有消費，expenses 給空陣列 []。純粹記錄花費的內容通常不是待辦任務，不必再放進 tasks。',
  '全部用繁體中文。只輸出符合 schema 的 JSON。',
].join('\n');

// The app can reach Claude two ways:
//   A) direct  — the user's own API key in this browser (x-api-key → api.anthropic.com)
//   B) relay   — a Cloudflare Worker that holds the key server-side, so colleagues
//      only need the Worker URL + a shared access code (no personal API key).
// Relay mode is used whenever a Worker URL is set. The Worker forwards to Anthropic
// and returns Anthropic's response unchanged, so response parsing is identical.
function claudeEndpoint() {
  const relay = (settings.workerUrl || '').trim();
  if (relay) {
    return {
      relay: true,
      url: relay,
      headers: {
        'content-type': 'application/json',
        'x-app-access-code': (settings.accessCode || '').trim(),
      },
    };
  }
  return {
    relay: false,
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
  };
}

// Existing categories in text-only form (strip internal bullet ids) — Claude
// only ever sees/returns bullet text; the app re-attaches ids on merge.
function categoriesForClaude() {
  return state.categories.map((c) => ({
    title: c.title,
    subsections: (c.subsections || []).map((s) => ({
      heading: s.heading || '',
      bullets: (s.bullets || []).map((b) => (typeof b === 'string' ? b : b.text)),
    })),
  }));
}

async function callClaude(userInput, batchAttachments) {
  const ep = claudeEndpoint();
  if (!ep.relay && !settings.apiKey) {
    throw new Error('尚未設定 API 金鑰或中繼站，請點右上角 ⚙ 設定。');
  }
  const today = new Date().toISOString().slice(0, 10);
  const existing = JSON.stringify(categoriesForClaude());
  const hasAtt = Array.isArray(batchAttachments) && batchAttachments.length > 0;

  let userContent =
    `今天的日期是 ${today}。\n\n` +
    `目前既有的分類（JSON）：\n${existing}\n\n` +
    `以下是使用者這次新提供的內容，請合併整理並找出任務：\n"""\n${userInput}\n"""`;

  if (hasAtt) {
    const list = batchAttachments.map((a) => {
      let line = `- ref="${a.ref}"：檔名「${a.name}」`;
      const ctx = (a.context || '').trim();
      if (ctx) line += `，隨附於這段內容：「${ctx.slice(0, 200)}」`;
      return line;
    }).join('\n');
    userContent +=
      `\n\n使用者這次還附加了以下檔案（附件）：\n${list}\n` +
      '有標「隨附於這段內容」的附件，代表使用者是連同那段內容一起附上這個檔案的——' +
      '請把它對應到你「為那段內容所建立的 bullet」，不要對應到其他段內容的 bullet。' +
      '請在 attachmentLinks 回傳每個附件對應的 bulletTexts（放對應 bullet 的文字，需與 categories 裡完全一致）。' +
      '沒有標示隨附內容、或真的無法判斷時，才對應到這次新內容最主要的那一條 bullet。每個附件的 ref 都要出現在 attachmentLinks 中。';
  }

  const body = {
    model: settings.model || 'claude-opus-4-8',
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
    output_config: { format: { type: 'json_schema', schema: buildSchema(hasAtt) } },
  };

  const res = await fetch(ep.url, {
    method: 'POST',
    headers: ep.headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch (e) { /* ignore */ }
    if (ep.relay && (res.status === 401 || res.status === 403)) {
      throw new Error('中繼站拒絕：存取碼錯誤，或此網域未被中繼站允許。');
    }
    if (!ep.relay && res.status === 401) throw new Error('API 金鑰無效，請到設定重新確認。');
    if (res.status === 429) throw new Error('請求太頻繁或額度不足，請稍後再試。');
    const where = ep.relay ? '中繼站' : 'API';
    throw new Error(`${where}錯誤 ${res.status}${detail ? '：' + detail : ''}`);
  }

  const data = await res.json();
  recordUsage(data.usage);
  if (data.stop_reason === 'refusal') {
    throw new Error('Claude 拒絕處理這段內容。');
  }
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('未取得回應內容。');
  return JSON.parse(textBlock.text);
}

/* ---------------- Process flow ---------------- */
/* ---------------- Drafts (暫存) ---------------- */
// Stash the current textarea text locally without calling Claude. Drafts pile up
// in state.drafts; they're re-editable and deletable, and only get sent to Claude
// (all at once) when the user presses 整理 — cutting the number of API calls.
async function stashDraft() {
  if (recognizing) stopRecording();
  if (attachedPdf && attachedPdf.reading) { toast('PDF 還在讀取中，請稍候再暫存。'); return; }
  const text = els.inputText.value.trim();
  const hasFiles = pendingFiles.length > 0 || !!attachedPdf;
  if (!text && !hasFiles) { toast('沒有可暫存的內容。'); return; }

  // Snapshot the currently-staged files INTO this draft: persist each blob to
  // IndexedDB (keyed by its ref) so it survives a reload, and keep only metadata
  // on the draft. This binds each file to the draft it was stashed with.
  const files = [];
  try {
    for (const f of pendingFiles) {
      await idbPutBlob(f.ref, f.blob);
      files.push({ ref: f.ref, name: f.name, type: f.type || '', size: f.size || 0, isPdf: false, pdfText: '' });
    }
    if (attachedPdf) {
      await idbPutBlob(attachedPdf.ref, attachedPdf.blob);
      files.push({ ref: attachedPdf.ref, name: attachedPdf.name, type: attachedPdf.type || '', size: attachedPdf.size || 0, isPdf: true, pdfText: attachedPdf.text || '' });
    }
  } catch (e) { toast('檔案暫存失敗：' + e.message); return; }

  if (!Array.isArray(state.drafts)) state.drafts = [];
  state.drafts.push({ id: 'df_' + genId(), text, createdAt: todayStr(), files });
  saveState();
  els.inputText.value = '';
  clearPending();
  renderDrafts();
  toast('已暫存 ✓');
}

// Delete a draft and clean up any blobs its bound files hold in IndexedDB.
function removeDraft(id) {
  const d = (state.drafts || []).find((x) => x.id === id);
  if (d) for (const f of (d.files || [])) idbDelBlob(f.ref).catch(() => {});
  state.drafts = (state.drafts || []).filter((x) => x.id !== id);
  saveState();
  renderDrafts();
}

function renderDrafts() {
  if (!els.draftsBox) return; // tolerate a stale/mismatched HTML during PWA update
  const drafts = Array.isArray(state.drafts) ? state.drafts : [];
  els.draftsBox.hidden = drafts.length === 0;
  if (els.draftsCount) els.draftsCount.textContent = drafts.length ? `(${drafts.length})` : '';
  const list = els.draftsList;
  if (!list) return;
  list.innerHTML = '';
  drafts.forEach((d) => {
    const item = document.createElement('div');
    item.className = 'draft-item';

    const main = document.createElement('div');
    main.className = 'draft-main';

    const ta = document.createElement('textarea');
    ta.className = 'draft-text';
    ta.rows = 2;
    ta.value = d.text;
    ta.placeholder = (d.files && d.files.length) ? '（僅附件，可補充說明文字…）' : '';
    ta.addEventListener('blur', () => {
      const v = ta.value.trim();
      // Editing to empty removes the draft only if it also has no files.
      if (!v && (!d.files || d.files.length === 0)) { removeDraft(d.id); return; }
      if (v !== d.text) { d.text = v; saveState(); }
    });
    main.appendChild(ta);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'draft-del';
    del.textContent = '🗑';
    del.title = '刪除這則暫存（含其附件）';
    del.addEventListener('click', () => removeDraft(d.id));
    main.appendChild(del);

    item.appendChild(main);

    if (d.files && d.files.length) {
      const filesRow = document.createElement('div');
      filesRow.className = 'draft-files';
      for (const f of d.files) {
        const chip = document.createElement('span');
        chip.className = 'attach-chip';
        const label = document.createElement('span');
        label.className = 'attach-chip-label';
        label.textContent = `${fileIcon(f.type, f.name)} ${f.name}${f.size ? '（' + fmtSize(f.size) + '）' : ''}`;
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.title = '移除此附件';
        rm.setAttribute('aria-label', '移除');
        rm.textContent = '✕';
        rm.addEventListener('click', () => {
          idbDelBlob(f.ref).catch(() => {});
          d.files = d.files.filter((x) => x.ref !== f.ref);
          // A draft with neither text nor files is meaningless → drop it.
          if (!d.text.trim() && d.files.length === 0) { removeDraft(d.id); return; }
          saveState();
          renderDrafts();
        });
        chip.appendChild(label);
        chip.appendChild(rm);
        filesRow.appendChild(chip);
      }
      item.appendChild(filesRow);
    }

    list.appendChild(item);
  });
}

async function processInput() {
  if (recognizing) stopRecording();
  const typed = els.inputText.value.trim();
  const curPdfText = attachedPdf && attachedPdf.text ? attachedPdf.text : '';
  const drafts = Array.isArray(state.drafts) ? state.drafts : [];

  // --- Assemble the combined text (drafts first, then the current input). A
  // stashed PDF's extracted text belongs to its draft, so fold it in there. ---
  const textParts = [];
  for (const d of drafts) {
    const dPdf = (d.files || []).filter((f) => f.isPdf && f.pdfText).map((f) => f.pdfText).join('\n\n');
    const merged = [d.text.trim(), dPdf].filter(Boolean).join('\n\n');
    if (merged) textParts.push(merged);
  }
  const curText = [typed, curPdfText].filter(Boolean).join('\n\n');
  if (curText) textParts.push(curText);
  const combined = textParts.join('\n\n');

  // --- Assemble the file batch. Each file carries a `context` = the text it was
  // stashed alongside, so Claude links it to the right note (not just by name).
  // Draft files reference a blob in IndexedDB (fromDraft); current pending files
  // carry their blob in `src`. ---
  const batch = [];
  for (const d of drafts) {
    const ctx = d.text.trim();
    for (const f of (d.files || [])) {
      batch.push({ ref: f.ref, name: f.name, context: ctx, meta: f, isPdf: f.isPdf, fromDraft: true });
    }
  }
  for (const f of pendingFiles) batch.push({ ref: f.ref, name: f.name, context: typed, src: f });
  if (attachedPdf) batch.push({ ref: attachedPdf.ref, name: attachedPdf.name, context: typed, src: attachedPdf, isPdf: true });

  if (!combined && batch.length === 0) { toast('請先輸入文字，或附加檔案。'); return; }

  // Nothing for Claude to organize — just save the files to home bullets (no API
  // call, keeping usage down), then clear drafts and the input.
  if (!combined) {
    setLoading(true);
    try {
      for (const b of batch) {
        if (b.isPdf && !(await confirmKeepPdf(b.name))) { if (b.fromDraft) idbDelBlob(b.ref).catch(() => {}); continue; }
        const src = await resolveBatchSrc(b);
        if (!src || !src.blob) { if (b.fromDraft) idbDelBlob(b.ref).catch(() => {}); continue; }
        await createAttachment(src, [ensureHomeBullet(b.name)]);
        if (b.fromDraft) idbDelBlob(b.ref).catch(() => {});
      }
      state.drafts = [];
      saveState();
      render();
      els.inputText.value = '';
      clearPending();
      toast('已附加檔案 ✓');
    } catch (err) { toast(err.message); }
    finally { setLoading(false); }
    return;
  }

  setLoading(true);
  try {
    const preTexts = allBulletTexts(); // snapshot before merge → detect new bullets
    const result = await callClaude(combined, batch.map((b) => ({ ref: b.ref, name: b.name, context: b.context })));

    // categories: merge Claude's full set, preserving ids of unchanged bullets
    if (Array.isArray(result.categories)) {
      state.categories = mergeCategories(result.categories);
    }
    // tasks: append newly found (dedupe by task+dueDate), text links → id links
    if (Array.isArray(result.tasks)) appendTasks(result.tasks);
    // expenses: consumption records → 記帳 store (dedupe by item+amount+date)
    if (Array.isArray(result.expenses)) appendExpenses(result.expenses);

    // attachments: resolve Claude's ref→bulletTexts links, then save the files
    if (batch.length) {
      const linkMap = buildAttachmentLinkMap(result.attachmentLinks, preTexts, batch);
      await saveBatchAttachments(batch, linkMap);
    }

    state.drafts = []; // drafts were consumed by this 整理
    saveState();
    render();
    els.inputText.value = '';
    clearPending();
    toast('整理完成 ✓');
  } catch (err) {
    toast(err.message);
  } finally {
    setLoading(false);
  }
}

/* ---------------- Bullet / attachment linking helpers ---------------- */
function allBulletTexts() {
  const set = new Set();
  for (const c of state.categories) {
    for (const sub of c.subsections || []) {
      for (const b of sub.bullets || []) set.add(typeof b === 'string' ? b : b.text);
    }
  }
  return set;
}
function findBulletIdByText(text) {
  for (const c of state.categories) {
    for (const sub of c.subsections || []) {
      for (const b of sub.bullets || []) {
        if (b && b.text === text) return b.id;
      }
    }
  }
  return null;
}
function collectNewBulletIds(preTexts) {
  const ids = [];
  for (const c of state.categories) {
    for (const sub of c.subsections || []) {
      for (const b of sub.bullets || []) {
        if (b && !preTexts.has(b.text)) ids.push(b.id);
      }
    }
  }
  return ids;
}

// Turn Claude's text bullets back into { id, text }, reusing the id of any
// bullet whose text is unchanged (so tasks/attachments stay linked across
// merges) and minting a fresh id for genuinely new bullets.
function mergeCategories(returned) {
  const pool = new Map(); // text → queue of reusable ids
  for (const c of state.categories) {
    for (const sub of c.subsections || []) {
      for (const b of sub.bullets || []) {
        if (!b || !b.id) continue;
        if (!pool.has(b.text)) pool.set(b.text, []);
        pool.get(b.text).push(b.id);
      }
    }
  }
  return (Array.isArray(returned) ? returned : []).map((c) => ({
    title: c.title || '未命名分類',
    subsections: (Array.isArray(c.subsections) ? c.subsections : []).map((s) => ({
      heading: s.heading || '',
      bullets: (Array.isArray(s.bullets) ? s.bullets : []).map((bt) => {
        const text = typeof bt === 'string' ? bt : (bt && bt.text) || '';
        const q = pool.get(text);
        return { id: (q && q.length) ? q.shift() : genId(), text };
      }),
    })),
  }));
}

function appendTasks(tasks) {
  for (const t of tasks) {
    if (!t.task) continue;
    const dup = state.tasks.some(
      (x) => x.task === t.task && (x.dueDate || '') === (t.dueDate || '')
    );
    if (dup) continue;
    const linkedItemIds = [];
    for (const bt of (Array.isArray(t.linkedBullets) ? t.linkedBullets : [])) {
      const id = findBulletIdByText(bt);
      if (id && !linkedItemIds.includes(id)) linkedItemIds.push(id);
    }
    state.tasks.push({
      id: 'tk_' + genId(),
      task: t.task,
      dueDate: t.dueDate || '',
      importance: ['high', 'medium', 'low'].includes(t.importance) ? t.importance : 'medium',
      sourceCategory: t.sourceCategory || '',
      linkedItemIds,
      done: false,
    });
  }
}

// Consumption records Claude pulled out this batch. Append-only with dedupe by
// item+amount+date (Claude only returns the batch's new expenses), like tasks.
function appendExpenses(list) {
  for (const e of (Array.isArray(list) ? list : [])) {
    const item = (e && typeof e.item === 'string') ? e.item.trim() : '';
    const amount = Number(e && e.amount);
    if (!item || !isFinite(amount)) continue;
    const date = /^\d{4}-\d{2}-\d{2}$/.test((e && e.date) || '') ? e.date : todayStr();
    const category = (e && typeof e.category === 'string' && e.category.trim()) ? e.category.trim() : '其他';
    const dup = state.expenses.some((x) => x.item === item && x.amount === amount && x.date === date);
    if (dup) continue;
    state.expenses.push({ id: 'ex_' + genId(), item, amount, date, category, createdAt: todayStr() });
  }
}

// ref → [bulletId]. Uses Claude's bulletTexts where they resolve; otherwise
// falls back to every new bullet from this batch so a file is never orphaned.
function buildAttachmentLinkMap(attachmentLinks, preTexts, batch) {
  const map = new Map();
  const newIds = collectNewBulletIds(preTexts);
  for (const link of (Array.isArray(attachmentLinks) ? attachmentLinks : [])) {
    if (!link || !link.ref) continue;
    const ids = [];
    for (const bt of (Array.isArray(link.bulletTexts) ? link.bulletTexts : [])) {
      const id = findBulletIdByText(bt);
      if (id && !ids.includes(id)) ids.push(id);
    }
    map.set(link.ref, ids);
  }
  for (const b of batch) {
    const cur = map.get(b.ref);
    if (!cur || cur.length === 0) map.set(b.ref, newIds.slice());
  }
  return map;
}

// A visible home for a file we couldn't link to any note (e.g. a scanned PDF, or
// input that merged without producing a new bullet). Lives in a 📎 附件 category.
function ensureHomeBullet(name) {
  let cat = state.categories.find((c) => c.title === '📎 附件');
  if (!cat) { cat = { title: '📎 附件', subsections: [] }; state.categories.push(cat); }
  const sub = getGeneralSub(cat);
  const bullet = { id: genId(), text: name };
  sub.bullets.push(bullet);
  return bullet.id;
}

// Per the "keep this document?" rule: ask before retaining an uploaded PDF.
function confirmKeepPdf(name) {
  return confirm(`要保留這份 PDF「${name}」作為附件嗎？\n（內容已整理完成；保留可日後從對應的筆記／任務開啟原始檔）`);
}

// A batch item's blob source. Current pending files carry the blob directly;
// draft-bound files kept only metadata, so fetch the blob from IndexedDB (where
// it was persisted at stash time) by its ref.
async function resolveBatchSrc(b) {
  if (b.src && b.src.blob) return b.src;
  const blob = await idbGetBlob(b.ref);
  if (!blob) return null;
  const m = b.meta || {};
  return { blob, name: m.name || b.name, type: m.type || blob.type || '', size: m.size || blob.size || 0 };
}

async function saveBatchAttachments(batch, linkMap) {
  for (const b of batch) {
    if (b.isPdf && !confirmKeepPdf(b.name)) {
      if (b.fromDraft) idbDelBlob(b.ref).catch(() => {});
      continue;
    }
    const src = await resolveBatchSrc(b);
    if (!src || !src.blob) { if (b.fromDraft) idbDelBlob(b.ref).catch(() => {}); continue; }
    let linkedItemIds = (linkMap.get(b.ref) || []).slice();
    if (linkedItemIds.length === 0) linkedItemIds = [ensureHomeBullet(b.name)];
    await createAttachment(src, linkedItemIds);
    // The temp draft blob (keyed by ref) is now redundant — createAttachment
    // re-stored the blob under the attachment's own id.
    if (b.fromDraft) idbDelBlob(b.ref).catch(() => {});
  }
}

// Persist one file: blob → IndexedDB now; the debounced cloud backup (triggered
// by the caller's saveState) uploads the blob to Drive and fills in driveFileId.
// Metadata goes into state and rides along in the synced bundle.
async function createAttachment(src, linkedItemIds) {
  const id = genId();
  const blob = src.blob;
  await idbPutBlob(id, blob);
  const att = {
    id,
    name: src.name || '附件',
    type: src.type || (blob && blob.type) || '',
    size: src.size || (blob && blob.size) || 0,
    driveFileId: '',
    addedAt: new Date().toISOString(),
    linkedItemIds: linkedItemIds.slice(),
  };
  state.attachments.push(att);
  return att;
}

// Add file(s) to a task from its card. Attachments live on note items (bullets),
// so we link the file to the task's first linked bullet — that makes it show on
// the task and on that note. If the task has no linked bullet yet, give it a home
// bullet (in 📎 附件) and link the task to it, so the file always has a place.
async function addTaskAttachments(t, files) {
  setLoading(true);
  try {
    let targetId = (t.linkedItemIds && t.linkedItemIds[0]) || null;
    if (!targetId) {
      targetId = ensureHomeBullet(t.task || '任務附件');
      if (!Array.isArray(t.linkedItemIds)) t.linkedItemIds = [];
      t.linkedItemIds.push(targetId);
    }
    let added = 0;
    for (const file of files) {
      if (file.size > MAX_ATTACH_BYTES) { toast(`「${file.name}」超過 10MB，無法附加。`); continue; }
      await createAttachment({ blob: file, name: file.name, type: file.type || '', size: file.size }, [targetId]);
      added++;
    }
    if (added) {
      saveState();
      render();
      toast(added > 1 ? `已附加 ${added} 個檔案 ✓` : '已附加檔案 ✓');
    }
  } catch (err) {
    toast('附加失敗：' + err.message);
  } finally {
    setLoading(false);
  }
}

function setLoading(on) {
  els.loadingOverlay.hidden = !on;
  els.processBtn.disabled = on;
}

/* ---------------- Google Calendar link ---------------- */
function gcalLink(task) {
  const base = 'https://calendar.google.com/calendar/render?action=TEMPLATE';
  const params = new URLSearchParams();
  params.set('text', task.task);
  if (task.sourceCategory) params.set('details', '來自記事本分類：' + task.sourceCategory);
  if (task.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(task.dueDate)) {
    const d = task.dueDate.replace(/-/g, '');
    // All-day event on the due date. Google's all-day format needs END = next day
    // (exclusive). Add a day using local date parts to avoid a UTC roll-back.
    const [y, m, day] = task.dueDate.split('-').map(Number);
    const nx = new Date(y, m - 1, day + 1);
    const end =
      nx.getFullYear() +
      String(nx.getMonth() + 1).padStart(2, '0') +
      String(nx.getDate()).padStart(2, '0');
    params.set('dates', `${d}/${end}`);
  }
  return base + '&' + params.toString();
}

/* ---------------- Priority (importance × deadline) ---------------- */
// Recomputed on every render, so labels stay current relative to today's date
// without needing a fresh Claude call each time the app opens.
const TIER_META = {
  urgent: { label: '緊急', cls: 'pri-urgent', rank: 0 },
  normal: { label: '普通', cls: 'pri-normal', rank: 1 },
  low: { label: '可暫緩', cls: 'pri-low', rank: 2 },
};

function daysUntil(ymd) {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  const due = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / 86400000);
}

function priorityOf(task) {
  const impScore = { high: 3, medium: 2, low: 1 }[task.importance] || 2;
  const du = daysUntil(task.dueDate);
  let dueScore;
  if (du === null) dueScore = 0;         // no deadline
  else if (du <= 1) dueScore = 4;        // overdue, today, or tomorrow
  else if (du <= 3) dueScore = 3;
  else if (du <= 7) dueScore = 2;
  else if (du <= 14) dueScore = 1;
  else dueScore = 0;
  const total = impScore + dueScore;     // 1..7
  let auto;
  if (total >= 5) auto = 'urgent';
  else if (total >= 3) auto = 'normal';
  else auto = 'low';
  // A manual override (set by tapping the badge) wins over the auto tier. When
  // overridden the task no longer escalates as the deadline nears — that's the
  // point of a manual choice — until the user switches it back to 自動.
  const overridden = !!(task.priorityOverride && TIER_META[task.priorityOverride]);
  const tier = overridden ? task.priorityOverride : auto;
  return { tier, total, auto, overridden };
}

function dueSuffix(ymd) {
  const du = daysUntil(ymd);
  if (du === null) return '';
  if (du < 0) return '（已逾期）';
  if (du === 0) return '（今天）';
  if (du === 1) return '（明天）';
  return `（${du} 天後）`;
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* ---------------- Attachment lookups + delete cascade ---------------- */
function attachmentsForBullet(bulletId) {
  return state.attachments.filter((a) => (a.linkedItemIds || []).includes(bulletId));
}
function attachmentsForItems(itemIds) {
  if (!itemIds || !itemIds.length) return [];
  const set = new Set(itemIds);
  return state.attachments.filter((a) => (a.linkedItemIds || []).some((id) => set.has(id)));
}
// Bullets whose id isn't found in any category (can happen if a merge failed to
// preserve an id). Their attachments would otherwise be invisible, so we surface
// them in a fallback box rather than silently dropping the file.
function orphanAttachments() {
  const live = new Set();
  for (const c of state.categories)
    for (const sub of c.subsections || [])
      for (const b of sub.bullets || []) live.add(b.id);
  return state.attachments.filter((a) => !(a.linkedItemIds || []).some((id) => live.has(id)));
}

// Remove a file's local blob and (best-effort) its Drive copy.
function purgeAttachment(att) {
  idbDelBlob(att.id).catch(() => {});
  if (att.driveFileId && cloudState.enabled) driveDelete(att.driveFileId).catch(() => {});
}

// Remove note bullets by id and drop any attachment left with no surviving
// linked bullet. This is the cascade for explicit deletes (bullet ✕, category
// delete, completed-task delete). Callers saveState()+render() afterwards.
function categoryBulletCount(cat) {
  return (cat.subsections || []).reduce((n, s) => n + ((s.bullets && s.bullets.length) || 0), 0);
}

function removeBulletsByIds(ids) {
  if (!ids || !ids.length) return;
  const idSet = new Set(ids);
  const affected = new Set();
  for (const c of state.categories) {
    for (const sub of c.subsections || []) {
      const before = (sub.bullets || []).length;
      sub.bullets = (sub.bullets || []).filter((b) => !idSet.has(b.id));
      if (sub.bullets.length !== before) affected.add(c);
    }
    c.subsections = (c.subsections || []).filter((sub) => (sub.bullets || []).length > 0);
  }
  // Auto-remove a category whose last bullet was just deleted. Only categories we
  // actually removed a bullet from are considered — a freshly-created empty
  // category the user made to drag into is left untouched. Claude re-creates the
  // category by title (mergeCategories) if it later organizes content back in.
  if (affected.size) {
    state.categories = state.categories.filter((c) => !(affected.has(c) && categoryBulletCount(c) === 0));
  }
  const survivors = [];
  for (const att of state.attachments) {
    att.linkedItemIds = (att.linkedItemIds || []).filter((id) => !idSet.has(id));
    if (att.linkedItemIds.length === 0) purgeAttachment(att);
    else survivors.push(att);
  }
  state.attachments = survivors;
}

// Manual delete. For a completed task, also clear the linked note items (and
// their attachments). Confirms first since removing notes is irreversible;
// un-done tasks are deleted alone, leaving their notes (and files) intact.
function deleteTask(t) {
  const willClearNotes = t.done && (t.linkedItemIds || []).length > 0;
  if (willClearNotes) {
    const attCount = attachmentsForItems(t.linkedItemIds).length;
    const extra = attCount ? `\n（含 ${attCount} 個附加檔案，也會一併刪除）` : '';
    if (!confirm(`刪除已完成任務「${t.task}」？\n對應的分項筆記條列也會一併刪除。${extra}`)) return;
    removeBulletsByIds(t.linkedItemIds);
  }
  state.tasks = state.tasks.filter((x) => x.id !== t.id);
  saveState();
  render();
}

function pruneCompletedTasks() {
  const setting = settings.autoDeleteDays;
  if (!setting || setting === 'never') return;
  const days = Number(setting);
  if (!Number.isFinite(days)) return;
  let changed = false;
  const kept = [];
  for (const t of state.tasks) {
    if (t.done && t.completedAt) {
      const since = -(daysUntil(t.completedAt) ?? 0);
      if (since >= days) {
        removeBulletsByIds(t.linkedItemIds || []);
        changed = true;
        continue; // drop this task card
      }
    }
    kept.push(t);
  }
  if (changed) { state.tasks = kept; saveState(); }
}

/* ---------------- Rendering ---------------- */
function render() {
  const orphans = orphanAttachments();
  const expN = state.expenses.length;
  const hasContent = state.categories.length > 0 || state.tasks.length > 0 || orphans.length > 0 || expN > 0;
  els.emptyHint.hidden = hasContent;
  if (els.expenseHintBtn) {
    els.expenseHintBtn.hidden = expN === 0;
    els.expenseHintBtn.textContent = `💰 已記帳 ${expN} 筆消費 — 點此看統計與明細`;
  }
  renderDrafts();
  renderTasks();
  renderCategories(orphans);
}

/* ---------------- Attachment chip + open/download ---------------- */
function makeAttachChip(att, opts) {
  opts = opts || {};
  const chip = document.createElement('span');
  chip.className = 'attach-chip saved';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'attach-open';
  open.textContent = `${fileIcon(att.type, att.name)} ${att.name}`;
  open.title = '開啟附件';
  open.addEventListener('click', () => openAttachment(att));
  chip.appendChild(open);
  if (opts.removable) {
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'attach-rm';
    rm.textContent = '✕';
    rm.title = '刪除附件';
    rm.addEventListener('click', () => deleteAttachmentById(att.id));
    chip.appendChild(rm);
  }
  return chip;
}

function deleteAttachmentById(id) {
  const att = state.attachments.find((a) => a.id === id);
  if (!att) return;
  if (!confirm(`刪除附件「${att.name}」？此動作無法復原。`)) return;
  state.attachments = state.attachments.filter((a) => a.id !== id);
  purgeAttachment(att);
  saveState();
  render();
}

// Open the file. Prefer the local blob; if this device doesn't have it yet
// (e.g. it was added on another device), fetch it from Drive on demand.
async function openAttachment(att) {
  try {
    let blob = await idbGetBlob(att.id);
    if (!blob && att.driveFileId) {
      toast('從雲端下載附件…');
      blob = await driveDownloadBlob(att.driveFileId);
      if (blob) await idbPutBlob(att.id, blob);
    }
    if (!blob) { toast('找不到附件檔案（可能尚未同步到這台裝置）。'); return; }
    const typed = att.type ? new Blob([blob], { type: att.type }) : blob;
    const url = URL.createObjectURL(typed);
    const w = window.open(url, '_blank');
    if (!w) {
      const a = document.createElement('a');
      a.href = url; a.download = att.name;
      document.body.appendChild(a); a.click(); a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    toast('開啟附件失敗：' + (e.message || e));
  }
}

function renderTasks() {
  const pending = state.tasks;
  els.tasksSection.hidden = pending.length === 0;
  els.tasksList.innerHTML = '';

  // Sort: not-done first; then by priority tier (urgent→normal→low); within a
  // tier by combined score desc, then earliest due date.
  const withPri = pending.map((t) => ({ t, p: priorityOf(t) }));
  withPri.sort((a, b) => {
    if (a.t.done !== b.t.done) return a.t.done ? 1 : -1;
    const ra = TIER_META[a.p.tier].rank, rb = TIER_META[b.p.tier].rank;
    if (ra !== rb) return ra - rb;
    if (a.p.total !== b.p.total) return b.p.total - a.p.total;
    const da = a.t.dueDate || '9999-99-99', db = b.t.dueDate || '9999-99-99';
    return da.localeCompare(db);
  });

  for (const { t, p } of withPri) {
    const meta = TIER_META[p.tier];
    const item = document.createElement('div');
    item.className = 'task-item ' + meta.cls + (t.done ? ' done' : '');

    const check = document.createElement('div');
    check.className = 'task-check';
    check.textContent = t.done ? '✓' : '';
    check.addEventListener('click', () => {
      t.done = !t.done;
      if (t.done) t.completedAt = todayStr(); else delete t.completedAt;
      saveState();
      renderTasks();
    });

    const main = document.createElement('div');
    main.className = 'task-main';

    // Priority badge as a tap-to-change control. Options are the three tiers
    // plus 自動 (clears the override → back to date-based auto). The selected
    // value is the effective tier, so the badge always shows 緊急/普通/可暫緩.
    const badge = document.createElement('select');
    badge.className = 'pri-badge pri-select' + (p.overridden ? ' pri-manual' : '');
    badge.setAttribute('aria-label', '緊急程度，可點選變更');
    badge.title = p.overridden
      ? '緊急程度已手動設定；選「依日期自動」可改回自動判斷'
      : '點一下可手動變更緊急程度';
    for (const [val, label] of [['urgent', '緊急'], ['normal', '普通'], ['low', '可暫緩']]) {
      const o = document.createElement('option');
      o.value = val; o.textContent = label;
      badge.appendChild(o);
    }
    const autoOpt = document.createElement('option');
    autoOpt.value = 'auto';
    autoOpt.textContent = `🔄 依日期自動（${TIER_META[p.auto].label}）`;
    badge.appendChild(autoOpt);
    badge.value = p.tier;
    badge.addEventListener('change', () => {
      if (badge.value === 'auto') delete t.priorityOverride;
      else t.priorityOverride = badge.value;
      saveState();
      renderTasks(); // re-sort, recolour, refresh the 手動 marker
    });

    const badgeRow = document.createElement('div');
    badgeRow.className = 'pri-row';
    badgeRow.appendChild(badge);
    if (p.overridden) {
      const mk = document.createElement('span');
      mk.className = 'pri-manual-mark';
      mk.textContent = '✎ 手動';
      mk.title = '此任務的緊急程度為手動設定';
      badgeRow.appendChild(mk);
    }

    const text = document.createElement('div');
    text.className = 'task-text';
    text.textContent = t.task;

    const metaRow = document.createElement('div');
    metaRow.className = 'task-meta';
    if (t.dueDate) {
      const due = document.createElement('span');
      due.className = 'due-badge';
      due.textContent = '📅 ' + t.dueDate + dueSuffix(t.dueDate);
      metaRow.appendChild(due);
    }
    if (t.sourceCategory) {
      const cat = document.createElement('span');
      cat.textContent = t.sourceCategory;
      metaRow.appendChild(cat);
    }
    const cal = document.createElement('a');
    cal.className = 'cal-btn';
    cal.href = gcalLink(t);
    cal.target = '_blank';
    cal.rel = 'noopener';
    cal.textContent = '＋ 加入行事曆';
    metaRow.appendChild(cal);

    // Attach a file straight from the task card (kept as an attachment; text is
    // not extracted). Each card gets its own hidden input.
    const attachBtn = document.createElement('button');
    attachBtn.type = 'button';
    attachBtn.className = 'cal-btn task-attach-btn';
    attachBtn.textContent = '📎 附加檔案';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.hidden = true;
    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      fileInput.value = '';
      if (files.length) await addTaskAttachments(t, files);
    });
    metaRow.appendChild(attachBtn);
    metaRow.appendChild(fileInput);

    if (t.done && t.completedAt && settings.autoDeleteDays && settings.autoDeleteDays !== 'never') {
      const days = Number(settings.autoDeleteDays);
      const since = -(daysUntil(t.completedAt) ?? 0);
      const remain = Math.max(0, days - since);
      const info = document.createElement('span');
      info.className = 'autodel-note';
      info.textContent = remain <= 0 ? '🗑 即將自動刪除' : `🗑 ${remain} 天後自動刪除`;
      metaRow.appendChild(info);
    }

    main.appendChild(badgeRow);
    main.appendChild(text);
    main.appendChild(metaRow);

    // Attachments that belong to this task's note items — openable right here.
    const atts = attachmentsForItems(t.linkedItemIds);
    if (atts.length) {
      const attRow = document.createElement('div');
      attRow.className = 'attach-row';
      for (const a of atts) attRow.appendChild(makeAttachChip(a, { removable: true }));
      main.appendChild(attRow);
    }

    const del = document.createElement('button');
    del.className = 'task-del';
    del.textContent = '🗑';
    del.title = '刪除任務';
    del.addEventListener('click', () => deleteTask(t));

    item.appendChild(check);
    item.appendChild(main);
    item.appendChild(del);
    els.tasksList.appendChild(item);
  }
}

function renderCategories(orphans) {
  orphans = orphans || orphanAttachments();
  els.categoriesSection.hidden = state.categories.length === 0 && orphans.length === 0;
  els.categoriesList.innerHTML = '';

  state.categories.forEach((cat, ci) => {
    const card = document.createElement('div');
    card.className = 'category';
    card.dataset.ci = ci;

    const head = document.createElement('div');
    head.className = 'category-head';
    const title = document.createElement('input');
    title.className = 'category-title';
    title.value = cat.title || '未命名分類';
    title.addEventListener('change', () => {
      cat.title = title.value.trim() || '未命名分類';
      saveState();
    });
    const catDel = document.createElement('button');
    catDel.className = 'cat-del';
    catDel.textContent = '🗑';
    catDel.title = '刪除整個分類';
    catDel.addEventListener('click', () => {
      if (!confirm(`刪除分類「${cat.title}」？裡面的項目也會一併刪除。`)) return;
      state.categories.splice(ci, 1);
      saveState();
      render();
    });
    head.appendChild(title);
    head.appendChild(catDel);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'category-body';

    const subs = cat.subsections || [];
    const totalBullets = subs.reduce((n, s) => n + ((s.bullets && s.bullets.length) || 0), 0);
    if (totalBullets === 0) {
      const hint = document.createElement('div');
      hint.className = 'cat-empty-hint';
      hint.textContent = '把其他分類的項目拖曳到這裡，或按下方「＋ 新增項目」。';
      bodyEl.appendChild(hint);
    }

    subs.forEach((sub) => {
      if (!sub.bullets || sub.bullets.length === 0) return;
      const subEl = document.createElement('div');
      subEl.className = 'subsection';
      if (sub.heading) {
        const h = document.createElement('p');
        h.className = 'sub-heading';
        h.textContent = sub.heading;
        subEl.appendChild(h);
      }
      const ul = document.createElement('ul');
      ul.className = 'bullets';
      sub.bullets.forEach((b, bi) => {
        const li = document.createElement('li');
        li.className = 'bullet';

        const row = document.createElement('div');
        row.className = 'bullet-row';

        const handle = document.createElement('span');
        handle.className = 'drag-handle';
        handle.textContent = '⠿';
        handle.title = '按住拖曳到其他分類';
        handle.addEventListener('pointerdown', (e) => startBulletDrag(e, { cat, sub, bi, bulletId: b.id, text: b.text }));

        const span = document.createElement('span');
        span.className = 'bullet-text';
        span.contentEditable = 'true';
        span.textContent = b.text;
        span.addEventListener('blur', () => {
          const v = span.textContent.trim();
          if (v) { b.text = v; saveState(); }
          else { removeBulletsByIds([b.id]); saveState(); render(); }
        });

        const bDel = document.createElement('button');
        bDel.className = 'bullet-del';
        bDel.textContent = '✕';
        bDel.title = '刪除這一條';
        bDel.addEventListener('click', () => {
          const atts = attachmentsForBullet(b.id);
          if (atts.length && !confirm(`刪除這一條筆記？\n對應的 ${atts.length} 個附加檔案也會一併刪除。`)) return;
          removeBulletsByIds([b.id]);
          saveState();
          render();
        });

        row.appendChild(handle);
        row.appendChild(span);
        row.appendChild(bDel);
        li.appendChild(row);

        // Files attached to this note item.
        const atts = attachmentsForBullet(b.id);
        if (atts.length) {
          const attRow = document.createElement('div');
          attRow.className = 'attach-row bullet-attach';
          for (const a of atts) attRow.appendChild(makeAttachChip(a, { removable: true }));
          li.appendChild(attRow);
        }

        ul.appendChild(li);
      });
      subEl.appendChild(ul);
      bodyEl.appendChild(subEl);
    });

    const addItemBtn = document.createElement('button');
    addItemBtn.className = 'add-item-btn';
    addItemBtn.textContent = '＋ 新增項目';
    addItemBtn.addEventListener('click', () => addItem(cat));
    bodyEl.appendChild(addItemBtn);

    card.appendChild(head);
    card.appendChild(bodyEl);
    els.categoriesList.appendChild(card);
  });

  // Fallback: files whose linked note item no longer exists — keep them reachable.
  if (orphans.length) {
    const box = document.createElement('div');
    box.className = 'category orphan-attach';
    const head = document.createElement('div');
    head.className = 'category-head';
    const title = document.createElement('span');
    title.className = 'category-title';
    title.textContent = '📎 未對應的附件';
    head.appendChild(title);
    const bodyEl = document.createElement('div');
    bodyEl.className = 'category-body';
    const hint = document.createElement('div');
    hint.className = 'cat-empty-hint';
    hint.textContent = '這些檔案原本對應的筆記已不在，可在此開啟或刪除。';
    bodyEl.appendChild(hint);
    const attRow = document.createElement('div');
    attRow.className = 'attach-row';
    for (const a of orphans) attRow.appendChild(makeAttachChip(a, { removable: true }));
    bodyEl.appendChild(attRow);
    box.appendChild(head);
    box.appendChild(bodyEl);
    els.categoriesList.appendChild(box);
  }

  if (pendingFocus != null) {
    const card = els.categoriesList.querySelector(`.category[data-ci="${pendingFocus}"]`);
    if (card) {
      const texts = card.querySelectorAll('.bullet-text');
      const last = texts[texts.length - 1];
      if (last) { last.focus(); placeCaretEnd(last); }
    }
    pendingFocus = null;
  }
}

/* ---------------- Category editing helpers ---------------- */
// A "general" (heading-less) subsection is where manually-added and dragged-in
// items collect, kept separate from Claude's headed groupings.
function getGeneralSub(cat) {
  if (!cat.subsections) cat.subsections = [];
  let s = cat.subsections.find((x) => !x.heading);
  if (!s) { s = { heading: '', bullets: [] }; cat.subsections.push(s); }
  return s;
}
function cleanupEmptySub(cat, sub) {
  if (sub.bullets.length === 0) {
    const i = cat.subsections.indexOf(sub);
    if (i > -1) cat.subsections.splice(i, 1);
  }
}
function addItem(cat) {
  const s = getGeneralSub(cat);
  s.bullets.push({ id: genId(), text: '' });
  pendingFocus = state.categories.indexOf(cat);
  saveState();
  renderCategories();
}
function addCategory() {
  const cat = { title: '新分類', subsections: [] };
  state.categories.push(cat);
  saveState();
  render();
  const card = els.categoriesList.querySelector(`.category[data-ci="${state.categories.length - 1}"]`);
  if (card) {
    const t = card.querySelector('.category-title');
    if (t) { t.focus(); t.select(); }
  }
}
function placeCaretEnd(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

/* ---------------- Drag a bullet between categories ---------------- */
function startBulletDrag(e, src) {
  e.preventDefault();
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.textContent = src.text || '（空白項目）';
  document.body.appendChild(ghost);
  moveGhost(ghost, e.clientX, e.clientY);

  let target = null;
  const onMove = (ev) => {
    moveGhost(ghost, ev.clientX, ev.clientY);
    ghost.style.visibility = 'hidden';
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    ghost.style.visibility = '';
    const cat = el && el.closest ? el.closest('.category') : null;
    if (target && target !== cat) target.classList.remove('drop-target');
    target = cat;
    if (cat) cat.classList.add('drop-target');
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    ghost.remove();
    if (target) {
      target.classList.remove('drop-target');
      const targetCat = state.categories[+target.dataset.ci];
      if (targetCat) moveBullet(src, targetCat);
    }
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
}
function moveGhost(g, x, y) { g.style.left = x + 'px'; g.style.top = y + 'px'; }

function moveBullet(src, targetCat) {
  const tsub = getGeneralSub(targetCat);
  if (tsub === src.sub) return; // dropped back onto its own bucket — no-op
  const text = src.sub.bullets.splice(src.bi, 1)[0];
  if (text == null) { render(); return; }
  tsub.bullets.push(text);
  cleanupEmptySub(src.cat, src.sub);
  // If dragging the last bullet out emptied the source category, remove it (same
  // rule as deleting the last bullet). The target still holds the moved bullet.
  if (src.cat !== targetCat && categoryBulletCount(src.cat) === 0) {
    state.categories = state.categories.filter((c) => c !== src.cat);
  }
  saveState();
  render();
}

/* ---------------- Cloud sync (Google Drive appDataFolder) ---------------- */
// Backup-first, whole-bundle, last-write-wins — same proven model as the blood
// pressure app. Notes+tasks+attachment metadata are stored as one JSON file in
// the user's OWN Drive app-private folder (drive.appdata scope: can't see the
// user's other files); each attachment's binary is its own appDataFolder file.
// Only notes/tasks/attachments are synced — settings (API key / relay / model)
// stay local to each device.

function ensureGis() {
  return new Promise((resolve, reject) => {
    if (window.google && google.accounts && google.accounts.oauth2) return resolve();
    let s = document.getElementById('gis-script');
    if (s) { s.addEventListener('load', () => resolve()); s.addEventListener('error', () => reject(new Error('無法載入 Google 登入元件。'))); return; }
    s = document.createElement('script');
    s.id = 'gis-script';
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('無法載入 Google 登入元件（請檢查網路）。'));
    document.head.appendChild(s);
  });
}

// promptMode: '' for user-gesture connect (may show popup), 'none' for silent
// background refresh (fails quietly if there's no active Google session),
// 'select_account' to force the account chooser (used by 更換帳號).
//
// The GIS token client is created once, and its callback is fixed at init time.
// So the resolve/reject of the CURRENT call are held in module-scoped handlers
// that the single callback settles — otherwise every call after the first would
// hang (the callback would keep resolving the first, already-settled promise).
let tokenResolve = null;
let tokenReject = null;
function settleToken(fn, arg) {
  const r = fn === 'resolve' ? tokenResolve : tokenReject;
  tokenResolve = tokenReject = null;
  if (r) r(arg);
}
async function getAccessToken(promptMode) {
  if (!GOOGLE_CLIENT_ID) throw new Error('尚未設定 Google Client ID。');
  await ensureGis();
  return new Promise((resolve, reject) => {
    // A new request supersedes any in-flight one.
    if (tokenReject) { const rej = tokenReject; tokenResolve = tokenReject = null; rej(new Error('已被新的授權請求取代。')); }
    tokenResolve = resolve;
    tokenReject = reject;
    try {
      if (!tokenClient) {
        tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: DRIVE_SCOPE,
          callback: (resp) => {
            if (resp && resp.access_token) { gisToken = resp.access_token; settleToken('resolve', gisToken); }
            else settleToken('reject', new Error('未取得 Google 授權。'));
          },
          error_callback: (err) => settleToken('reject', new Error('Google 授權未完成' + (err && err.type ? '（' + err.type + '）' : '') + '。')),
        });
      }
      tokenClient.requestAccessToken({ prompt: promptMode || '' });
    } catch (e) { settleToken('reject', e); }
  });
}

async function driveFetch(url, opts, promptMode) {
  opts = opts || {};
  if (!gisToken) await getAccessToken(promptMode);
  const run = () => fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + gisToken } });
  let res = await run();
  if (res.status === 401) { // token expired → one silent refresh + retry
    gisToken = null;
    await getAccessToken('none');
    res = await run();
  }
  return res;
}

async function fetchUserEmail() {
  try {
    const res = await driveFetch('https://www.googleapis.com/oauth2/v3/userinfo', {});
    if (res.ok) return (await res.json()).email || '';
  } catch (e) { /* best-effort */ }
  return '';
}

async function driveFindFile(name, promptMode) {
  const q = encodeURIComponent(`name='${name}'`);
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,name,modifiedTime)&pageSize=10`;
  const res = await driveFetch(url, {}, promptMode);
  if (!res.ok) throw new Error('讀取雲端清單失敗（' + res.status + '）。');
  const data = await res.json();
  return (data.files && data.files[0]) || null;
}

async function driveDownload(fileId) {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {});
  if (!res.ok) throw new Error('下載雲端資料失敗（' + res.status + '）。');
  return res.json();
}

async function driveUpload(fileId, name, obj) {
  const metadata = fileId ? { name } : { name, parents: ['appDataFolder'] };
  const boundary = 'snb' + Math.random().toString(36).slice(2);
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
    JSON.stringify(obj) +
    `\r\n--${boundary}--`;
  const url = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=id`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`;
  const res = await driveFetch(url, {
    method: fileId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error('上傳雲端失敗（' + res.status + '）。');
  return res.json();
}

// Attachment binaries — each its own appDataFolder file. Binary is preserved by
// building the multipart body as a Blob (text parts + the raw file Blob).
async function driveUploadBlob(fileId, name, blob) {
  const metadata = fileId ? { name } : { name, parents: ['appDataFolder'] };
  const boundary = 'snbf' + Math.random().toString(36).slice(2);
  const pre =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`;
  const post = `\r\n--${boundary}--`;
  const url = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=id`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`;
  const res = await driveFetch(url, {
    method: fileId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: new Blob([pre, blob, post]),
  });
  if (!res.ok) throw new Error('上傳附件失敗（' + res.status + '）。');
  return res.json();
}

async function driveDownloadBlob(fileId) {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {});
  if (!res.ok) throw new Error('下載附件失敗（' + res.status + '）。');
  return res.blob();
}

async function driveDelete(fileId) {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error('刪除雲端附件失敗（' + res.status + '）。');
  return true;
}

// Upload one attachment's blob (from IndexedDB) to its own Drive file, recording
// driveFileId so other devices can fetch it. No-op if already uploaded or if
// there's no local blob (e.g. metadata that arrived from another device).
async function uploadAttachmentBlob(att) {
  if (!cloudState.enabled || att.driveFileId) return false;
  const blob = await idbGetBlob(att.id);
  if (!blob) return false;
  const saved = await driveUploadBlob('', 'att_' + att.id, blob);
  att.driveFileId = saved.id;
  return true;
}

// Push any attachments that have a local blob but no Drive copy yet.
async function uploadPendingAttachments() {
  if (!cloudState.enabled) return;
  let changed = false;
  for (const att of state.attachments) {
    if (!att.driveFileId) {
      try { if (await uploadAttachmentBlob(att)) changed = true; } catch (e) { /* retried next backup */ }
    }
  }
  if (changed) saveStateQuiet();
}

function buildBundle() {
  return {
    app: 'smart-notebook',
    v: 1,
    updatedAt: new Date().toISOString(),
    deviceId: cloudState.deviceId,
    data: { categories: state.categories, tasks: state.tasks, attachments: state.attachments, expenses: state.expenses },
  };
}

function applyBundle(b) {
  if (!b || !b.data) return;
  suppressCloud = true;
  state = normalizeState({
    categories: Array.isArray(b.data.categories) ? b.data.categories : [],
    tasks: Array.isArray(b.data.tasks) ? b.data.tasks : [],
    attachments: Array.isArray(b.data.attachments) ? b.data.attachments : [],
    expenses: Array.isArray(b.data.expenses) ? b.data.expenses : [],
  });
  saveState();
  pruneCompletedTasks();
  render();
  suppressCloud = false;
}

function scheduleCloudBackup() {
  if (!cloudState.enabled || suppressCloud) return;
  cloudState.pendingBackup = true;
  saveCloudState();
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(() => cloudBackupNow({}), 6000);
}

async function cloudBackupNow(opts) {
  opts = opts || {};
  if (!cloudState.enabled) return;
  setCloudBusy(true);
  try {
    await uploadPendingAttachments(); // push blobs first so driveFileIds land in the bundle
    const bundle = buildBundle();
    const saved = await driveUpload(cloudState.fileId, CLOUD_FILENAME, bundle);
    cloudState.fileId = saved.id;
    cloudState.lastSyncedAt = bundle.updatedAt;
    cloudState.pendingBackup = false;
    cloudState.backupFailed = false;
    saveCloudState();
    updateCloudUI();
    if (opts.manual) toast('已備份到雲端 ✓');
  } catch (e) {
    cloudState.backupFailed = true;
    saveCloudState();
    updateCloudUI();
    if (opts.manual) toast('備份失敗：' + e.message);
  } finally {
    setCloudBusy(false);
  }
}

async function cloudConnect() {
  if (!GOOGLE_CLIENT_ID) { toast('尚未設定 Google Client ID。'); return; }
  setCloudBusy(true);
  try {
    await getAccessToken(''); // user gesture — may show the Google popup
    const email = await fetchUserEmail();
    const remote = await driveFindFile(CLOUD_FILENAME);
    const localEmpty = state.categories.length === 0 && state.tasks.length === 0 && state.attachments.length === 0;

    cloudState.enabled = true;
    cloudState.email = email;

    if (remote) {
      const bundle = await driveDownload(remote.id);
      cloudState.fileId = remote.id;
      const useCloud =
        localEmpty ||
        confirm('雲端已有備份，這台裝置也有資料。\n要用「雲端版本」覆蓋這台嗎？\n（取消＝保留這台，並以本機為準上傳覆蓋雲端）');
      if (useCloud) {
        applyBundle(bundle);
        cloudState.lastSyncedAt = bundle.updatedAt || new Date().toISOString();
        cloudState.pendingBackup = false;
        cloudState.backupFailed = false;
        saveCloudState();
        toast('已連結，並從雲端還原 ✓');
      } else {
        saveCloudState();
        await cloudBackupNow({ manual: true });
      }
    } else {
      saveCloudState();
      await cloudBackupNow({ manual: true }); // first upload
      toast('已連結並建立雲端備份 ✓');
    }
    updateCloudUI();
  } catch (e) {
    toast('連結失敗：' + (e.message || e));
  } finally {
    setCloudBusy(false);
  }
}

async function cloudRestore() {
  if (!cloudState.enabled) return;
  setCloudBusy(true);
  try {
    const remote = await driveFindFile(CLOUD_FILENAME);
    if (!remote) { toast('雲端目前沒有備份。'); return; }
    const bundle = await driveDownload(remote.id);
    if (!confirm('用雲端版本覆蓋這台裝置目前的筆記與任務？此動作無法復原。')) return;
    applyBundle(bundle);
    cloudState.fileId = remote.id;
    cloudState.lastSyncedAt = bundle.updatedAt || new Date().toISOString();
    cloudState.pendingBackup = false;
    cloudState.backupFailed = false;
    saveCloudState();
    updateCloudUI();
    toast('已從雲端還原 ✓');
  } catch (e) {
    toast('還原失敗：' + e.message);
  } finally {
    setCloudBusy(false);
  }
}

function cloudDisconnect() {
  if (!confirm('解除與 Google 的連結？（雲端上的備份會保留，只是這台不再自動同步）')) return;
  cloudState.enabled = false;
  cloudState.fileId = '';
  cloudState.lastSyncedAt = '';
  cloudState.pendingBackup = false;
  cloudState.backupFailed = false;
  gisToken = null;
  saveCloudState();
  updateCloudUI();
  toast('已解除雲端連結（雲端資料保留）。');
}

// Wipe this device's notes/tasks/attachments (local only — no Drive files are
// touched). Persists quietly; the caller decides whether to back up afterwards.
async function clearAllLocalData() {
  state = structuredClone(defaultState);
  try { await idbClearBlobs(); } catch (e) { /* ignore */ }
  saveStateQuiet();
}

// 更換帳號: disconnect current account → clear local data → connect the chosen
// new account → restore from the new account's cloud (or stay empty if it has no
// backup). The old account's own cloud backup is left untouched. We obtain the
// new account's token FIRST (with the account chooser) so a cancelled sign-in
// leaves the current setup and data intact.
async function cloudSwitchAccount() {
  if (!GOOGLE_CLIENT_ID) { toast('尚未設定 Google Client ID。'); return; }
  if (!confirm(
    '更換帳號會依序：\n' +
    '1. 解除目前帳號的連結\n' +
    '2. 清除這台裝置目前的筆記、任務與附件\n' +
    '3. 登入你選擇的新帳號\n' +
    '4. 從新帳號雲端還原（新帳號若無備份則保持空白）\n\n' +
    '目前帳號的雲端備份會保留、不受影響。確定要繼續嗎？'
  )) return;

  setCloudBusy(true);
  try {
    // 1) Sign in to the NEW account first (force the account chooser).
    gisToken = null;
    await getAccessToken('select_account');
    const email = await fetchUserEmail();

    // 2) Disconnect the old account + wipe local data.
    clearTimeout(cloudTimer);
    cloudState.fileId = '';
    cloudState.lastSyncedAt = '';
    cloudState.pendingBackup = false;
    cloudState.backupFailed = false;
    await clearAllLocalData();

    // 3) Now connected to the new account.
    cloudState.enabled = true;
    cloudState.email = email;

    // 4) Restore from the new account's cloud, or stay empty.
    const remote = await driveFindFile(CLOUD_FILENAME);
    if (remote) {
      const bundle = await driveDownload(remote.id);
      cloudState.fileId = remote.id;
      applyBundle(bundle);
      cloudState.lastSyncedAt = bundle.updatedAt || new Date().toISOString();
      cloudState.pendingBackup = false;
      cloudState.backupFailed = false;
      saveCloudState();
      toast('已更換帳號並從雲端還原 ✓');
    } else {
      saveCloudState();
      render();
      await cloudBackupNow({}); // seed an (empty) backup file for the new account
      toast('已更換帳號（新帳號無雲端備份，保持空白）✓');
    }
    updateCloudUI();
  } catch (e) {
    // A failure can happen either before the wipe (sign-in cancelled → nothing
    // lost) or after (local cleared, new account connected). Reflect real state.
    saveCloudState();
    updateCloudUI();
    toast('更換帳號失敗：' + (e.message || e));
  } finally {
    setCloudBusy(false);
  }
}

// On open / return-to-foreground: if another device uploaded a newer bundle,
// prompt before overwriting this device. Silent token (no popup) — if there's no
// active Google session it just skips until the next manual action.
async function cloudCheckOnOpen() {
  if (!cloudState.enabled || !GOOGLE_CLIENT_ID) return;
  try {
    const remote = await driveFindFile(CLOUD_FILENAME, 'none');
    if (remote) {
      const bundle = await driveDownload(remote.id);
      cloudState.fileId = remote.id;
      const newer = bundle.updatedAt && (!cloudState.lastSyncedAt || new Date(bundle.updatedAt) > new Date(cloudState.lastSyncedAt));
      const fromOtherDevice = bundle.deviceId !== cloudState.deviceId;
      if (newer && fromOtherDevice) {
        if (confirm('雲端有更新的版本（可能來自其他裝置）。\n要用雲端版本覆蓋這台裝置嗎？')) {
          applyBundle(bundle);
          cloudState.lastSyncedAt = bundle.updatedAt;
          cloudState.pendingBackup = false;
          cloudState.backupFailed = false;
          saveCloudState();
          updateCloudUI();
          return;
        }
      }
    }
    if (cloudState.pendingBackup || cloudState.backupFailed) await cloudBackupNow({});
  } catch (e) { /* silent — no session / offline */ }
}

function fmtSyncTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function setCloudBusy(on) {
  [els.cloudConnectBtn, els.cloudBackupBtn, els.cloudRestoreBtn, els.cloudSwitchBtn, els.cloudDisconnectBtn].forEach((b) => {
    if (b) b.disabled = on;
  });
}

function updateCloudUI() {
  const configured = !!GOOGLE_CLIENT_ID;
  els.cloudSection.hidden = !configured;
  if (!configured) return;
  const on = cloudState.enabled;
  els.cloudDisconnected.hidden = on;
  els.cloudConnected.hidden = !on;
  els.cloudStatus.classList.remove('cloud-warn');
  if (on) {
    let s;
    if (cloudState.backupFailed) { s = '⚠ 有變更尚未成功備份，請按「立即備份」。'; els.cloudStatus.classList.add('cloud-warn'); }
    else if (cloudState.pendingBackup) s = '有變更待備份…';
    else if (cloudState.lastSyncedAt) s = '上次同步：' + fmtSyncTime(cloudState.lastSyncedAt);
    else s = '已連結。';
    if (cloudState.email) s += `\n帳號：${cloudState.email}`;
    els.cloudStatus.textContent = s;
  }
}

/* ---------------- 記帳 (bookkeeping) ---------------- */
// Start-date for the summary; '' = all records (the default).
let expStartFilter = '';

function fmtMoney(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return 'NT$' + v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// Records counted by the summary, honouring the start-date filter. Undated
// records are only included when no start date is set.
function expensesInRange() {
  if (!expStartFilter) return state.expenses.slice();
  return state.expenses.filter((e) => e.date && e.date >= expStartFilter);
}

function openExpenses() {
  els.expStartDate.value = expStartFilter;
  renderExpenses();
  els.expenseModal.hidden = false;
}
function closeExpenses() { els.expenseModal.hidden = true; }

function makeBarRow(name, amount, pct, barPct) {
  const row = document.createElement('div');
  row.className = 'exp-bar-row';
  const nameEl = document.createElement('span');
  nameEl.className = 'exp-bar-name';
  nameEl.textContent = name;
  const bar = document.createElement('div');
  bar.className = 'exp-bar';
  const fill = document.createElement('i');
  fill.style.width = Math.max(2, Math.round(barPct)) + '%';
  bar.appendChild(fill);
  const amt = document.createElement('span');
  amt.className = 'exp-bar-amt';
  amt.textContent = fmtMoney(amount) + (pct != null ? ` · ${Math.round(pct)}%` : '');
  row.appendChild(nameEl);
  row.appendChild(bar);
  row.appendChild(amt);
  return row;
}

function renderExpenses() {
  const all = state.expenses;
  const filtered = expensesInRange();
  const total = filtered.reduce((s, e) => s + (Number(e.amount) || 0), 0);

  els.expTotal.textContent = fmtMoney(total);
  els.expCount.textContent = String(filtered.length);
  els.expRangeNote.textContent = expStartFilter
    ? `統計 ${expStartFilter} 起，共 ${filtered.length} 筆`
    : `統計全部紀錄，共 ${filtered.length} 筆`;

  // Category breakdown (share of total)
  els.expByCat.innerHTML = '';
  els.expByMonth.innerHTML = '';
  if (filtered.length && total > 0) {
    const byCat = new Map();
    for (const e of filtered) byCat.set(e.category, (byCat.get(e.category) || 0) + (Number(e.amount) || 0));
    const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
    const catTitle = document.createElement('div');
    catTitle.className = 'exp-block-title';
    catTitle.textContent = '分類佔比';
    els.expByCat.appendChild(catTitle);
    for (const [name, amt] of cats) {
      els.expByCat.appendChild(makeBarRow(name, amt, (amt / total) * 100, (amt / cats[0][1]) * 100));
    }

    // Monthly trend (undated grouped under 未分月, shown last)
    const byMonth = new Map();
    for (const e of filtered) {
      const key = e.date ? e.date.slice(0, 7) : '未分月';
      byMonth.set(key, (byMonth.get(key) || 0) + (Number(e.amount) || 0));
    }
    const months = [...byMonth.entries()].sort((a, b) => {
      if (a[0] === '未分月') return 1;
      if (b[0] === '未分月') return -1;
      return a[0].localeCompare(b[0]);
    });
    const maxMonth = Math.max(...months.map((m) => m[1]));
    const monTitle = document.createElement('div');
    monTitle.className = 'exp-block-title';
    monTitle.textContent = '每月趨勢';
    els.expByMonth.appendChild(monTitle);
    for (const [name, amt] of months) {
      els.expByMonth.appendChild(makeBarRow(name, amt, null, (amt / maxMonth) * 100));
    }
  }

  // Detail list — newest first, each row editable + deletable
  els.expList.innerHTML = '';
  els.expEmpty.hidden = all.length !== 0;
  const rows = state.expenses.slice().sort((a, b) => {
    const da = a.date || '', db = b.date || '';
    if (da !== db) return db.localeCompare(da);
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });
  for (const e of rows) els.expList.appendChild(makeExpenseRow(e));
}

function makeExpenseRow(e) {
  const row = document.createElement('div');
  row.className = 'exp-row';

  const date = document.createElement('input');
  date.type = 'date';
  date.className = 'exp-date';
  date.value = e.date || '';
  date.addEventListener('change', () => {
    e.date = /^\d{4}-\d{2}-\d{2}$/.test(date.value) ? date.value : '';
    saveState();
    renderExpenses();
  });

  const item = document.createElement('input');
  item.type = 'text';
  item.className = 'exp-item';
  item.value = e.item;
  item.placeholder = '品項';
  item.addEventListener('change', () => {
    e.item = item.value.trim() || e.item;
    saveState();
  });

  const cat = document.createElement('input');
  cat.type = 'text';
  cat.className = 'exp-cat';
  cat.value = e.category;
  cat.placeholder = '分類';
  cat.addEventListener('change', () => {
    e.category = cat.value.trim() || '其他';
    saveState();
    renderExpenses();
  });

  const amount = document.createElement('input');
  amount.type = 'number';
  amount.className = 'exp-amount';
  amount.inputMode = 'decimal';
  amount.min = '0';
  amount.value = String(e.amount);
  amount.addEventListener('change', () => {
    const v = Number(amount.value);
    if (isFinite(v) && v >= 0) { e.amount = v; saveState(); }
    else { amount.value = String(e.amount); }
    renderExpenses();
  });

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'exp-del';
  del.textContent = '🗑';
  del.title = '刪除這筆';
  del.addEventListener('click', () => {
    state.expenses = state.expenses.filter((x) => x.id !== e.id);
    saveState();
    renderExpenses();
    render();
  });

  row.appendChild(date);
  row.appendChild(item);
  row.appendChild(cat);
  row.appendChild(amount);
  row.appendChild(del);
  return row;
}

els.expenseBtn.addEventListener('click', openExpenses);
els.expenseHintBtn.addEventListener('click', openExpenses);
els.closeExpenseBtn.addEventListener('click', closeExpenses);
els.expDoneBtn.addEventListener('click', closeExpenses);
els.expenseModal.addEventListener('click', (e) => {
  if (e.target === els.expenseModal) closeExpenses();
});
els.expStartDate.addEventListener('change', () => {
  expStartFilter = /^\d{4}-\d{2}-\d{2}$/.test(els.expStartDate.value) ? els.expStartDate.value : '';
  renderExpenses();
});
els.expStartClear.addEventListener('click', () => {
  expStartFilter = '';
  els.expStartDate.value = '';
  renderExpenses();
});

/* ---------------- Settings modal ---------------- */
function openSettings() {
  els.apiKeyInput.value = settings.apiKey || '';
  els.workerUrlInput.value = settings.workerUrl || '';
  els.accessCodeInput.value = settings.accessCode || '';
  els.modelSelect.value = settings.model || 'claude-opus-4-8';
  els.autoDeleteSelect.value = settings.autoDeleteDays || 'never';
  renderUsage();
  updateCloudUI();
  els.settingsModal.hidden = false;
}

function renderUsage() {
  const n = (x) => (x || 0).toLocaleString('en-US');
  els.usageCalls.textContent = n(usage.calls);
  els.usageIn.textContent = n(usage.inputTokens);
  els.usageOut.textContent = n(usage.outputTokens);
  els.usageSince.textContent = usage.since ? `統計自 ${usage.since}` : '尚無紀錄';
}
function closeSettings() { els.settingsModal.hidden = true; }

els.settingsBtn.addEventListener('click', openSettings);
els.closeSettingsBtn.addEventListener('click', closeSettings);
els.usageResetBtn.addEventListener('click', () => {
  if (!confirm('把這台裝置的用量統計歸零？（只清除本機計數，不影響官方帳單）')) return;
  usage = { calls: 0, inputTokens: 0, outputTokens: 0, since: '' };
  saveUsage();
  renderUsage();
  toast('用量統計已歸零');
});
els.settingsModal.addEventListener('click', (e) => {
  if (e.target === els.settingsModal) closeSettings();
});
els.saveSettingsBtn.addEventListener('click', () => {
  settings.apiKey = els.apiKeyInput.value.trim();
  settings.workerUrl = els.workerUrlInput.value.trim();
  settings.accessCode = els.accessCodeInput.value.trim();
  settings.model = els.modelSelect.value;
  settings.autoDeleteDays = els.autoDeleteSelect.value;
  saveSettings();
  closeSettings();
  pruneCompletedTasks();
  render();
  toast('設定已儲存');
});

/* ---------------- Cloud-sync wiring ---------------- */
if (els.cloudConnectBtn) els.cloudConnectBtn.addEventListener('click', cloudConnect);
if (els.cloudBackupBtn) els.cloudBackupBtn.addEventListener('click', () => cloudBackupNow({ manual: true }));
if (els.cloudRestoreBtn) els.cloudRestoreBtn.addEventListener('click', cloudRestore);
if (els.cloudSwitchBtn) els.cloudSwitchBtn.addEventListener('click', cloudSwitchAccount);
if (els.cloudDisconnectBtn) els.cloudDisconnectBtn.addEventListener('click', cloudDisconnect);

/* ---------------- Wire up ---------------- */
els.processBtn.addEventListener('click', processInput);
if (els.stashBtn) els.stashBtn.addEventListener('click', stashDraft);
$('addCatBtn').addEventListener('click', addCategory);
$('emptyAddCatBtn').addEventListener('click', addCategory);
els.clearBtn.addEventListener('click', () => {
  if (!confirm('清空所有分類與任務？此動作無法復原。')) return;
  state = structuredClone(defaultState);
  saveState();
  render();
});

const appVersionEl = $('appVersion');
if (appVersionEl) appVersionEl.textContent = APP_VERSION;

pruneCompletedTasks();
render();
cloudCheckOnOpen();

// Re-check when the app is reopened / brought back to the foreground, so cards
// that have aged past the threshold get cleaned up without a manual reload.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    pruneCompletedTasks();
    render();
    cloudCheckOnOpen();
  }
});

/* ---------------- Service worker ---------------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* ignore */ });
  });
}
