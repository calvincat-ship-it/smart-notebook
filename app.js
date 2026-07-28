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
const CLOUD_KEY = 'smart_notebook_cloud_v1';
const GOOGLE_CLIENT_ID = '682239566772-bl0vpkhi4hj1ih33gv6uheic2iqqojp6.apps.googleusercontent.com';
const DRIVE_SCOPE = 'openid email https://www.googleapis.com/auth/drive.appdata';
const CLOUD_FILENAME = 'notebook-backup.json';

const defaultState = { categories: [], tasks: [] };
let state = loadState();
let settings = loadSettings();
let usage = loadUsage();
let cloudState = loadCloudState();
let attachedPdfText = '';
let pendingFocus = null; // category index whose newly-added item should get focus

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
    return {
      categories: Array.isArray(parsed.categories) ? parsed.categories : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    };
  } catch (e) {
    return structuredClone(defaultState);
  }
}
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  scheduleCloudBackup();
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
  attachInfo: $('attachInfo'),
  processBtn: $('processBtn'),
  emptyHint: $('emptyHint'),
  tasksSection: $('tasksSection'),
  tasksList: $('tasksList'),
  categoriesSection: $('categoriesSection'),
  categoriesList: $('categoriesList'),
  clearBtn: $('clearBtn'),
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

els.pdfInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    els.attachInfo.hidden = false;
    els.attachInfo.innerHTML = '讀取 PDF…';
    attachedPdfText = await extractPdfText(file);
    els.attachInfo.innerHTML =
      `📄 ${file.name}（${attachedPdfText.length} 字）<button title="移除" aria-label="移除">✕</button>`;
    els.attachInfo.querySelector('button').addEventListener('click', clearAttachment);
    if (!attachedPdfText) toast('這份 PDF 抽不到文字（可能是掃描圖檔）。');
  } catch (err) {
    clearAttachment();
    toast('PDF 讀取失敗：' + err.message);
  }
  els.pdfInput.value = '';
});
function clearAttachment() {
  attachedPdfText = '';
  els.attachInfo.hidden = true;
  els.attachInfo.innerHTML = '';
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
const RESULT_SCHEMA = {
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
  },
  required: ['categories', 'tasks'],
  additionalProperties: false,
};

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

async function callClaude(userInput) {
  const ep = claudeEndpoint();
  if (!ep.relay && !settings.apiKey) {
    throw new Error('尚未設定 API 金鑰或中繼站，請點右上角 ⚙ 設定。');
  }
  const today = new Date().toISOString().slice(0, 10);
  const existing = JSON.stringify(state.categories);

  const userContent =
    `今天的日期是 ${today}。\n\n` +
    `目前既有的分類（JSON）：\n${existing}\n\n` +
    `以下是使用者這次新提供的內容，請合併整理並找出任務：\n"""\n${userInput}\n"""`;

  const body = {
    model: settings.model || 'claude-opus-4-8',
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
    output_config: { format: { type: 'json_schema', schema: RESULT_SCHEMA } },
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
async function processInput() {
  if (recognizing) stopRecording();
  const typed = els.inputText.value.trim();
  const combined = [typed, attachedPdfText].filter(Boolean).join('\n\n');
  if (!combined) { toast('請先輸入文字或附加 PDF。'); return; }

  setLoading(true);
  try {
    const result = await callClaude(combined);
    // categories: full merged set from Claude
    if (Array.isArray(result.categories)) {
      state.categories = result.categories;
    }
    // tasks: append newly found, dedupe by task+dueDate
    if (Array.isArray(result.tasks)) {
      for (const t of result.tasks) {
        if (!t.task) continue;
        const dup = state.tasks.some(
          (x) => x.task === t.task && (x.dueDate || '') === (t.dueDate || '')
        );
        if (!dup) {
          state.tasks.push({
            id: 'tk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
            task: t.task,
            dueDate: t.dueDate || '',
            importance: ['high', 'medium', 'low'].includes(t.importance) ? t.importance : 'medium',
            sourceCategory: t.sourceCategory || '',
            linkedBullets: Array.isArray(t.linkedBullets) ? t.linkedBullets.filter((x) => typeof x === 'string') : [],
            done: false,
          });
        }
      }
    }
    saveState();
    render();
    els.inputText.value = '';
    clearAttachment();
    toast('整理完成 ✓');
  } catch (err) {
    toast(err.message);
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
  let tier;
  if (total >= 5) tier = 'urgent';
  else if (total >= 3) tier = 'normal';
  else tier = 'low';
  return { tier, total };
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

/* ---------------- Auto-delete completed tasks + linked bullets ---------------- */
// Remove one bullet whose current text exactly matches `text`, preferring the
// task's source category. Exact match keeps this safe: if the user edited the
// bullet text, nothing is removed (rather than deleting the wrong note).
function removeBulletByText(text, preferCategory) {
  const order = [];
  if (preferCategory) {
    const pc = state.categories.find((c) => c.title === preferCategory);
    if (pc) order.push(pc);
  }
  for (const c of state.categories) if (!order.includes(c)) order.push(c);
  for (const c of order) {
    for (const sub of c.subsections || []) {
      const i = (sub.bullets || []).indexOf(text);
      if (i > -1) {
        sub.bullets.splice(i, 1);
        cleanupEmptySub(c, sub);
        return true;
      }
    }
  }
  return false;
}

// Manual delete. For a completed task, also clear the linked category bullets
// (same rule as auto-delete). Confirms first since removing notes is
// irreversible; un-done tasks are deleted alone, without touching notes.
function deleteTask(t) {
  const willClearNotes = t.done && (t.linkedBullets || []).length > 0;
  if (willClearNotes) {
    if (!confirm(`刪除已完成任務「${t.task}」？\n對應的分類筆記條列也會一併刪除。`)) return;
    (t.linkedBullets || []).forEach((bt) => removeBulletByText(bt, t.sourceCategory));
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
        (t.linkedBullets || []).forEach((bt) => removeBulletByText(bt, t.sourceCategory));
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
  const hasContent = state.categories.length > 0 || state.tasks.length > 0;
  els.emptyHint.hidden = hasContent;
  renderTasks();
  renderCategories();
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

    const badge = document.createElement('span');
    badge.className = 'pri-badge';
    badge.textContent = meta.label;

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

    if (t.done && t.completedAt && settings.autoDeleteDays && settings.autoDeleteDays !== 'never') {
      const days = Number(settings.autoDeleteDays);
      const since = -(daysUntil(t.completedAt) ?? 0);
      const remain = Math.max(0, days - since);
      const info = document.createElement('span');
      info.className = 'autodel-note';
      info.textContent = remain <= 0 ? '🗑 即將自動刪除' : `🗑 ${remain} 天後自動刪除`;
      metaRow.appendChild(info);
    }

    main.appendChild(badge);
    main.appendChild(text);
    main.appendChild(metaRow);

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

function renderCategories() {
  els.categoriesSection.hidden = state.categories.length === 0;
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

        const handle = document.createElement('span');
        handle.className = 'drag-handle';
        handle.textContent = '⠿';
        handle.title = '按住拖曳到其他分類';
        handle.addEventListener('pointerdown', (e) => startBulletDrag(e, { cat, sub, bi, text: b }));

        const span = document.createElement('span');
        span.className = 'bullet-text';
        span.contentEditable = 'true';
        span.textContent = b;
        span.addEventListener('blur', () => {
          const v = span.textContent.trim();
          if (v) { sub.bullets[bi] = v; }
          else { sub.bullets.splice(bi, 1); cleanupEmptySub(cat, sub); renderCategories(); }
          saveState();
        });

        const bDel = document.createElement('button');
        bDel.className = 'bullet-del';
        bDel.textContent = '✕';
        bDel.title = '刪除這一條';
        bDel.addEventListener('click', () => {
          sub.bullets.splice(bi, 1);
          cleanupEmptySub(cat, sub);
          saveState();
          renderCategories();
        });

        li.appendChild(handle);
        li.appendChild(span);
        li.appendChild(bDel);
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
  s.bullets.push('');
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
  saveState();
  render();
}

/* ---------------- Cloud sync (Google Drive appDataFolder) ---------------- */
// Backup-first, whole-bundle, last-write-wins — same proven model as the blood
// pressure app. Notes+tasks are stored as one JSON file in the user's OWN Drive
// app-private folder (drive.appdata scope: can't see the user's other files).
// Only the notes/tasks are synced — settings (API key / relay / model) stay local.

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
// background refresh (fails quietly if there's no active Google session).
async function getAccessToken(promptMode) {
  if (!GOOGLE_CLIENT_ID) throw new Error('尚未設定 Google Client ID。');
  await ensureGis();
  return new Promise((resolve, reject) => {
    try {
      if (!tokenClient) {
        tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: DRIVE_SCOPE,
          callback: (resp) => {
            if (resp && resp.access_token) { gisToken = resp.access_token; resolve(gisToken); }
            else reject(new Error('未取得 Google 授權。'));
          },
          error_callback: (err) => reject(new Error('Google 授權未完成' + (err && err.type ? '（' + err.type + '）' : '') + '。')),
        });
      }
      tokenClient.requestAccessToken({ prompt: promptMode || '' });
    } catch (e) { reject(e); }
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

function buildBundle() {
  return {
    app: 'smart-notebook',
    v: 1,
    updatedAt: new Date().toISOString(),
    deviceId: cloudState.deviceId,
    data: { categories: state.categories, tasks: state.tasks },
  };
}

function applyBundle(b) {
  if (!b || !b.data) return;
  suppressCloud = true;
  state = {
    categories: Array.isArray(b.data.categories) ? b.data.categories : [],
    tasks: Array.isArray(b.data.tasks) ? b.data.tasks : [],
  };
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
    const localEmpty = state.categories.length === 0 && state.tasks.length === 0;

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
  [els.cloudConnectBtn, els.cloudBackupBtn, els.cloudRestoreBtn, els.cloudDisconnectBtn].forEach((b) => {
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
if (els.cloudDisconnectBtn) els.cloudDisconnectBtn.addEventListener('click', cloudDisconnect);

/* ---------------- Wire up ---------------- */
els.processBtn.addEventListener('click', processInput);
$('addCatBtn').addEventListener('click', addCategory);
$('emptyAddCatBtn').addEventListener('click', addCategory);
els.clearBtn.addEventListener('click', () => {
  if (!confirm('清空所有分類與任務？此動作無法復原。')) return;
  state = structuredClone(defaultState);
  saveState();
  render();
});

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
