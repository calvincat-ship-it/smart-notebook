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
const APP_VERSION = 'v17.05';

const CLOUD_KEY = 'smart_notebook_cloud_v1';
const GOOGLE_CLIENT_ID = '682239566772-bl0vpkhi4hj1ih33gv6uheic2iqqojp6.apps.googleusercontent.com';
// drive.appdata = the app's private hidden folder (notes/tasks + small attachments).
// drive.file    = only files the app itself creates/opens in the user's visible
//                 Drive — used to upload big files there and get a shareable link.
//                 Adding this scope triggers a one-time Google re-consent prompt.
const DRIVE_SCOPE = 'openid email https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file';
// Calendar write scope — requested via its OWN token client (separate from Drive),
// only when the user turns on 「整理時自動加入行事曆」, so users who don't want it are
// never asked for calendar permission.
// openid+email so we can read back WHICH account the calendar token belongs to and
// show it in settings (the events land in that account's calendar, which may differ
// from the browser's default account used by the manual 「加入行事曆」 link).
const CALENDAR_SCOPE = 'openid email https://www.googleapis.com/auth/calendar.events';
const CLOUD_FILENAME = 'notebook-backup.json';

// Attachments: any file type, capped at 100MB each. The binary lives locally in
// IndexedDB and, when cloud sync is on, as its own file in the Drive
// appDataFolder (so the frequently-synced JSON bundle stays small). The bundle
// only carries lightweight metadata (id/name/type/size/driveFileId/link).
// In-app attachments (📎 附加、筆記本分類上傳、拍照、任務卡片附加) go to the app's
// private appDataFolder and are capped at 10MB — small, everyday files that sync
// seamlessly and ride along in the app's backup. Their local IndexedDB copy is a
// bounded LRU cache (see cache* below). Larger files (up to 100MB) take a
// separate path: the app uploads them to the user's OWN visible Drive with
// drive.file and stores just a link (see addCategoryBigFiles) — the user opts in
// to sharing, and the app doesn't have to babysit a 100MB transfer/backup.
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
const MAX_ATTACH_MB = Math.round(MAX_ATTACH_BYTES / 1024 / 1024);
// Big files that go to the user's visible Drive as a link.
const MAX_BIGFILE_BYTES = 100 * 1024 * 1024;
const MAX_BIGFILE_MB = Math.round(MAX_BIGFILE_BYTES / 1024 / 1024);
// OCR images are sent to Claude's vision API, which rejects very large images, so
// they keep a smaller, separate cap regardless of the attachment cap.
const MAX_OCR_BYTES = 10 * 1024 * 1024;

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
let ocrImages = [];          // [{ ref, name, type, size, blob }] from 🖼 圖片輸入 (sent to Claude's vision for OCR; kept only if user confirms)
const OCR_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']; // formats the Anthropic vision API accepts
// Collapse/expand UI state (session-only, not persisted). Categories default to
// collapsed; tasks of tier 普通/可暫緩 default to collapsed (緊急 always expanded).
const expandedCats = new WeakSet();  // category objects the user has expanded
const expandedTasks = new Set();     // task ids the user has expanded
let lowStackExpanded = false;        // whether the 可暫緩 stack is opened (session-only, starts collapsed)
let doneStackExpanded = false;       // whether the 已完成 stack is opened (session-only, starts collapsed)
const editingCats = new WeakSet();   // categories whose name is being edited (via ✏️)
let pendingEditCat = null;           // category to focus once it re-renders in edit mode
const editingBullets = new Set();    // bullet ids being edited (via ✒); otherwise shown as links
let pendingEditBullet = null;        // bullet id to focus once it re-renders in edit mode
const editingSubs = new Set();       // subcategory (子分類) ids whose title is being edited (via ✏️)
let pendingEditSub = null;           // subcategory id to focus once it re-renders in edit mode
const editingTasks = new Set();      // task ids whose card is open in edit mode (time + 說明事項)
let pendingDescFocusIdx = -1;        // index of a just-added 說明 row to focus after re-render
// Which sub-page is showing. 待辦任務 is the home page; 筆記本 is the other.
// Session-only (starts on tasks each open), like the other view-state above.
let currentPage = 'tasks';           // 'tasks' | 'notes'
// Fixed landing category for a task the user manually converts into a note.
const UNCAT_TITLE = '📥 未分類';

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

/* ---------------- Local attachment cache (LRU, bounded) ----------------
   Attachment binaries live in Drive; the IndexedDB copy is a cache so the same
   file need not be re-downloaded every open. It is bounded by a budget and
   evicts least-recently-used entries — but ONLY ones already safe in the cloud
   (a blob with no driveFileId yet is pinned so an unsynced file is never lost).
   Draft/staged file blobs are keyed by their own ref and are NOT tracked here,
   so they're never evicted. Access times + sizes live in a small localStorage
   map (a few hundred entries at most). */
const CACHE_META_KEY = 'smart_notebook_cache_v1';
const CACHE_BUDGET_CHOICES = { '200': 200, '500': 500, '1024': 1024, '2048': 2048, '4096': 4096, 'never': 0 };
let cacheMeta = loadCacheMeta(); // { [attId]: { size, at } }
function loadCacheMeta() {
  try { const o = JSON.parse(localStorage.getItem(CACHE_META_KEY) || '{}'); return (o && typeof o === 'object') ? o : {}; }
  catch (e) { return {}; }
}
function saveCacheMeta() {
  try { localStorage.setItem(CACHE_META_KEY, JSON.stringify(cacheMeta)); } catch (e) { /* quota — harmless */ }
}
function cacheBudgetBytes() {
  const mb = CACHE_BUDGET_CHOICES[settings.cacheBudgetMB] ?? 500;
  return mb > 0 ? mb * 1024 * 1024 : Infinity; // 'never' → unbounded (keep everything)
}
function cachedTotalBytes() {
  let n = 0;
  for (const k in cacheMeta) n += (cacheMeta[k] && cacheMeta[k].size) || 0;
  return n;
}
// Store an attachment blob locally + record it in the cache index, then trim.
async function cachePut(attId, blob) {
  await idbPutBlob(attId, blob);
  cacheMeta[attId] = { size: (blob && blob.size) || 0, at: Date.now() };
  saveCacheMeta();
  await enforceCacheBudget(attId);
}
// Read a cached attachment blob (and bump its recency).
async function cacheGet(attId) {
  const blob = await idbGetBlob(attId);
  if (blob) { cacheMeta[attId] = { size: blob.size, at: Date.now() }; saveCacheMeta(); }
  return blob;
}
async function cacheDelete(attId) {
  await idbDelBlob(attId).catch(() => {});
  if (cacheMeta[attId]) { delete cacheMeta[attId]; saveCacheMeta(); }
}
// Evict LRU cached blobs until under budget. Only evicts blobs that are safely in
// the cloud (attachment has a driveFileId) and never the one just touched.
async function enforceCacheBudget(keepId) {
  const budget = cacheBudgetBytes();
  if (!isFinite(budget)) return;
  let total = cachedTotalBytes();
  if (total <= budget) return;
  const safe = new Map(); // attId → driveFileId presence
  for (const a of state.attachments) safe.set(a.id, !!a.driveFileId);
  const entries = Object.keys(cacheMeta)
    .filter((id) => id !== keepId && safe.get(id)) // pin unsynced + just-used
    .map((id) => ({ id, at: cacheMeta[id].at || 0, size: cacheMeta[id].size || 0 }))
    .sort((a, b) => a.at - b.at); // oldest first
  for (const e of entries) {
    if (total <= budget) break;
    await cacheDelete(e.id);
    total -= e.size;
  }
}
// Drop every cached blob that is safely in the cloud (a manual "free up space").
// Unsynced blobs (no driveFileId) are kept so nothing unsaved is lost.
async function clearCloudBackedCache() {
  const safe = new Set(state.attachments.filter((a) => a.driveFileId).map((a) => a.id));
  let freed = 0;
  for (const id of Object.keys(cacheMeta)) {
    if (safe.has(id)) { freed += cacheMeta[id].size || 0; await cacheDelete(id); }
  }
  return freed;
}

// Cloud runtime (in-memory only)
let gisToken = null;      // access token, never persisted
let grantedScopes = '';   // space-delimited scopes actually granted by the last token
let tokenClient = null;   // GIS token client
let cloudTimer = null;    // debounce handle for auto-backup
let cloudPollTimer = null; // interval handle for auto pull/push while app is open
let cloudSyncing = false; // guard so overlapping auto-syncs don't run concurrently
let suppressCloud = false; // true while applying a restore, to avoid backup loop
const CLOUD_POLL_MS = 5 * 60 * 1000; // background poll cadence while open (5 min); foreground-return and the 🔄 button sync immediately, so this can be relaxed

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
    if (!c.id) c.id = 'cat_' + genId(); // stable id so files can be attached to a category
    c.subsections = Array.isArray(c.subsections) ? c.subsections : [];
    for (const sub of c.subsections) {
      if (!sub.id) sub.id = 'sub_' + genId(); // stable id so a 子分類 can be edited/expanded/converted
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
    // 說明事項 (description items) — a task's sub-points. Each { id, text }. Migrate
    // from an array of plain strings (or objects) written by earlier versions.
    const desc = (Array.isArray(t.desc) ? t.desc : []).map((d) => (
      typeof d === 'string'
        ? { id: genId(), text: d }
        : { id: (d && d.id) ? d.id : genId(), text: (d && typeof d.text === 'string') ? d.text : '' }
    )).filter((d) => d.text.trim() !== '');
    return {
      id: t.id || ('tk_' + genId()),
      task: t.task || '',
      dueDate: t.dueDate || '',
      importance: ['high', 'medium', 'low'].includes(t.importance) ? t.importance : 'medium',
      sourceCategory: t.sourceCategory || '',
      desc,
      linkedItemIds,
      done: !!t.done,
      ...(['urgent', 'normal', 'low'].includes(t.priorityOverride) ? { priorityOverride: t.priorityOverride } : {}),
      ...(t.completedAt ? { completedAt: t.completedAt } : {}),
      ...(t.calEventId ? { calEventId: t.calEventId } : {}), // Google Calendar event id (auto-added on 整理)
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
    // LINK attachments (a big file in the user's visible Drive): carry the extra
    // fields so they survive load/restore. Absent on normal appDataFolder files.
    ...(a.kind === 'link' ? { kind: 'link', url: a.url || '', shared: !!a.shared } : {}),
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
      // Source invoice number when this record came from a scanned 電子發票 QR;
      // used to avoid recording the same invoice twice. Absent for typed records.
      inv: (typeof e.inv === 'string' && e.inv) ? e.inv : undefined,
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
    cacheBudgetMB: s.cacheBudgetMB || '500', // local attachment-cache cap: '200'|'500'|'1024'|'2048'|'4096'|'never'
    autoAddCalendar: !!s.autoAddCalendar,   // auto-create Google Calendar events for new dated tasks on 整理
    calendarEmail: s.calendarEmail || '',   // which Google account the calendar events go to
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
    lastEditAt: c.lastEditAt || '',     // ISO of the most recent LOCAL data edit (for latest-wins)
    lastSeenModifiedTime: c.lastSeenModifiedTime || '', // Drive file modifiedTime we've already processed
    email: c.email || '',
    deviceId: c.deviceId || 'dev_' + Math.random().toString(36).slice(2, 10),
    pendingBackup: !!c.pendingBackup,
    backupFailed: !!c.backupFailed,
    uploadFolderId: c.uploadFolderId || '', // My Drive folder for big-file uploads (drive.file)
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
  ocrInput: $('ocrInput'),
  attachInput: $('attachInput'),
  pendingAttach: $('pendingAttach'),
  processBtn: $('processBtn'),
  addInputBtn: $('addInputBtn'),
  syncBtn: $('syncBtn'),
  inputModal: $('inputModal'),
  closeInputBtn: $('closeInputBtn'),
  attachHelpBtn: $('attachHelpBtn'),
  attachHelpModal: $('attachHelpModal'),
  closeAttachHelpBtn: $('closeAttachHelpBtn'),
  attachHelpDoneBtn: $('attachHelpDoneBtn'),
  helpBtn: $('helpBtn'),
  helpModal: $('helpModal'),
  closeHelpBtn: $('closeHelpBtn'),
  helpDoneBtn: $('helpDoneBtn'),
  stashBtn: $('stashBtn'),
  draftsBox: $('draftsBox'),
  draftsList: $('draftsList'),
  draftsCount: $('draftsCount'),
  emptyHint: $('emptyHint'),
  tabBar: $('tabBar'),
  tabTasks: $('tabTasks'),
  tabNotes: $('tabNotes'),
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
  invScanSection: $('invScanSection'),
  invScanBtn: $('invScanBtn'),
  invScanBox: $('invScanBox'),
  invVideo: $('invVideo'),
  invScanStatus: $('invScanStatus'),
  invScanDone: $('invScanDone'),
  invScanCancel: $('invScanCancel'),
  invResult: $('invResult'),
  settingsBtn: $('settingsBtn'),
  settingsModal: $('settingsModal'),
  closeSettingsBtn: $('closeSettingsBtn'),
  saveSettingsBtn: $('saveSettingsBtn'),
  apiKeyInput: $('apiKeyInput'),
  workerUrlInput: $('workerUrlInput'),
  accessCodeInput: $('accessCodeInput'),
  credGroup: $('credGroup'),
  credStatus: $('credStatus'),
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
  driveQuota: $('driveQuota'),
  cacheBudgetSelect: $('cacheBudgetSelect'),
  autoCalToggle: $('autoCalToggle'),
  calAccountNote: $('calAccountNote'),
  calTestBtn: $('calTestBtn'),
  cacheUsage: $('cacheUsage'),
  cacheClearBtn: $('cacheClearBtn'),
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
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
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
      toast(`「${file.name}」超過 ${MAX_ATTACH_MB}MB，無法附加。`);
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

// 🖼 圖片輸入 — images are sent to Claude's vision (OCR): it reads the text in the
// picture and organizes it with everything else. The image itself is kept as an
// attachment only if the user confirms after 整理 (like the PDF rule).
if (els.ocrInput) els.ocrInput.addEventListener('change', (e) => {
  for (const file of e.target.files) {
    const mt = (file.type || '').toLowerCase();
    if (!OCR_MEDIA_TYPES.includes(mt)) { toast(`「${file.name}」不是支援的圖片格式（請用 JPG／PNG／GIF／WebP）。`); continue; }
    if (file.size > MAX_OCR_BYTES) { toast(`「${file.name}」超過 10MB，無法辨識。`); continue; }
    ocrImages.push({ ref: 'o' + genId(), name: file.name, type: mt, size: file.size, blob: file });
  }
  els.ocrInput.value = '';
  renderPending();
});

// Read a blob as a bare base64 string (no data: prefix) for the vision API.
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); const i = s.indexOf(','); resolve(i >= 0 ? s.slice(i + 1) : s); };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function clearPending() {
  pendingFiles = [];
  attachedPdf = null;
  ocrImages = [];
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
  for (const g of ocrImages) {
    chips.push({ kind: 'ocr', ref: g.ref, label: `🖼 ${g.name}（辨識文字）` });
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
      else if (c.kind === 'ocr') ocrImages = ocrImages.filter((g) => g.ref !== c.ref);
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
            desc: { type: 'array', items: { type: 'string' } },
          },
          required: ['task', 'dueDate', 'importance', 'sourceCategory', 'desc'],
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
  '這個 App 有兩個地方放內容：「待辦任務」（tasks）與「筆記本」（categories）。',
  '',
  '最重要的原則——每一則內容只能放一邊，兩邊內容「絕不重複」：',
  '● 有「明確需要辦理的事項」＝需要使用者去做某個動作（例如：要交／繳／回覆／完成／出席／聯絡／準備／繳交／報名／付款前置作業等，通常帶有期限或明確動作）→ 放進 tasks，「不要」再放進 categories。',
  '● 沒有明確需辦理動作的內容＝參考資料、記錄、想法、心得、聯絡資訊、清單、會議記錄、知識整理等 → 整理進 categories（筆記本），「不要」放進 tasks。',
  '判斷不確定時，若讀起來像「一件要去做的事」就當 task，像「一則要記住／參考的資訊」就當筆記。同一件事不可同時出現在 tasks 和 categories。',
  '',
  '關於 tasks：',
  '1. 把明確待辦整理成 tasks。每筆有 task（事項標題，一句話講清楚要做什麼）、dueDate、importance、sourceCategory、desc（說明事項）。',
  '   dueDate 一律用 YYYY-MM-DD 格式；沒有明確日期就留空字串。相對日期（例如「下週三」「月底前」）請依使用者提供的今天日期換算成實際日期。',
  '   importance（重要性）只能是 high / medium / low，依「任務本身的影響與後果」判斷——攸關考核／法規期限／對他人有重大影響＝high；例行、可有可無、影響很小＝low；其餘＝medium。importance 只看任務本身的份量，不要把「時間急不急」算進去（急迫程度由 App 依截止日另外計算）。',
  '   sourceCategory＝這件事所屬的主題／情境的簡短詞（例如「部門會議」「評鑑」），沒有就留空字串。',
  '   desc＝這件事的「說明事項」，用簡短條列（字串陣列）列出要做的細項、注意事項、要帶的東西等；若沒有可補充的細節就給空陣列 []。不要把 task 標題本身重複放進 desc。',
  '   tasks 只回傳「這次新內容」中新發現的待辦，不要重複回傳既有內容裡的任務。',
  '',
  '關於 categories（筆記本）——三層階層「分類 ▸ 子分類 ▸ 項目」：',
  '2. 把非待辦內容整理成三層結構。第一層＝分類（categories 的 title，大主題）；第二層＝子分類（subsections 的 heading，該主題下的一個小標題／子題，「必須」給非空字串）；第三層＝項目（bullets，子分類底下的細項條列）。分類與子分類名稱由你自行決定，不需詢問使用者。相近內容歸到同一分類，再依子題分成不同子分類。',
  '   即使某個子分類只有一條項目，也要放在一個有明確 heading 的子分類底下；不要輸出 heading 為空字串的 subsection。',
  '3. 你會收到目前既有的分類（現有 categories 的 JSON）。請把新內容「合併」進去：能歸入既有分類／子分類就歸入，需要新的就新增。',
  '   重要：既有項目、子分類與分類的文字請「原封不動保留」，不要改寫或刪除使用者既有的內容，只新增。回傳的 categories 必須是「合併後的完整結果」（包含既有的與新增的）。既有內容中若有你判斷屬於待辦的項目，也不要把它搬到 tasks（那是使用者自己整理的，保持原樣）。',
  '',
  '關於 expenses（記帳，第三個獨立去處）：',
  '4. 消費／支出類的內容（例如買了東西、花了多少錢、付款、繳費、帳單、含金額的開銷）請「只」整理進 expenses，「不要」放進 categories 或 tasks，也「不要」為它建立「財務紀錄」「花費」之類的分類——這些消費紀錄會呈現在獨立的「記帳」介面。每筆 expense 欄位：item＝品項或用途（簡短，例如「午餐便當」「加油」）；amount＝金額，只放阿拉伯數字（不含貨幣符號、不含逗號，台幣通常是整數）；date＝消費日期 YYYY-MM-DD（內容沒寫日期就用上面提供的今天日期）；category＝你判斷的消費分類，用繁體中文簡短詞（例如 餐飲／交通／購物／娛樂／居家／醫療／教育／其他）。',
  '5. expenses 只回傳「這次新內容」中的消費紀錄，不要重複既有的；若這次內容完全沒有消費，expenses 給空陣列 []。',
  '',
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

async function callClaude(userInput, batchAttachments, visionImages) {
  const ep = claudeEndpoint();
  if (!ep.relay && !settings.apiKey) {
    throw new Error('尚未設定 API 金鑰或中繼站，請點右上角 ⚙ 設定。');
  }
  const today = new Date().toISOString().slice(0, 10);
  const existing = JSON.stringify(categoriesForClaude());
  const hasAtt = Array.isArray(batchAttachments) && batchAttachments.length > 0;
  const hasImg = Array.isArray(visionImages) && visionImages.length > 0;

  let userContent =
    `今天的日期是 ${today}。\n\n` +
    `目前既有的分類（JSON）：\n${existing}\n\n` +
    `以下是使用者這次新提供的內容，請合併整理並找出任務：\n"""\n${userInput}\n"""`;

  if (hasImg) {
    userContent +=
      `\n\n使用者這次還附上了 ${visionImages.length} 張圖片。請先辨識（OCR）每張圖片中的文字，` +
      '把辨識出的內容當作這次新提供的內容一起整理（分類、找任務、找消費）。' +
      '若圖片是表格、單據、清單，請盡量保留其結構；辨識不清的地方就略過、不要臆造。';
  }

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

  // With images, the user content becomes a block array (images first, then the
  // text) so Claude's vision reads the pictures; otherwise a plain string.
  const content = hasImg
    ? [
        ...visionImages.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })),
        { type: 'text', text: userContent },
      ]
    : userContent;

  const body = {
    model: settings.model || 'claude-opus-4-8',
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
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
    if (ep.relay && res.status === 403) {
      throw new Error('中繼站拒絕（403）：存取碼不符，或中繼站未設存取碼。請核對設定裡的存取碼與中繼站的 APP_ACCESS_CODE 是否一致。');
    }
    if (ep.relay && res.status === 401) {
      throw new Error('中繼站的金鑰失效（401）：中繼站保管的 Anthropic 金鑰無效或過期，需由中繼站管理者更新。');
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

  const hasOcr = ocrImages.length > 0; // 🖼 images need Claude's vision, so they force an API call

  if (!combined && batch.length === 0 && !hasOcr) { toast('請先輸入文字，或附加檔案。'); return; }

  // Nothing for Claude to organize (no text, no images) — just save the files to
  // home bullets (no API call, keeping usage down), then clear drafts and input.
  if (!combined && !hasOcr) {
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
      closeInputModal();
      toast('已附加檔案 ✓');
    } catch (err) { toast(err.message); }
    finally { setLoading(false); }
    return;
  }

  setLoading(true);
  try {
    // Encode 🖼 images to base64 for the vision API (Claude OCRs them).
    const visionImages = [];
    for (const g of ocrImages) {
      try { visionImages.push({ media_type: g.type, data: await blobToBase64(g.blob), src: g }); }
      catch (e) { /* skip an unreadable image */ }
    }

    const preTexts = allBulletTexts(); // snapshot before merge → detect new bullets
    const result = await callClaude(
      combined,
      batch.map((b) => ({ ref: b.ref, name: b.name, context: b.context })),
      visionImages.map((v) => ({ media_type: v.media_type, data: v.data })),
    );

    // Busy-day guard: if a new activity's date already has other activities, warn
    // and only create notes + task cards after the user confirms. Abort keeps the
    // input (text/drafts/files) untouched so the user can adjust and retry.
    if (!confirmBusyDayConflicts(result)) {
      toast('已取消建立，內容保留未變更。');
      return;
    }

    // categories: merge Claude's full set, preserving ids of unchanged bullets
    if (Array.isArray(result.categories)) {
      state.categories = mergeCategories(result.categories);
    }
    // tasks: append newly found (dedupe by task+dueDate), text links → id links
    const newTasks = Array.isArray(result.tasks) ? appendTasks(result.tasks) : [];
    // expenses: consumption records → 記帳 store (dedupe by item+amount+date)
    if (Array.isArray(result.expenses)) appendExpenses(result.expenses);

    // attachments: resolve Claude's ref→bulletTexts links, then save the files
    if (batch.length) {
      const linkMap = buildAttachmentLinkMap(result.attachmentLinks, preTexts, batch);
      await saveBatchAttachments(batch, linkMap);
    }

    // OCR images: after reading, ask whether to keep the originals as attachments
    // (like the PDF keep-rule). Kept images link to the bullets this batch created.
    if (visionImages.length && confirm(`要保留這 ${visionImages.length} 張圖片作為附件嗎？\n（辨識已完成；保留可日後從對應筆記開啟原圖）`)) {
      const newIds = collectNewBulletIds(preTexts);
      for (const v of visionImages) {
        const g = v.src;
        const link = newIds.length ? newIds.slice() : [ensureHomeBullet(g.name)];
        await createAttachment({ blob: g.blob, name: g.name, type: g.type, size: g.size }, link);
      }
    }

    state.drafts = []; // drafts were consumed by this 整理
    saveState();
    render();
    els.inputText.value = '';
    clearPending();
    closeInputModal();

    // Auto-add newly-created dated tasks to Google Calendar (opt-in setting). Tasks
    // made by converting a 子分類 → task are NOT auto-added (that path stays manual).
    let calMsg = '';
    if (settings.autoAddCalendar && cloudState.enabled && newTasks.length) {
      calMsg = await autoAddCalendarForTasks(newTasks);
      if (calMsg) render(); // refresh cards to show the 已加入行事曆 marker
    }
    toast('整理完成 ✓' + calMsg);
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
  // Keep each category's stable id across a re-merge (matched by title) so files
  // attached to a category survive Claude reorganizing the notes; a brand-new
  // category gets a fresh id.
  const idByTitle = new Map();
  for (const c of state.categories) if (c.id && !idByTitle.has(c.title)) idByTitle.set(c.title, c.id);
  return (Array.isArray(returned) ? returned : []).map((c) => ({
    id: idByTitle.get(c.title || '未命名分類') || ('cat_' + genId()),
    title: c.title || '未命名分類',
    subsections: (Array.isArray(c.subsections) ? c.subsections : []).map((s) => ({
      id: 'sub_' + genId(),
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
  const created = [];
  for (const t of tasks) {
    if (!t.task) continue;
    const dup = state.tasks.some(
      (x) => x.task === t.task && (x.dueDate || '') === (t.dueDate || '')
    );
    if (dup) continue;
    // New model: a task and a note never overlap, so a task starts with no linked
    // bullets. linkedItemIds is now used only to bind files the user attaches to
    // this task card (keyed by the task's own id — see addTaskAttachments).
    const desc = (Array.isArray(t.desc) ? t.desc : [])
      .map((d) => (typeof d === 'string' ? d : (d && d.text) || ''))
      .filter((x) => x.trim() !== '')
      .map((text) => ({ id: genId(), text }));
    const nt = {
      id: 'tk_' + genId(),
      task: t.task,
      dueDate: t.dueDate || '',
      importance: ['high', 'medium', 'low'].includes(t.importance) ? t.importance : 'medium',
      sourceCategory: t.sourceCategory || '',
      desc,
      linkedItemIds: [],
      done: false,
    };
    state.tasks.push(nt);
    created.push(nt);
  }
  return created;
}

function weekdayZh(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!m) return '';
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return '週' + '日一二三四五六'[d.getDay()];
}

// Busy-day guard: before creating anything from a 整理, look at the newly dated
// activities (tasks with a dueDate that aren't already in the list) and see if
// any land on a day that already holds other activities. If so, warn and let the
// user decide — returns true to proceed, false to abort the whole creation.
function confirmBusyDayConflicts(result) {
  const incoming = (Array.isArray(result.tasks) ? result.tasks : [])
    .filter((t) => t && t.task && /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate || ''))
    .filter((t) => !state.tasks.some((x) => x.task === t.task && (x.dueDate || '') === t.dueDate));
  if (!incoming.length) return true;

  const byDate = new Map(); // date → { incoming:[names], existing:[task] }
  for (const t of incoming) {
    const existing = state.tasks.filter((x) => (x.dueDate || '') === t.dueDate);
    if (!existing.length) continue;
    if (!byDate.has(t.dueDate)) byDate.set(t.dueDate, { names: [], existing });
    byDate.get(t.dueDate).names.push(t.task);
  }
  if (!byDate.size) return true;

  let msg = '⚠ 這次要建立的活動，有日期與現有活動同一天：\n';
  for (const d of [...byDate.keys()].sort()) {
    const { names, existing } = byDate.get(d);
    msg += `\n📅 ${d}（${weekdayZh(d)}）\n`;
    msg += '　新增：' + names.join('、') + '\n';
    msg += '　當天已有：' + existing.map((x) => x.task + (x.done ? '（已完成）' : '')).join('、') + '\n';
  }
  msg += '\n仍要建立筆記與任務卡片嗎？';
  return confirm(msg);
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
  if (!cat) { cat = { id: 'cat_' + genId(), title: '📎 附件', subsections: [] }; state.categories.push(cat); }
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
  await cachePut(id, blob); // local cache; the cloud copy is uploaded on next backup
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
    // Bind the file to the task's OWN id (not a note bullet) so a task stays
    // self-contained — the two pages never share content. attachmentsForItems /
    // orphanAttachments both treat a task id as a live owner.
    const targetId = t.id;
    if (!Array.isArray(t.linkedItemIds)) t.linkedItemIds = [];
    if (!t.linkedItemIds.includes(targetId)) t.linkedItemIds.push(targetId);
    let added = 0;
    for (const file of files) {
      if (file.size > MAX_ATTACH_BYTES) { toast(`「${file.name}」超過 ${MAX_ATTACH_MB}MB，無法附加。`); continue; }
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

// Add file(s) straight into a notebook category (📎 上傳附件 / 📷 拍照). The files
// bind to the category's own id, so they show under that category. Uploaded to
// Drive on the next (debounced) backup, like every other attachment.
async function addCategoryAttachments(cat, files) {
  if (!cat.id) cat.id = 'cat_' + genId();
  setLoading(true);
  try {
    let added = 0, skipped = 0, tooBig = 0;
    for (const file of files) {
      if (file.size > MAX_ATTACH_BYTES) { tooBig++; skipped++; continue; }
      await createAttachment({ blob: file, name: file.name, type: file.type || '', size: file.size }, [cat.id]);
      added++;
    }
    if (tooBig) toast(`有 ${tooBig} 個檔案超過 ${MAX_ATTACH_MB}MB —— 大檔請改用「☁️ 大檔上傳」（存到你的雲端硬碟）。`);
    if (added) {
      expandedCats.add(cat); // keep the category open so the new file is visible
      saveState();
      render();
      toast(added > 1 ? `已上傳 ${added} 個附件 ✓` : '已上傳附件 ✓');
    } else if (!skipped) {
      toast('沒有選擇檔案。');
    }
  } catch (err) {
    toast('上傳失敗：' + err.message);
  } finally {
    setLoading(false);
  }
}

function setLoading(on) {
  els.loadingOverlay.hidden = !on;
  els.processBtn.disabled = on;
  if (!on) setLoadingText(''); // restore the default label when the overlay hides
}
// Override the loading overlay's caption (e.g. upload progress); '' restores default.
function setLoadingText(msg) {
  if (els.loadingText) els.loadingText.textContent = msg || 'Claude 整理中…';
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
  // A manual override (set by tapping the badge) normally wins over the auto tier
  // — the task stops escalating as the deadline nears. BUT 緊急 is a protected
  // floor: when the date makes a task auto-urgent, that is forced (a manual
  // 普通/可暫緩 is ignored and later cleared). So the override only applies while
  // auto is below urgent.
  const overridden = !!(task.priorityOverride && TIER_META[task.priorityOverride]) && auto !== 'urgent';
  const tier = auto === 'urgent' ? 'urgent' : (overridden ? task.priorityOverride : auto);
  return { tier, total, auto, overridden };
}

// Enforce the 緊急 floor on stored state: drop any manual 普通/可暫緩 override on a
// task the date has made auto-urgent (so the forced upgrade persists and the
// badge stops showing 手動). Runs at load / foreground, like pruneCompletedTasks.
function enforceUrgentOverrides() {
  let changed = false;
  for (const t of state.tasks) {
    if (!t.priorityOverride || t.priorityOverride === 'urgent') continue;
    if (priorityOf(t).auto === 'urgent') { delete t.priorityOverride; changed = true; }
  }
  if (changed) saveState();
  return changed;
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
  for (const t of state.tasks) {
    live.add(t.id); // files attached straight to a task card
    for (const d of t.desc || []) live.add(d.id); // files carried onto a task's 說明事項 (from a converted 子分類)
  }
  for (const c of state.categories) if (c.id) live.add(c.id); // files uploaded to a category
  return state.attachments.filter((a) => !(a.linkedItemIds || []).some((id) => live.has(id)));
}

// Does a note bullet with this id still exist? Used to tell a legacy task's real
// linked bullets apart from a task's own-id (attachment) links on delete.
function bulletExists(id) {
  for (const c of state.categories)
    for (const sub of c.subsections || [])
      for (const b of sub.bullets || []) if (b.id === id) return true;
  return false;
}

// Remove a file's local blob and (best-effort) its appDataFolder copy. A LINK
// attachment points at a file in the user's OWN visible Drive — we never delete
// that here (the user manages it); removing the link just drops our record.
function purgeAttachment(att) {
  if (att.kind === 'link') return;
  cacheDelete(att.id).catch(() => {});
  if (att.driveFileId && cloudState.enabled) driveDelete(att.driveFileId).catch(() => {});
}

// Remove note bullets by id and drop any attachment left with no surviving
// linked bullet. This is the cascade for explicit deletes (bullet ✕, category
// delete, completed-task delete). Callers saveState()+render() afterwards.
function categoryBulletCount(cat) {
  return (cat.subsections || []).reduce((n, s) => n + ((s.bullets && s.bullets.length) || 0), 0);
}
// A category is empty only if it has no bullets AND no files uploaded to it — so
// auto-removal (last bullet gone) won't delete a category that still holds files.
function categoryIsEmpty(cat) {
  if (categoryBulletCount(cat) > 0) return false;
  return !(cat.id && attachmentsForItems([cat.id]).length);
}

function removeBulletsByIds(ids) {
  if (!ids || !ids.length) return;
  const idSet = new Set(ids);
  const affected = new Set();
  for (const c of state.categories) {
    for (const sub of c.subsections || []) {
      const before = (sub.bullets || []).length;
      sub.bullets = (sub.bullets || []).filter((b) => !idSet.has(b.id));
      if (sub.bullets.length !== before) { affected.add(c); if (before > 0 && sub.bullets.length === 0) sub._justEmptied = true; }
    }
    // Only remove subsections THIS call emptied (before>0, now 0). An empty 子分類
    // the user created (or emptied by hand) is intentional and must be kept.
    c.subsections = (c.subsections || []).filter((sub) => !(sub.bullets.length === 0 && sub._justEmptied));
    for (const sub of c.subsections || []) delete sub._justEmptied;
  }
  // Auto-remove a category whose last bullet was just deleted. Only categories we
  // actually removed a bullet from are considered — a freshly-created empty
  // category the user made to drag into is left untouched. Claude re-creates the
  // category by title (mergeCategories) if it later organizes content back in.
  if (affected.size) {
    state.categories = state.categories.filter((c) => !(affected.has(c) && categoryIsEmpty(c)));
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
  const linked = t.linkedItemIds || [];
  // Legacy tasks may still point at real note bullets; new tasks only carry their
  // own id (for attached files). A done task clears everything it owns; an undone
  // one only clears its own attached files (its legacy notes are left intact).
  const liveBullets = linked.filter(bulletExists);
  const idsToClear = t.done ? linked : [t.id];
  const atts = attachmentsForItems(idsToClear);
  if (t.done && (liveBullets.length || atts.length)) {
    let msg = `刪除已完成任務「${t.task}」？`;
    if (liveBullets.length) msg += `\n對應的 ${liveBullets.length} 條筆記也會一併刪除。`;
    if (atts.length) msg += `\n含 ${atts.length} 個附加檔案，也會一併刪除。`;
    if (!confirm(msg)) return;
  } else if (!t.done && atts.length) {
    if (!confirm(`刪除任務「${t.task}」？\n含 ${atts.length} 個附加檔案，也會一併刪除。`)) return;
  }
  removeBulletsByIds(idsToClear); // no-op on non-bullet ids; still purges their files
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
  if (els.tabBar) els.tabBar.hidden = !hasContent;
  if (els.expenseHintBtn) {
    els.expenseHintBtn.hidden = expN === 0;
    els.expenseHintBtn.textContent = `💰 已記帳 ${expN} 筆消費 — 點此看統計與明細`;
  }
  renderDrafts();
  renderTasks();
  renderCategories(orphans);
  applyPageVisibility(hasContent);
}

// 待辦任務 and 筆記本 are two sub-pages sharing one screen; only the active one
// shows. Both lists are always built (cheap); this just toggles which is visible.
function applyPageVisibility(hasContent) {
  const onTasks = currentPage === 'tasks';
  els.tasksSection.hidden = !(hasContent && onTasks);
  els.categoriesSection.hidden = !(hasContent && !onTasks);
  if (els.tabTasks) els.tabTasks.classList.toggle('active', onTasks);
  if (els.tabNotes) els.tabNotes.classList.toggle('active', !onTasks);
}

function setPage(page) {
  if (page !== 'tasks' && page !== 'notes') return;
  currentPage = page;
  render();
}

/* ---------------- Attachment chip + open/download ---------------- */
function makeAttachChip(att, opts) {
  opts = opts || {};
  const isLink = att.kind === 'link';
  const chip = document.createElement('span');
  chip.className = 'attach-chip saved' + (isLink ? ' link-chip' : '');
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'attach-open';
  // A link chip shows a 🔗 (plus 🌐 when shared) and opens the Drive link in a tab.
  const icon = isLink ? (att.shared ? '🔗🌐' : '🔗') : fileIcon(att.type, att.name);
  open.textContent = `${icon} ${att.name}`;
  open.title = isLink ? (att.shared ? '雲端硬碟檔案（可分享）— 點開' : '雲端硬碟檔案（私人）— 點開') : '開啟附件';
  open.addEventListener('click', () => {
    if (isLink) {
      if (att.url) window.open(att.url, '_blank', 'noopener');
      else toast('這個雲端連結遺失了，請到 Google Drive 查看。');
    } else {
      openAttachment(att);
    }
  });
  chip.appendChild(open);
  if (opts.removable) {
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'attach-rm';
    rm.textContent = '✕';
    rm.title = isLink ? '移除此雲端連結' : '刪除附件';
    rm.addEventListener('click', () => deleteAttachmentById(att.id));
    chip.appendChild(rm);
  }
  return chip;
}

function deleteAttachmentById(id) {
  const att = state.attachments.find((a) => a.id === id);
  if (!att) return;
  if (att.kind === 'link') {
    // The file lives in the user's own visible Drive — offer to remove just the
    // link (keep the file) or also delete the Drive file.
    const alsoDelete = confirm(
      `移除雲端連結「${att.name}」。\n\n・按「確定」＝同時刪除 Google Drive 上的檔案\n・按「取消」＝只移除這裡的連結，Drive 檔案保留`
    );
    state.attachments = state.attachments.filter((a) => a.id !== id);
    if (alsoDelete && att.driveFileId && cloudState.enabled) driveDeleteFile(att.driveFileId);
    saveState();
    render();
    return;
  }
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
    let blob = await cacheGet(att.id);
    if (!blob) {
      if (att.driveFileId || cloudState.enabled) {
        if (!cloudState.enabled) { toast('這台裝置沒有此附件，且未連結雲端。請在原上傳裝置開啟，或連結 Google Drive 同步。'); return; }
        toast('從雲端下載附件…');
        blob = await downloadAttachmentBlobHealing(att); // self-heals a stale driveFileId
        if (!blob) return; // reason already surfaced by the resolver
        await cachePut(att.id, blob); // cache locally for next time (LRU-bounded)
      } else {
        toast('找不到附件檔案（這台裝置沒有，雲端也沒有備份紀錄）。');
        return;
      }
    }
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

// Detect URLs, network folders, emails and Taiwan phone numbers inside plain
// task text so they can be rendered as tappable links. The URL/file character
// classes are ASCII-only on purpose, so a link stops at the first Chinese
// character (task text has no spaces to lean on). Phone patterns are ordered
// most-specific first. Kept global + reset per call since it's used synchronously.
const LINKIFY_RE = new RegExp([
  'https?:\\/\\/[\\w\\-._~:\\/?#\\[\\]@!$&\'()*+,;=%]+',   // http(s) URL (forms, meeting links, cloud folders)
  'www\\.[\\w\\-._~:\\/?#\\[\\]@!$&\'()*+,;=%]+',          // bare www. link
  'file:\\/\\/[\\w\\-._~:\\/?#\\[\\]@!$&\'()*+,;=%\\\\]+', // file:// path
  '\\\\\\\\[A-Za-z0-9._$\\-\\\\]+',                        // UNC \\server\share (ASCII names only)
  '[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}',  // email
  '\\+886[-\\s]?9\\d{2}[-\\s]?\\d{3}[-\\s]?\\d{3}',        // +886 mobile
  '\\+886[-\\s]?\\d{1,2}[-\\s]?\\d{3,4}[-\\s]?\\d{4}',     // +886 landline
  '09\\d{2}[-\\s]?\\d{3}[-\\s]?\\d{3}',                    // 09xx-xxx-xxx mobile
  '0800[-\\s]?\\d{3}[-\\s]?\\d{3}',                        // 0800 toll-free
  '\\(0\\d{1,2}\\)[-\\s]?\\d{3,4}[-\\s]?\\d{4}',           // (0x)xxxx-xxxx landline
  '0\\d{1,2}[-\\s]?\\d{3,4}[-\\s]?\\d{4}',                 // 0x-xxxx-xxxx landline
].join('|'), 'g');

// Turn one matched token into an { href, external } descriptor.
function linkifyHref(m) {
  if (/^https?:\/\//i.test(m)) return { href: m, external: true };
  if (/^www\./i.test(m)) return { href: 'https://' + m, external: true };
  if (/^file:\/\//i.test(m)) return { href: m, external: true };
  if (/^\\\\/.test(m)) return { href: 'file:' + m.replace(/\\/g, '/'), external: true };
  if (m.includes('@')) return { href: 'mailto:' + m, external: false };
  return { href: 'tel:' + m.replace(/[^\d+]/g, ''), external: false };
}

// Append `text` into `el`, wrapping any detected link/phone in an <a>. Built
// from DOM text nodes (never innerHTML) so surrounding text can't inject markup.
function linkifyInto(el, text) {
  const s = (text == null) ? '' : String(text);
  LINKIFY_RE.lastIndex = 0;
  let last = 0, m;
  while ((m = LINKIFY_RE.exec(s)) !== null) {
    if (m[0].length === 0) { LINKIFY_RE.lastIndex++; continue; }
    const start = m.index;
    if (start > last) el.appendChild(document.createTextNode(s.slice(last, start)));
    let token = m[0];
    let trailing = '';
    // Strip trailing sentence punctuation that greedily attached to a URL/email.
    if (!/^[\d(+]/.test(token)) {
      const tm = token.match(/[.,;:!?、，。）)】」』]+$/);
      if (tm) { trailing = tm[0]; token = token.slice(0, -trailing.length); }
    }
    const info = linkifyHref(token);
    const a = document.createElement('a');
    a.className = 'task-link';
    a.href = info.href;
    a.textContent = token;
    if (info.external) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    a.addEventListener('click', (e) => e.stopPropagation()); // never toggle the card
    el.appendChild(a);
    if (trailing) el.appendChild(document.createTextNode(trailing));
    last = m.index + m[0].length;
  }
  if (last < s.length) el.appendChild(document.createTextNode(s.slice(last)));
  if (!el.childNodes.length) el.appendChild(document.createTextNode(s));
}

function renderTasks() {
  enforceUrgentOverrides(); // drop stale 普通/可暫緩 overrides on now-auto-urgent tasks
  const pending = state.tasks;
  els.tasksList.innerHTML = '';
  // Section visibility is decided by applyPageVisibility (which page is active);
  // when this page is showing but has no tasks, give it its own empty line.
  if (pending.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'page-empty';
    empty.textContent = '目前沒有待辦任務。新增記事後，需要辦理的事項會出現在這裡。';
    els.tasksList.appendChild(empty);
    return;
  }

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

  // Render order: active 緊急/普通 cards, then the 可暫緩 stack (a single collapsed
  // pile so many low-priority items don't clutter the view), then the 已完成 stack.
  const activeCards = withPri.filter((x) => !x.t.done && x.p.tier !== 'low');
  const lowItems = withPri.filter((x) => !x.t.done && x.p.tier === 'low');
  const doneCards = withPri.filter((x) => x.t.done);

  for (const { t, p } of activeCards) els.tasksList.appendChild(buildTaskCard(t, p));
  if (lowItems.length) els.tasksList.appendChild(buildTaskStack(
    lowItems, 'low-stack', '🗂 可暫緩事項', lowStackExpanded,
    () => { lowStackExpanded = !lowStackExpanded; renderTasks(); },
  ));
  if (doneCards.length) els.tasksList.appendChild(buildTaskStack(
    doneCards, 'done-stack', '✓ 已完成事項', doneStackExpanded,
    () => { doneStackExpanded = !doneStackExpanded; renderTasks(); },
  ));

  // A collapsed pile of task cards (可暫緩 or 已完成). Colours come from CSS via the
  // `kind` class; here we only build the shared structure.
  function buildTaskStack(items, kind, labelText, isExpanded, onToggle) {
    const stack = document.createElement('div');
    stack.className = kind + ' card-stack' + (isExpanded ? ' expanded' : '');
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'card-stack-head';
    const caret = document.createElement('span');
    caret.className = 'card-stack-caret';
    caret.textContent = isExpanded ? '▾' : '▸';
    const label = document.createElement('span');
    label.className = 'card-stack-label';
    label.textContent = labelText;
    const count = document.createElement('span');
    count.className = 'card-stack-count';
    count.textContent = items.length + ' 則';
    head.appendChild(caret);
    head.appendChild(label);
    head.appendChild(count);
    head.addEventListener('click', onToggle);
    stack.appendChild(head);
    if (isExpanded) {
      const body = document.createElement('div');
      body.className = 'card-stack-body';
      for (const { t, p } of items) body.appendChild(buildTaskCard(t, p));
      stack.appendChild(body);
    }
    return stack;
  }

  function buildTaskCard(t, p) {
    const meta = TIER_META[p.tier];
    const item = document.createElement('div');
    // 普通 cards collapse to just the badge + title; 緊急 stays open; 可暫緩 shows
    // as a full card inside the stack (the stack itself is the collapse control).
    const collapsible = p.tier === 'normal';
    const expanded = !collapsible || expandedTasks.has(t.id);
    item.className = 'task-item ' + meta.cls + (t.done ? ' done' : '')
      + (collapsible ? ' collapsible' : '') + (collapsible && !expanded ? ' collapsed' : '');

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
      const v = badge.value;
      // 緊急 floor: a task the date has made auto-urgent can't be lowered.
      if (p.auto === 'urgent' && (v === 'normal' || v === 'low')) {
        alert('這張任務因截止日已達「緊急」，無法調降為較低的緊急程度。\n（等截止日過後或任務完成，就不再強制緊急。）');
        renderTasks(); // revert the select back to 緊急
        return;
      }
      if (v === 'auto') delete t.priorityOverride;
      else t.priorityOverride = v;
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
    if (collapsible) {
      const car = document.createElement('span');
      car.className = 'task-caret';
      car.textContent = expanded ? '▾' : '▸';
      badgeRow.appendChild(car);
    }

    const text = document.createElement('div');
    text.className = 'task-text';
    linkifyInto(text, t.task); // URLs/phones/emails in the task become tappable links

    // Tapping the card (but not its interactive controls) expands/collapses.
    if (collapsible) {
      main.addEventListener('click', (e) => {
        if (e.target.closest('.pri-select, .pri-manual-mark, .cal-btn, .attach-chip, a, input, button, select, [contenteditable]')) return;
        if (expandedTasks.has(t.id)) expandedTasks.delete(t.id); else expandedTasks.add(t.id);
        renderTasks();
      });
    }

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
    // Marker when this task was already auto-added to Google Calendar on 整理.
    if (t.calEventId) {
      const added = document.createElement('span');
      added.className = 'cal-added';
      added.textContent = '📅 已加入行事曆 ✓';
      added.title = '整理時已自動建立為 Google 行事曆事件';
      metaRow.appendChild(added);
    }
    const cal = document.createElement('a');
    cal.className = 'cal-btn';
    cal.href = gcalLink(t);
    cal.target = '_blank';
    cal.rel = 'noopener';
    cal.textContent = t.calEventId ? '＋ 再次加入' : '＋ 加入行事曆';
    metaRow.appendChild(cal);

    // Edit this task: time (截止日) + 說明事項 (add/edit/delete) + title.
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'cal-btn task-edit-btn';
    editBtn.textContent = '✏️ 編輯';
    editBtn.title = '編輯任務時間與說明事項';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      editingTasks.add(t.id);
      expandedTasks.add(t.id); // ensure the card is open while editing
      renderTasks();
    });
    metaRow.appendChild(editBtn);

    // Move this item over to 筆記本 (in case the AI mis-filed it as a task).
    const toNote = document.createElement('button');
    toNote.type = 'button';
    toNote.className = 'cal-btn task-move-btn';
    toNote.textContent = '🔄 改為筆記';
    toNote.title = '把這則移到「筆記本」（不是需要辦理的事項時）';
    toNote.addEventListener('click', (e) => { e.stopPropagation(); convertTaskToNote(t); });
    metaRow.appendChild(toNote);

    // Attach a file straight from the task card (kept as an attachment; text is
    // not extracted). Each card gets its own hidden input.
    const attachBtn = document.createElement('button');
    attachBtn.type = 'button';
    attachBtn.className = 'cal-btn task-attach-btn';
    attachBtn.textContent = '📎 附加檔案';
    attachBtn.title = '任何格式、單檔上限 10MB，原樣保留（Claude 不讀內容）。更大的檔請用筆記本分類的「☁️ 大檔上傳」。點 ℹ️ 看完整說明。';
    const attachHelp = document.createElement('button');
    attachHelp.type = 'button';
    attachHelp.className = 'cal-btn task-attach-help';
    attachHelp.textContent = 'ℹ️';
    attachHelp.title = '附件說明';
    attachHelp.setAttribute('aria-label', '附件說明');
    attachHelp.addEventListener('click', openAttachHelp);
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
    metaRow.appendChild(attachHelp);
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
    const isEditing = editingTasks.has(t.id);
    if (isEditing) {
      main.appendChild(text);
      main.appendChild(buildTaskEditor(t));
    } else {
      main.appendChild(text);
      if (expanded) {
        // 說明事項 (description items) — a read-only list under the title.
        if (t.desc && t.desc.length) {
          const ul = document.createElement('ul');
          ul.className = 'task-desc';
          for (const d of t.desc) {
            const li = document.createElement('li');
            linkifyInto(li, d.text);
            ul.appendChild(li);
          }
          main.appendChild(ul);
        }
        main.appendChild(metaRow);

        // Attachments that belong to this task's note items — openable right here.
        const atts = attachmentsForItems(t.linkedItemIds);
        if (atts.length) {
          const attRow = document.createElement('div');
          attRow.className = 'attach-row';
          for (const a of atts) attRow.appendChild(makeAttachChip(a, { removable: true }));
          main.appendChild(attRow);
        }
      }
    }

    const del = document.createElement('button');
    del.className = 'task-del';
    del.textContent = '🗑';
    del.title = '刪除任務';
    del.addEventListener('click', () => deleteTask(t));

    item.appendChild(check);
    item.appendChild(main);
    item.appendChild(del);
    return item;
  }
}

// Inline editor for a task (opened by ✏️ 編輯): edit the title, the 截止日 (time),
// and the 說明事項 (add / edit / delete). Text fields commit on input WITHOUT a
// re-render (so focus is kept); structural changes (add/delete a 說明, done) re-render.
function buildTaskEditor(t) {
  if (!Array.isArray(t.desc)) t.desc = [];
  const box = document.createElement('div');
  box.className = 'task-editor';

  const mkField = (labelText) => {
    const wrap = document.createElement('label');
    wrap.className = 'te-field';
    const lab = document.createElement('span');
    lab.className = 'te-label';
    lab.textContent = labelText;
    wrap.appendChild(lab);
    return wrap;
  };

  // Title
  const titleField = mkField('任務');
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'te-input';
  titleInput.value = t.task || '';
  titleInput.placeholder = '任務標題';
  titleInput.addEventListener('input', () => { t.task = titleInput.value; saveStateQuiet(); });
  titleInput.addEventListener('blur', () => { t.task = titleInput.value.trim(); saveState(); });
  titleField.appendChild(titleInput);
  box.appendChild(titleField);

  // Due date (時間)
  const dateField = mkField('截止日');
  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.className = 'te-input te-date';
  dateInput.value = /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate || '') ? t.dueDate : '';
  dateInput.addEventListener('change', () => {
    t.dueDate = dateInput.value || '';
    delete t.priorityOverride; // let the date drive 緊急程度 again after a date change
    saveState();
    renderTasks(); // due badge + sorting + priority depend on the date
  });
  dateField.appendChild(dateInput);
  const clearDate = document.createElement('button');
  clearDate.type = 'button';
  clearDate.className = 'te-clear-date';
  clearDate.textContent = '清除';
  clearDate.title = '清除截止日';
  clearDate.addEventListener('click', () => { t.dueDate = ''; saveState(); renderTasks(); });
  dateField.appendChild(clearDate);
  box.appendChild(dateField);

  // 說明事項 (description items)
  const descLabel = document.createElement('div');
  descLabel.className = 'te-label te-desc-label';
  descLabel.textContent = '說明事項';
  box.appendChild(descLabel);

  const descList = document.createElement('div');
  descList.className = 'te-desc-list';
  (t.desc || []).forEach((d) => {
    const row = document.createElement('div');
    row.className = 'te-desc-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'te-input';
    input.value = d.text || '';
    input.placeholder = '說明事項…';
    input.addEventListener('input', () => { d.text = input.value; saveStateQuiet(); });
    input.addEventListener('blur', () => { d.text = input.value.trim(); saveState(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addDescRow(); }
    });
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'te-desc-del';
    rm.textContent = '✕';
    rm.title = '刪除這一項說明';
    rm.addEventListener('click', () => {
      t.desc = t.desc.filter((x) => x !== d);
      // Drop any attachment that lived only on this 說明 item.
      const survivors = [];
      for (const att of state.attachments) {
        if ((att.linkedItemIds || []).includes(d.id)) {
          att.linkedItemIds = att.linkedItemIds.filter((id) => id !== d.id);
          if (att.linkedItemIds.length === 0) { purgeAttachment(att); continue; }
        }
        survivors.push(att);
      }
      state.attachments = survivors;
      saveState();
      renderTasks();
    });
    if (d === t.desc[pendingDescFocusIdx]) {
      setTimeout(() => { input.focus(); }, 0);
    }
    row.appendChild(input);
    row.appendChild(rm);
    descList.appendChild(row);
  });
  pendingDescFocusIdx = -1;
  box.appendChild(descList);

  function addDescRow() {
    if (!Array.isArray(t.desc)) t.desc = [];
    t.desc.push({ id: genId(), text: '' });
    pendingDescFocusIdx = t.desc.length - 1;
    saveState();
    renderTasks();
  }

  const controls = document.createElement('div');
  controls.className = 'te-controls';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'te-add-desc';
  addBtn.textContent = '＋ 新增說明';
  addBtn.addEventListener('click', addDescRow);
  const doneBtn = document.createElement('button');
  doneBtn.type = 'button';
  doneBtn.className = 'te-done';
  doneBtn.textContent = '完成編輯';
  doneBtn.addEventListener('click', () => {
    t.task = (t.task || '').trim();
    t.desc = (t.desc || []).filter((d) => (d.text || '').trim() !== '' || attachmentsForBullet(d.id).length);
    editingTasks.delete(t.id);
    saveState();
    renderTasks();
  });
  controls.appendChild(addBtn);
  controls.appendChild(doneBtn);
  box.appendChild(controls);

  return box;
}

function renderCategories(orphans) {
  orphans = orphans || orphanAttachments();
  els.categoriesList.innerHTML = '';
  // Section visibility is handled by applyPageVisibility; show an empty line when
  // the 筆記本 page is active but has nothing yet (the ＋新增分類 button stays in
  // the section head above, so the user can still create one).
  if (state.categories.length === 0 && orphans.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'page-empty';
    empty.textContent = '目前沒有筆記。新增記事後，沒有明確待辦的內容會整理到這裡。';
    els.categoriesList.appendChild(empty);
    return;
  }

  state.categories.forEach((cat, ci) => {
    const expanded = expandedCats.has(cat);
    const card = document.createElement('div');
    card.className = 'category' + (expanded ? ' expanded' : '');
    card.dataset.ci = ci;

    const subs = cat.subsections || [];
    const totalBullets = subs.reduce((n, s) => n + ((s.bullets && s.bullets.length) || 0), 0);
    const catAttCount = cat.id ? attachmentsForItems([cat.id]).length : 0;


    const editing = editingCats.has(cat);
    const head = document.createElement('div');
    head.className = 'category-head';
    const caret = document.createElement('span');
    caret.className = 'cat-caret';
    caret.textContent = '▸';

    // Title is display-only (tapping it just expands/collapses); editing starts
    // only via the ✏️ button, so tapping to expand can't accidentally edit it.
    let title;
    if (editing) {
      title = document.createElement('input');
      title.className = 'category-title';
      title.value = cat.title || '未命名分類';
      const commit = () => {
        cat.title = title.value.trim() || '未命名分類';
        editingCats.delete(cat);
        saveState();
        renderCategories();
      };
      title.addEventListener('blur', commit);
      title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
    } else {
      title = document.createElement('span');
      title.className = 'category-title';
      title.textContent = cat.title || '未命名分類';
    }

    const count = document.createElement('span');
    count.className = 'cat-count';
    count.textContent = (totalBullets || catAttCount)
      ? [totalBullets ? `${totalBullets} 項` : '', catAttCount ? `📎${catAttCount}` : ''].filter(Boolean).join(' ')
      : '空';

    const editBtn = document.createElement('button');
    editBtn.className = 'cat-edit';
    editBtn.textContent = '✏️';
    editBtn.title = '編輯分類名稱';
    editBtn.setAttribute('aria-label', '編輯分類名稱');
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      editingCats.add(cat);
      pendingEditCat = cat;
      renderCategories();
    });

    const catDel = document.createElement('button');
    catDel.className = 'cat-del';
    catDel.textContent = '🗑';
    catDel.title = '刪除整個分類';
    catDel.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`刪除分類「${cat.title}」？裡面的項目也會一併刪除。`)) return;
      state.categories.splice(ci, 1);
      saveState();
      render();
    });

    // Tap the head to expand/collapse — but not while editing the name, and not
    // when the tap is on the ✏️ / 🗑 buttons.
    head.addEventListener('click', (e) => {
      if (editing) return;
      if (e.target.closest('.cat-edit') || e.target.closest('.cat-del')) return;
      if (expandedCats.has(cat)) expandedCats.delete(cat); else expandedCats.add(cat);
      renderCategories();
    });

    head.appendChild(caret);
    head.appendChild(title);
    head.appendChild(count);
    head.appendChild(editBtn);
    head.appendChild(catDel);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'category-body';
    bodyEl.hidden = !expanded;
    if (subs.length === 0 && catAttCount === 0) {
      const hint = document.createElement('div');
      hint.className = 'cat-empty-hint';
      hint.textContent = '用下方「＋ 新增子分類」建立一個子分類，再在裡面新增項目；或用「📎 上傳附件 / 📷 拍照」。';
      bodyEl.appendChild(hint);
    }

    // Each subsection is a 子分類: an editable title + its 項目 (items) list. It
    // has its own 🔄 (convert the whole 子分類 → a 待辦任務, items become the task's
    // 說明事項) and 🗑 (delete the 子分類). Items are edited/deleted individually.
    subs.forEach((sub) => {
      const subEl = document.createElement('div');
      subEl.className = 'subcat';

      // Shared attachments within THIS 子分類: a file linked to 2+ of this 子分類's
      // items (Claude often ties one document to several) is shown once at the
      // bottom of the 子分類, not repeated under every item. A file on a single item
      // still shows under that item.
      const subBulletIds = new Set((sub.bullets || []).map((b) => b.id));
      const subSharedIds = new Set();
      const subSharedAtts = [];
      for (const a of state.attachments) {
        if (a.kind === 'link') continue;
        let n = 0;
        for (const id of (a.linkedItemIds || [])) if (subBulletIds.has(id)) n++;
        if (n >= 2) { subSharedIds.add(a.id); subSharedAtts.push(a); }
      }

      const subHead = document.createElement('div');
      subHead.className = 'subcat-head';
      const subEditing = editingSubs.has(sub.id);
      let subTitle;
      if (subEditing) {
        subTitle = document.createElement('input');
        subTitle.className = 'subcat-title';
        subTitle.value = sub.heading || '';
        subTitle.placeholder = '子分類名稱';
        const commit = () => {
          editingSubs.delete(sub.id);
          sub.heading = subTitle.value.trim();
          saveState();
          renderCategories();
        };
        subTitle.addEventListener('blur', commit);
        subTitle.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); subTitle.blur(); } });
      } else {
        subTitle = document.createElement('span');
        subTitle.className = 'subcat-title' + (sub.heading ? '' : ' placeholder');
        subTitle.textContent = sub.heading || '未命名子分類';
      }
      const subEdit = document.createElement('button');
      subEdit.className = 'subcat-edit';
      subEdit.textContent = '✏️';
      subEdit.title = '編輯子分類名稱';
      subEdit.setAttribute('aria-label', '編輯子分類名稱');
      subEdit.hidden = subEditing;
      subEdit.addEventListener('click', () => { editingSubs.add(sub.id); pendingEditSub = sub.id; renderCategories(); });

      const subToTask = document.createElement('button');
      subToTask.className = 'subcat-totask';
      subToTask.textContent = '🔄';
      subToTask.title = '把整個子分類改為待辦任務（項目會變成該任務的說明事項）';
      subToTask.setAttribute('aria-label', '改為待辦任務');
      subToTask.hidden = subEditing;
      subToTask.addEventListener('click', () => convertSubToTask(cat, sub));

      const subDel = document.createElement('button');
      subDel.className = 'subcat-del';
      subDel.textContent = '🗑';
      subDel.title = '刪除整個子分類';
      subDel.setAttribute('aria-label', '刪除子分類');
      subDel.addEventListener('click', () => deleteSubcategory(cat, sub));

      subHead.appendChild(subTitle);
      subHead.appendChild(subEdit);
      subHead.appendChild(subToTask);
      subHead.appendChild(subDel);
      subEl.appendChild(subHead);

      const ul = document.createElement('ul');
      ul.className = 'bullets';
      (sub.bullets || []).forEach((b) => {
        const li = document.createElement('li');
        li.className = 'bullet';

        const row = document.createElement('div');
        row.className = 'bullet-row';

        // Two modes, mirroring the category-title pattern (v12.04): by default the
        // item is a read-only span whose URLs/phones/emails are tappable links;
        // the ✒ button switches it to plain editable text so links can't fight
        // with "tap to edit". Editing commits on blur/Enter (empty → delete item).
        const editingBullet = editingBullets.has(b.id);
        const span = document.createElement('span');
        span.className = 'bullet-text';
        if (editingBullet) {
          span.contentEditable = 'true';
          span.textContent = b.text;
          const commit = () => {
            editingBullets.delete(b.id);
            const v = span.textContent.trim();
            if (v) { b.text = v; saveState(); renderCategories(); }
            else { deleteItem(cat, sub, b, { silent: true }); }
          };
          span.addEventListener('blur', commit);
          span.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); span.blur(); }
          });
        } else {
          linkifyInto(span, b.text);
        }

        const bEdit = document.createElement('button');
        bEdit.className = 'bullet-edit';
        bEdit.textContent = '✒';
        bEdit.title = '編輯這一項';
        bEdit.setAttribute('aria-label', '編輯這一項');
        bEdit.hidden = editingBullet;
        bEdit.addEventListener('click', () => {
          editingBullets.add(b.id);
          pendingEditBullet = b.id;
          renderCategories();
        });

        const bDel = document.createElement('button');
        bDel.className = 'bullet-del';
        bDel.textContent = '✕';
        bDel.title = '刪除這一項';
        bDel.addEventListener('click', () => deleteItem(cat, sub, b));

        row.appendChild(span);
        row.appendChild(bEdit);
        row.appendChild(bDel);
        li.appendChild(row);

        // Just entered edit mode for this item → focus & place caret at the end.
        if (editingBullet && b.id === pendingEditBullet) {
          pendingEditBullet = null;
          setTimeout(() => { span.focus(); placeCaretEnd(span); }, 0);
        }

        // Files attached to this item — but not ones shared across several items in
        // this 子分類 (those show once at the 子分類 bottom instead).
        const atts = attachmentsForBullet(b.id).filter((a) => !subSharedIds.has(a.id));
        if (atts.length) {
          const attRow = document.createElement('div');
          attRow.className = 'attach-row bullet-attach';
          for (const a of atts) attRow.appendChild(makeAttachChip(a, { removable: true }));
          li.appendChild(attRow);
        }

        ul.appendChild(li);
      });
      subEl.appendChild(ul);

      // Attachments shared by 2+ items of this 子分類 — shown once at its bottom.
      if (subSharedAtts.length) {
        const attRow = document.createElement('div');
        attRow.className = 'attach-row subcat-attach';
        for (const a of subSharedAtts) attRow.appendChild(makeAttachChip(a, { removable: true }));
        subEl.appendChild(attRow);
      }

      const addItemBtn = document.createElement('button');
      addItemBtn.className = 'add-item-btn add-sub-item';
      addItemBtn.textContent = '＋ 新增項目';
      addItemBtn.addEventListener('click', () => addItem(cat, sub));
      subEl.appendChild(addItemBtn);

      bodyEl.appendChild(subEl);

      // Just created / started editing this 子分類 → focus its title field.
      if (subEditing && sub.id === pendingEditSub) {
        pendingEditSub = null;
        setTimeout(() => { subTitle.focus(); subTitle.select && subTitle.select(); }, 0);
      }
    });

    // Files uploaded to the category itself (📎/📷/☁️ 大檔) or link-type — these
    // aren't tied to any one 子分類, so they stay at the category-card bottom.
    const catAtts = cat.id ? attachmentsForItems([cat.id]) : [];
    if (catAtts.length) {
      const attRow = document.createElement('div');
      attRow.className = 'attach-row cat-attach';
      for (const a of catAtts) attRow.appendChild(makeAttachChip(a, { removable: true }));
      bodyEl.appendChild(attRow);
    }

    const actions = document.createElement('div');
    actions.className = 'cat-actions';
    const addSubBtn = document.createElement('button');
    addSubBtn.className = 'add-item-btn';
    addSubBtn.textContent = '＋ 新增子分類';
    addSubBtn.addEventListener('click', () => addSubcategory(cat));
    actions.appendChild(addSubBtn);

    // 📎 上傳附件 — any file (incl. large ones up to the cap). 📷 拍照 opens the
    // camera on mobile via the capture attribute (a normal file picker on desktop).
    const upBtn = document.createElement('button');
    upBtn.className = 'add-item-btn cat-upload-btn';
    upBtn.textContent = '📎 上傳附件';
    const upInput = document.createElement('input');
    upInput.type = 'file'; upInput.multiple = true; upInput.hidden = true;
    upBtn.addEventListener('click', () => upInput.click());
    upInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []); upInput.value = '';
      if (files.length) await addCategoryAttachments(cat, files);
    });

    const camBtn = document.createElement('button');
    camBtn.className = 'add-item-btn cat-upload-btn';
    camBtn.textContent = '📷 拍照';
    const camInput = document.createElement('input');
    camInput.type = 'file'; camInput.accept = 'image/*'; camInput.capture = 'environment'; camInput.hidden = true;
    camBtn.addEventListener('click', () => camInput.click());
    camInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []); camInput.value = '';
      if (files.length) await addCategoryAttachments(cat, files);
    });

    // ☁️ 大檔上傳 — files up to 100MB go to the user's OWN visible Drive (drive.file)
    // and are stored here as a shareable link, not in the app's private folder.
    const bigBtn = document.createElement('button');
    bigBtn.className = 'add-item-btn cat-bigfile-btn';
    bigBtn.textContent = '☁️ 大檔上傳';
    bigBtn.title = `超過 ${MAX_ATTACH_MB}MB 的大檔／要分享的檔案：上傳到你自己的 Google 雲端硬碟（可選擇是否分享），最大 ${MAX_BIGFILE_MB}MB。`;
    const bigInput = document.createElement('input');
    bigInput.type = 'file'; bigInput.multiple = true; bigInput.hidden = true;
    // The Drive authorization popup can ONLY open from a direct button tap (not
    // from the file picker's change event → popup_failed_to_open). So authorize
    // here first; only open the picker once the scope is in hand (same gesture,
    // no await before .click()).
    bigBtn.addEventListener('click', async () => {
      if (!cloudState.enabled) { toast('請先在設定連結 Google 帳號，才能上傳大檔到雲端硬碟。'); return; }
      if (hasDriveFileScope()) { bigInput.click(); return; } // ready → open picker now
      try { await ensureDriveFileScope(); }                  // this tap = a valid gesture for the popup
      catch (e) { toast(e.message || String(e)); return; }
      toast('已完成雲端硬碟授權 ✓ 請再按一次「☁️ 大檔上傳」選擇檔案。');
    });
    bigInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []); bigInput.value = '';
      if (files.length) await addCategoryBigFiles(cat, files);
    });

    actions.appendChild(upBtn);
    actions.appendChild(camBtn);
    actions.appendChild(bigBtn);
    actions.appendChild(upInput);
    actions.appendChild(camInput);
    actions.appendChild(bigInput);
    bodyEl.appendChild(actions);

    card.appendChild(head);
    card.appendChild(bodyEl);
    els.categoriesList.appendChild(card);

    // Just entered edit mode for this category → focus & select its name field.
    if (editing && cat === pendingEditCat) { title.focus(); title.select(); pendingEditCat = null; }
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

}

/* ---------------- Category editing helpers ---------------- */
// A "general" (heading-less) subsection is where manually-added and dragged-in
// items collect, kept separate from Claude's headed groupings.
function getGeneralSub(cat) {
  if (!cat.subsections) cat.subsections = [];
  let s = cat.subsections.find((x) => !x.heading);
  if (!s) { s = { id: 'sub_' + genId(), heading: '', bullets: [] }; cat.subsections.push(s); }
  if (!s.id) s.id = 'sub_' + genId();
  return s;
}
// Add an item (項目) inside a specific 子分類 (subsection). The 3-level model has
// no free-floating items: every item lives under a 子分類.
function addItem(cat, sub) {
  expandedCats.add(cat); // keep the category open so the new (focused) item is visible
  if (!Array.isArray(sub.bullets)) sub.bullets = [];
  const id = genId();
  sub.bullets.push({ id, text: '' });
  editingBullets.add(id);   // new item starts editable + focused (via pendingEditBullet)
  pendingEditBullet = id;
  saveState();
  renderCategories();
}
// Add a new 子分類 (subsection) to a category, starting in title-edit mode.
function addSubcategory(cat) {
  expandedCats.add(cat);
  if (!Array.isArray(cat.subsections)) cat.subsections = [];
  const sub = { id: 'sub_' + genId(), heading: '', bullets: [] };
  cat.subsections.push(sub);
  editingSubs.add(sub.id);
  pendingEditSub = sub.id;
  saveState();
  renderCategories();
}
// Delete a single 項目 (item). Keeps its 子分類 and category (unlike the old
// bullet delete, which pruned emptied subs/categories). silent → skip the confirm
// (used when an inline edit is committed empty).
function deleteItem(cat, sub, b, opts) {
  opts = opts || {};
  const atts = attachmentsForBullet(b.id);
  if (!opts.silent && atts.length && !confirm(`刪除這一項？\n對應的 ${atts.length} 個附加檔案也會一併刪除。`)) return;
  editingBullets.delete(b.id);
  sub.bullets = (sub.bullets || []).filter((x) => x.id !== b.id);
  // Drop attachments that belonged only to this item.
  const survivors = [];
  for (const att of state.attachments) {
    if ((att.linkedItemIds || []).includes(b.id)) {
      att.linkedItemIds = att.linkedItemIds.filter((id) => id !== b.id);
      if (att.linkedItemIds.length === 0) { purgeAttachment(att); continue; }
    }
    survivors.push(att);
  }
  state.attachments = survivors;
  saveState();
  render();
}
// Delete an entire 子分類 (subsection) and its items/attachments. Keeps the
// category (the category has its own 🗑).
function deleteSubcategory(cat, sub) {
  const bulletIds = (sub.bullets || []).map((b) => b.id);
  const atts = attachmentsForItems(bulletIds);
  const n = bulletIds.length;
  let msg = `刪除子分類「${sub.heading || '未命名子分類'}」？`;
  if (n) msg += `\n底下的 ${n} 個項目也會一併刪除。`;
  if (atts.length) msg += `\n含 ${atts.length} 個附加檔案，也會一併刪除。`;
  if (!confirm(msg)) return;
  for (const id of bulletIds) editingBullets.delete(id);
  editingSubs.delete(sub.id);
  cat.subsections = (cat.subsections || []).filter((s) => s !== sub);
  const idSet = new Set(bulletIds);
  const survivors = [];
  for (const att of state.attachments) {
    att.linkedItemIds = (att.linkedItemIds || []).filter((id) => !idSet.has(id));
    if (att.linkedItemIds.length === 0) purgeAttachment(att); else survivors.push(att);
  }
  state.attachments = survivors;
  saveState();
  render();
}
function addCategory() {
  const cat = { id: 'cat_' + genId(), title: '新分類', subsections: [] };
  state.categories.push(cat);
  expandedCats.add(cat);  // open it so the user can add items right away
  editingCats.add(cat);   // and start in name-edit mode (focused via pendingEditCat)
  pendingEditCat = cat;
  saveState();
  render();
}
// Fixed landing bucket for tasks the user manually re-files as notes.
function ensureUncategorized() {
  let cat = state.categories.find((c) => c.title === UNCAT_TITLE);
  if (!cat) { cat = { id: 'cat_' + genId(), title: UNCAT_TITLE, subsections: [] }; state.categories.push(cat); }
  return cat;
}

/* ---------------- Manual move between 待辦任務 and 筆記本 ---------------- */
// The AI keeps the two pages mutually exclusive, but its judgement isn't perfect,
// so each item carries a 🔄 button to move it to the other page by hand.

// 待辦任務 → 筆記本. The task becomes a 子分類 in 未分類: its title → 子分類 heading,
// its 說明事項 → 項目 (reusing item ids so any attachments follow). Files attached to
// the task card itself (keyed by the task id) are re-pointed onto an item.
function convertTaskToNote(t) {
  const cat = ensureUncategorized();
  if (!Array.isArray(cat.subsections)) cat.subsections = [];
  const bullets = (t.desc || []).map((d) => ({ id: d.id, text: d.text }));
  const ownAtts = state.attachments.filter((a) => (a.linkedItemIds || []).includes(t.id));
  if (ownAtts.length) {
    let target = bullets[0];
    if (!target) { target = { id: genId(), text: t.task || '附件' }; bullets.push(target); }
    for (const att of ownAtts) att.linkedItemIds = att.linkedItemIds.map((id) => (id === t.id ? target.id : id));
  }
  const sub = { id: 'sub_' + genId(), heading: t.task || '', bullets };
  cat.subsections.push(sub);
  state.tasks = state.tasks.filter((x) => x.id !== t.id);
  editingTasks.delete(t.id);
  expandedCats.add(cat);
  saveState();
  render();
  toast('已改為筆記，放到「未分類」（切到「筆記本」分頁可看到）✓');
}

// 筆記本 → 待辦任務 (at the 子分類 level). The 子分類 title → task title, its 項目 →
// the task's 說明事項 (reusing item ids so their attachments follow). The 子分類 is
// removed; an emptied category is cleaned up.
function convertSubToTask(cat, sub) {
  const desc = (sub.bullets || [])
    .map((b) => ({ id: b.id, text: b.text }))
    .filter((d) => d.text.trim() !== '' || attachmentsForBullet(d.id).length);
  const task = {
    id: 'tk_' + genId(),
    task: sub.heading || '',
    dueDate: '',
    importance: 'medium',
    sourceCategory: cat.title && cat.title !== UNCAT_TITLE ? cat.title : '',
    desc,
    linkedItemIds: desc.map((d) => d.id), // attachments on these item ids surface on the card + cascade on delete
    done: false,
  };
  state.tasks.push(task);
  cat.subsections = (cat.subsections || []).filter((s) => s !== sub);
  editingSubs.delete(sub.id);
  if ((cat.subsections || []).length === 0 && categoryIsEmpty(cat)) {
    state.categories = state.categories.filter((c) => c !== cat);
  }
  saveState();
  render();
  toast('已改為待辦任務（切到「待辦任務」分頁可看到）✓');
}

function placeCaretEnd(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
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
            if (resp && resp.access_token) { gisToken = resp.access_token; grantedScopes = resp.scope || grantedScopes; settleToken('resolve', gisToken); }
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

function hasDriveFileScope() { return !!gisToken && grantedScopes.includes('drive.file'); }

// Ensure the current token carries drive.file (needed to write to the user's
// visible Drive). Tries a SILENT refresh first (no popup — works once the user has
// granted drive.file before, e.g. on a later session). If still missing, opens the
// INTERACTIVE consent popup — which only succeeds inside a direct user gesture
// (a button tap), NOT inside a file-input change handler (that trips
// popup_failed_to_open). Callers gate the file picker on this first.
async function ensureDriveFileScope() {
  if (hasDriveFileScope()) return;
  try { gisToken = null; await getAccessToken('none'); } catch (e) { /* no silent session */ }
  if (grantedScopes.includes('drive.file')) return;
  gisToken = null;
  await getAccessToken(''); // interactive consent — needs a fresh user gesture
  if (!grantedScopes.includes('drive.file')) {
    throw new Error('尚未取得「存取你 Drive 檔案」的授權。請再按一次「☁️ 大檔上傳」，並在 Google 畫面按「允許」。');
  }
}

async function fetchUserEmail() {
  try {
    const res = await driveFetch('https://www.googleapis.com/oauth2/v3/userinfo', {});
    if (res.ok) return (await res.json()).email || '';
  } catch (e) { /* best-effort */ }
  return '';
}

/* ---------------- Google Calendar (auto-add on 整理) ---------------- */
// A SEPARATE token client, so calendar consent is only ever asked when the user
// opts in (turning on the setting), never bundled with the Drive connect flow.
let calTokenClient = null;
let calToken = '';
let calTokenResolve = null;
let calTokenReject = null;
function settleCalToken(fn, arg) {
  const r = fn === 'resolve' ? calTokenResolve : calTokenReject;
  calTokenResolve = calTokenReject = null;
  if (r) r(arg);
}
async function getCalToken(promptMode, hint) {
  if (!GOOGLE_CLIENT_ID) throw new Error('尚未設定 Google Client ID。');
  await ensureGis();
  return new Promise((resolve, reject) => {
    if (calTokenReject) { const rej = calTokenReject; calTokenResolve = calTokenReject = null; rej(new Error('已被新的授權請求取代。')); }
    calTokenResolve = resolve;
    calTokenReject = reject;
    try {
      if (!calTokenClient) {
        calTokenClient = google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: CALENDAR_SCOPE,
          callback: (resp) => {
            if (resp && resp.access_token) { calToken = resp.access_token; settleCalToken('resolve', calToken); }
            else settleCalToken('reject', new Error('未取得 Google 行事曆授權。'));
          },
          error_callback: (err) => settleCalToken('reject', new Error('行事曆授權未完成' + (err && err.type ? '（' + err.type + '）' : '') + '。')),
        });
      }
      // hint pins the request to a specific account — needed for a reliable SILENT
      // ('none') refresh when several Google accounts are signed into the browser.
      const cfg = { prompt: promptMode || '' };
      if (hint) cfg.hint = hint;
      calTokenClient.requestAccessToken(cfg);
    } catch (e) { settleCalToken('reject', e); }
  });
}
// Get a usable calendar token: reuse the one in hand, else refresh silently pinned
// to the chosen account (so multi-account browsers don't pick the wrong one).
async function ensureCalTokenSilent() {
  if (calToken) return;
  await getCalToken('none', settings.calendarEmail || undefined);
}
// Ensure a calendar token, INTERACTIVELY with the ACCOUNT CHOOSER (needs a fresh
// user gesture — used from the settings toggle). We force select_account so the
// user explicitly picks which account's calendar the events go into — it may differ
// from the Drive/backup account, and from the browser's default account.
async function ensureCalendarScope() {
  calToken = null;
  await getCalToken('select_account');
  if (!calToken) throw new Error('尚未取得 Google 行事曆授權。');
}
// Read back the email of the account the calendar token belongs to (needs the
// openid+email scope). Best-effort.
async function fetchCalEmail() {
  try {
    const res = await calFetch('https://www.googleapis.com/oauth2/v3/userinfo', {}, 'none');
    if (res.ok) return (await res.json()).email || '';
  } catch (e) { /* best-effort */ }
  return '';
}
async function calFetch(url, opts) {
  opts = opts || {};
  await ensureCalTokenSilent();
  const run = () => fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + calToken } });
  let res = await run();
  if (res.status === 401) { calToken = null; await ensureCalTokenSilent(); res = await run(); }
  return res;
}
// Build an all-day event body for a task (matches the manual gcalLink behaviour).
function calEventBody(t) {
  const [y, m, d] = t.dueDate.split('-').map(Number);
  const nx = new Date(y, m - 1, d + 1);
  const endDate = nx.getFullYear() + '-' + String(nx.getMonth() + 1).padStart(2, '0') + '-' + String(nx.getDate()).padStart(2, '0');
  const descLines = [];
  if (t.sourceCategory) descLines.push('主題：' + t.sourceCategory);
  for (const dd of (t.desc || [])) if (dd.text) descLines.push('・' + dd.text);
  descLines.push('（由智慧記事本整理時自動加入）');
  return {
    summary: t.task,
    description: descLines.join('\n'),
    start: { date: t.dueDate },
    end: { date: endDate },
  };
}
// Insert one task as an all-day Google Calendar event; records the event id on the
// task so it isn't added twice. Returns true on success.
async function addTaskToCalendar(t) {
  const res = await calFetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(calEventBody(t)),
  });
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = (j.error && (j.error.message || j.error.status)) || ''; } catch (e) { /* ignore */ }
    throw new Error('HTTP ' + res.status + (detail ? '：' + detail : ''));
  }
  const ev = await res.json();
  t.calEventId = ev.id || 'added';
  return true;
}
// Called after a 整理 when the setting is on: add newly-created, dated tasks to the
// calendar. Best-effort — returns a short suffix for the completion toast.
// Reflect the calendar target account + test button in the settings UI.
function updateCalAccountNote() {
  if (els.calAccountNote) {
    if (settings.autoAddCalendar && settings.calendarEmail) {
      const diff = cloudState.email && settings.calendarEmail !== cloudState.email
        ? '（與備份帳號不同）' : '';
      els.calAccountNote.textContent = `行事曆事件會建立在：${settings.calendarEmail} ${diff}`;
      els.calAccountNote.hidden = false;
    } else {
      els.calAccountNote.hidden = true;
    }
  }
  if (els.calTestBtn) els.calTestBtn.hidden = !settings.autoAddCalendar;
}
// One-shot diagnostic: create a test all-day event today and show the exact result
// (or the precise Google error). Runs from a button gesture, so it can fall back to
// an interactive account chooser if the silent token isn't available.
async function testCalendarWrite() {
  if (!cloudState.enabled) { toast('請先連結 Google 帳號。'); return; }
  try {
    await ensureCalTokenSilent();
  } catch (e) {
    try { calToken = null; await getCalToken('select_account'); settings.calendarEmail = await fetchCalEmail(); saveSettings(); updateCalAccountNote(); }
    catch (e2) { alert('取得行事曆授權失敗：\n' + (e2.message || e2)); return; }
  }
  const email = (await fetchCalEmail()) || settings.calendarEmail || '(未知)';
  const test = { task: '【測試】智慧記事本行事曆寫入', dueDate: todayStr(), sourceCategory: '測試', desc: [] };
  try {
    await addTaskToCalendar(test);
    alert('✅ 測試事件已建立成功！\n\n授權帳號：' + email + '\n請到「該帳號」今天的 Google 行事曆查看「【測試】…」全天事件（可自行刪除）。\n\n若你在別的帳號看不到，就是帳號不同的問題。');
  } catch (e) {
    alert('❌ 測試寫入失敗：\n' + (e.message || e) + '\n\n授權帳號：' + email + '\n\n若是 HTTP 403 / PERMISSION_DENIED，通常是 OAuth 同意畫面未核准 calendar.events 權限（需在 Google Cloud Console 設定）。');
  }
}

async function autoAddCalendarForTasks(newTasks) {
  const targets = newTasks.filter((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate || '') && !t.calEventId);
  if (!targets.length) return '';
  try {
    await ensureCalTokenSilent(); // reuse in-hand token, else silent refresh pinned to the chosen account
  } catch (e) {
    return '（行事曆自動加入需重新授權：請到設定點「🔧 測試寫入」看原因）';
  }
  if (!calToken) return '（行事曆自動加入需重新授權，請到設定關閉再開啟一次）';
  let ok = 0, firstErr = '';
  for (const t of targets) {
    try { await addTaskToCalendar(t); ok++; } catch (e) { if (!firstErr) firstErr = e.message || String(e); }
  }
  if (ok) saveState();
  const fail = targets.length - ok;
  if (ok && !fail) return `，並自動加入行事曆 ${ok} 筆 📅`;
  if (ok && fail) return `，行事曆加入 ${ok} 筆、失敗 ${fail} 筆（${firstErr}）`;
  return `（行事曆自動加入失敗：${firstErr}）`;
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
    ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=id,modifiedTime`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime`;
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
// Upload a binary with Drive's RESUMABLE protocol. A single multipart POST is
// fragile for large files (a dropped mobile connection loses the whole thing);
// resumable sends the file in chunks over a session URI and retries a failed
// chunk from the server-reported offset. `opts.parents` targets a folder
// (['appDataFolder'] for the private store, a folder id for visible My Drive,
// or omitted for My Drive root); `opts.fields` picks the returned fields;
// `opts.onProgress(fraction)` reports progress. Returns the file resource.
async function driveResumableUpload(name, blob, opts) {
  opts = opts || {};
  const fields = opts.fields || 'id';
  const meta = { name };
  if (opts.parents) meta.parents = opts.parents;
  const start = await driveFetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=${encodeURIComponent(fields)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': blob.type || 'application/octet-stream',
      'X-Upload-Content-Length': String(blob.size),
    },
    body: JSON.stringify(meta),
  });
  if (!start.ok) throw new Error('建立上傳工作階段失敗（' + start.status + '）。');
  const session = start.headers.get('Location');
  if (!session) throw new Error('未取得上傳工作階段位址。');

  const CHUNK = 8 * 1024 * 1024;         // 8MB (a multiple of 256KB, as Drive requires)
  const total = blob.size;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let offset = 0;
  while (offset < total || total === 0) {  // a zero-length file still needs one PUT
    const end = Math.min(offset + CHUNK, total);
    const chunk = blob.slice(offset, end);
    const range = total === 0 ? `bytes */0` : `bytes ${offset}-${end - 1}/${total}`;
    let done = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      let res;
      // The session URI is pre-authorized, so no Authorization header here.
      try { res = await fetch(session, { method: 'PUT', headers: { 'Content-Range': range }, body: chunk }); }
      catch (e) { await sleep(600 * (attempt + 1)); continue; } // network blip → retry same chunk
      if (res.status === 200 || res.status === 201) { if (opts.onProgress) opts.onProgress(1); return res.json(); }
      if (res.status === 308) {                                  // chunk accepted, more to go
        const r = res.headers.get('Range');
        const m = r && /-(\d+)$/.exec(r);
        offset = m ? (parseInt(m[1], 10) + 1) : end;
        done = true;
        break;
      }
      if (res.status === 401) { gisToken = null; await getAccessToken('none'); await sleep(300); continue; }
      if (res.status >= 500) { await sleep(600 * (attempt + 1)); continue; } // transient server error
      throw new Error('上傳失敗（' + res.status + '）。');
    }
    if (!done) throw new Error('上傳中斷，請稍後再試（網路不穩）。');
    if (opts.onProgress && total > 0) opts.onProgress(offset / total);
    if (total === 0) break;
  }
  throw new Error('上傳完成但未取得檔案編號。');
}

// The app's private appDataFolder attachment upload (small files ≤10MB).
function driveUploadBlob(fileId, name, blob) {
  // fileId (overwrite an existing file) is unused now that names are unique per
  // attachment; kept in the signature for callers. New file → appDataFolder.
  return driveResumableUpload(name, blob, { parents: ['appDataFolder'] });
}

const BIGFILE_FOLDER_NAME = '智慧記事本附件';
// Find (or create) a folder in the user's visible My Drive to keep big-file
// uploads tidy. drive.file lets the app see only folders it created, so a cached
// id that no longer resolves is simply recreated. Returns a folder id, or ''
// (fall back to My Drive root) if folder handling fails.
async function ensureUploadFolder() {
  const mk = async () => {
    const res = await driveFetch('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name: BIGFILE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    });
    if (!res.ok) return '';
    return (await res.json()).id || '';
  };
  if (cloudState.uploadFolderId) {
    // Verify it still exists and isn't trashed.
    const chk = await driveFetch(`https://www.googleapis.com/drive/v3/files/${cloudState.uploadFolderId}?fields=id,trashed`, {});
    if (chk.ok) { const j = await chk.json(); if (j && j.id && !j.trashed) return cloudState.uploadFolderId; }
  }
  const id = await mk();
  if (id) { cloudState.uploadFolderId = id; saveCloudState(); }
  return id;
}

// Read a file's shareable link (and its size) after an upload.
async function driveFileMeta(fileId) {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,size,webViewLink`, {});
  if (!res.ok) throw new Error('讀取檔案連結失敗（' + res.status + '）。');
  return res.json();
}

// Make a file readable by anyone with the link (only when the user opts in).
async function driveShareAnyone(fileId) {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  if (!res.ok) throw new Error('設定分享權限失敗（' + res.status + '）。');
  return true;
}

// Delete a visible-Drive file the app created (used when removing a link the user
// asks to also delete). Best-effort.
async function driveDeleteFile(fileId) {
  try { await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, { method: 'DELETE' }); } catch (e) { /* ignore */ }
}

// Big-file path: upload each file to the user's visible My Drive, optionally share
// it, and store a LINK attachment (no local blob, no appDataFolder) on the category.
async function addCategoryBigFiles(cat, files) {
  if (!cloudState.enabled) { toast('請先在設定連結 Google 帳號，才能上傳大檔到雲端硬碟。'); return; }
  if (!cat.id) cat.id = 'cat_' + genId();
  const bigList = files.filter((f) => f.size <= MAX_BIGFILE_BYTES);
  if (!bigList.length) { toast(`檔案超過 ${MAX_BIGFILE_MB}MB，無法上傳。`); return; }
  // Authorization was obtained on the button tap (the file picker only opens once
  // the scope is granted). This is a non-popup guard for the unexpected case.
  if (!hasDriveFileScope()) { toast('尚未完成雲端硬碟授權，請再按一次「☁️ 大檔上傳」。'); return; }
  // Ask about sharing once for the whole batch (the user chooses).
  const share = confirm('上傳後要讓「知道連結的人都能檢視」以便分享嗎？\n\n・按「確定」＝可分享（任何人有連結就能開）\n・按「取消」＝只有你自己能開（日後仍可到 Drive 再分享）');
  setLoading(true);
  try {
    const folderId = await ensureUploadFolder();
    let added = 0;
    for (const file of files) {
      if (file.size > MAX_BIGFILE_BYTES) { toast(`「${file.name}」超過 ${MAX_BIGFILE_MB}MB，略過。`); continue; }
      setLoadingText(`上傳「${file.name}」到雲端硬碟…`);
      const up = await driveResumableUpload(file.name, file, {
        parents: folderId ? [folderId] : undefined,
        fields: 'id,name,size,webViewLink',
        onProgress: (fr) => setLoadingText(`上傳「${file.name}」…${Math.round(fr * 100)}%`),
      });
      let link = up.webViewLink;
      if (!link) { try { link = (await driveFileMeta(up.id)).webViewLink; } catch (e) { /* keep going */ } }
      if (share) { try { await driveShareAnyone(up.id); } catch (e) { toast('分享權限設定失敗，檔案仍已上傳（可稍後在 Drive 手動分享）。'); } }
      state.attachments.push({
        id: genId(),
        kind: 'link',
        name: file.name,
        type: file.type || '',
        size: file.size,
        driveFileId: up.id,
        url: link || '',
        shared: !!share,
        addedAt: new Date().toISOString(),
        linkedItemIds: [cat.id],
      });
      added++;
    }
    if (added) {
      expandedCats.add(cat);
      saveState();
      render();
      toast(added > 1 ? `已上傳 ${added} 個大檔到雲端硬碟 ✓` : '已上傳到雲端硬碟 ✓');
    }
  } catch (err) {
    toast('大檔上傳失敗：' + (err.message || err));
  } finally {
    setLoadingText('');
    setLoading(false);
  }
}

// Fetch one attachment's binary from Drive, self-healing a stale driveFileId.
// The stored id can go dead — a bundle restored from an older backup, an account
// re-connect, or a switch — but the file itself still lives in the current
// account's appDataFolder under its stable name `att_<id>` (same fix the blood
// pressure / course apps use for the main JSON: always re-resolve by name).
// Returns a Blob, or null after toasting a precise reason. Throws only on a
// network error the caller's try/catch reports.
async function downloadAttachmentBlobHealing(att) {
  const wantName = 'att_' + att.id;
  // 1) Try the id we have. A 404/403 means it may be stale → fall through to
  //    re-resolve by name; any other bad status is a real download error.
  if (att.driveFileId) {
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${att.driveFileId}?alt=media`, {});
    if (res.ok) return res.blob();
    if (res.status !== 404 && res.status !== 403) { toast('下載附件失敗（' + res.status + '）。'); return null; }
  }
  // 2) Re-resolve by the file's stable name in this account's appDataFolder.
  let found = null;
  try { found = await driveFindFile(wantName); }
  catch (e) { toast('讀取雲端附件清單失敗：' + (e.message || e)); return null; }
  if (!found) {
    toast('雲端在目前帳號找不到此附件（可能是用另一個 Google 帳號上傳，或檔案已被刪除）。');
    return null;
  }
  if (found.id !== att.driveFileId) { att.driveFileId = found.id; saveStateQuiet(); } // heal the stored id
  const res2 = await driveFetch(`https://www.googleapis.com/drive/v3/files/${found.id}?alt=media`, {});
  if (!res2.ok) { toast('下載附件失敗（' + res2.status + '）。'); return null; }
  return res2.blob();
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
  const blob = await cacheGet(att.id);
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
  cloudState.lastEditAt = new Date().toISOString(); // marks how fresh the local data is
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
    cloudState.lastEditAt = bundle.updatedAt; // local is now fully reflected in the cloud
    if (saved.modifiedTime) cloudState.lastSeenModifiedTime = saved.modifiedTime; // don't re-download our own write
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
        cloudState.lastEditAt = cloudState.lastSyncedAt;
        if (remote.modifiedTime) cloudState.lastSeenModifiedTime = remote.modifiedTime;
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
    startCloudPoll();
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
    cloudState.lastEditAt = cloudState.lastSyncedAt;
    if (remote.modifiedTime) cloudState.lastSeenModifiedTime = remote.modifiedTime;
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
  stopCloudPoll();
  cloudState.enabled = false;
  cloudState.fileId = '';
  cloudState.lastSyncedAt = '';
  cloudState.lastEditAt = '';
  cloudState.lastSeenModifiedTime = '';
  cloudState.pendingBackup = false;
  cloudState.backupFailed = false;
  gisToken = null;
  calToken = null;
  // Auto-add-to-calendar depends on this Google account; turn it off on disconnect
  // so it doesn't silently try (and fail) after re-connecting a different account.
  settings.autoAddCalendar = false; settings.calendarEmail = ''; saveSettings();
  saveCloudState();
  updateCloudUI();
  toast('已解除雲端連結（雲端資料保留）。');
}

// Wipe this device's notes/tasks/attachments (local only — no Drive files are
// touched). Persists quietly; the caller decides whether to back up afterwards.
async function clearAllLocalData() {
  state = structuredClone(defaultState);
  try { await idbClearBlobs(); } catch (e) { /* ignore */ }
  cacheMeta = {}; saveCacheMeta(); // the cache index must not outlive its blobs
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
    calToken = null;
    settings.autoAddCalendar = false; settings.calendarEmail = ''; saveSettings(); // must re-consent for the new account
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
      cloudState.lastEditAt = cloudState.lastSyncedAt;
      if (remote.modifiedTime) cloudState.lastSeenModifiedTime = remote.modifiedTime;
      cloudState.pendingBackup = false;
      cloudState.backupFailed = false;
      saveCloudState();
      toast('已更換帳號並從雲端還原 ✓');
    } else {
      cloudState.lastSeenModifiedTime = '';
      saveCloudState();
      render();
      await cloudBackupNow({}); // seed an (empty) backup file for the new account
      toast('已更換帳號（新帳號無雲端備份，保持空白）✓');
    }
    updateCloudUI();
    startCloudPoll();
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

// Is the user actively typing/editing right now? Used to avoid yanking data out
// from under them when an auto-download would re-render the page.
function isEditingNow() {
  const a = document.activeElement;
  if (!a) return false;
  const tag = a.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || a.isContentEditable;
}

// The heart of automatic sync. Runs on load, on foreground, on a timer while the
// app is open, and from the header 🔄 button. It:
//   1. cheaply checks the cloud file's modifiedTime,
//   2. if the cloud changed, downloads it and applies it when it's newer than the
//      local data (latest-wins, no prompt) — unless the user is mid-edit,
//   3. otherwise pushes any pending local changes up.
// Silent by default (opts.manual → show a toast with the outcome).
async function cloudAutoSync(opts) {
  opts = opts || {};
  if (!cloudState.enabled || !GOOGLE_CLIENT_ID) return 'off';
  if (cloudSyncing && !opts.manual) return 'busy';
  cloudSyncing = true;
  try {
    // Auto-sync stays silent. A MANUAL sync is a user gesture, so if a silent
    // token can't be issued (session expired / third-party cookies blocked) we
    // fall back to an interactive prompt — that's how the button recovers the
    // "Google 授權未完成" state without making the user re-connect in 設定.
    if (opts.manual) {
      try { await getAccessToken('none'); }
      catch (e) { gisToken = null; await getAccessToken(''); }
    }
    const remote = await driveFindFile(CLOUD_FILENAME, 'none');
    if (!remote) {
      // Nothing in the cloud yet — create it from this device.
      if (cloudState.pendingBackup || cloudState.backupFailed || opts.manual) await cloudBackupNow(opts.manual ? { manual: true } : {});
      return 'nocloud';
    }
    cloudState.fileId = remote.id;
    const cloudChanged = remote.modifiedTime && remote.modifiedTime !== cloudState.lastSeenModifiedTime;

    if (!cloudChanged) {
      // Cloud is exactly what we last saw. Just push local changes if any.
      if (cloudState.pendingBackup || cloudState.backupFailed) { await cloudBackupNow(opts.manual ? { manual: true } : {}); return 'uploaded'; }
      if (opts.manual) toast('已是最新，無需同步 ✓');
      return 'insync';
    }

    // Cloud changed since we last processed it — fetch it and decide direction.
    const bundle = await driveDownload(remote.id);
    const fromOther = bundle.deviceId !== cloudState.deviceId;
    const remoteTime = bundle.updatedAt ? new Date(bundle.updatedAt).getTime() : 0;
    const localTime = new Date(cloudState.lastEditAt || cloudState.lastSyncedAt || 0).getTime();

    if (!fromOther) {
      // It's our own upload we simply hadn't recorded — adopt the marker, no loop.
      cloudState.lastSeenModifiedTime = remote.modifiedTime;
      if (bundle.updatedAt) cloudState.lastSyncedAt = bundle.updatedAt;
      saveCloudState();
      if (cloudState.pendingBackup || cloudState.backupFailed) { await cloudBackupNow(opts.manual ? { manual: true } : {}); return 'uploaded'; }
      if (opts.manual) toast('已是最新，無需同步 ✓');
      return 'insync';
    }

    // Cloud has data from ANOTHER device. Latest-wins: apply it unless our local
    // edits are newer (then upload ours instead).
    const localIsNewer = cloudState.pendingBackup && localTime > remoteTime;
    if (localIsNewer) {
      await cloudBackupNow(opts.manual ? { manual: true } : {});
      return 'uploaded';
    }
    if (isEditingNow() && !opts.manual) return 'deferred'; // don't disrupt active typing; try next cycle
    applyBundle(bundle);
    cloudState.lastSyncedAt = bundle.updatedAt || new Date().toISOString();
    cloudState.lastEditAt = cloudState.lastSyncedAt;
    cloudState.lastSeenModifiedTime = remote.modifiedTime;
    cloudState.pendingBackup = false;
    cloudState.backupFailed = false;
    saveCloudState();
    updateCloudUI();
    if (opts.manual) toast('已同步雲端最新資料 ✓'); else toast('已自動同步其他裝置的更新 ✓');
    return 'downloaded';
  } catch (e) {
    if (opts.manual) {
      const msg = (e && e.message) || String(e);
      toast(/授權|token|401|403/i.test(msg)
        ? '同步失敗：Google 授權已失效。請在彈出的視窗完成授權，或到設定重新連結帳號。'
        : '同步失敗：' + msg);
    }
    return 'error';
  } finally {
    cloudSyncing = false;
  }
}
// Kept as the name used at load/foreground; now just the auto-sync entry point.
function cloudCheckOnOpen() { return cloudAutoSync({}); }

function startCloudPoll() {
  stopCloudPoll();
  if (!cloudState.enabled || !GOOGLE_CLIENT_ID) return;
  cloudPollTimer = setInterval(() => {
    if (!document.hidden) cloudAutoSync({});
  }, CLOUD_POLL_MS);
}
function stopCloudPoll() {
  if (cloudPollTimer) { clearInterval(cloudPollTimer); cloudPollTimer = null; }
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
  // Header 🔄 手動同步 button: only useful once connected.
  if (els.syncBtn) els.syncBtn.hidden = !(configured && cloudState.enabled);
  if (!configured) return;
  const on = cloudState.enabled;
  els.cloudDisconnected.hidden = on;
  els.cloudConnected.hidden = !on;
  els.cloudStatus.classList.remove('cloud-warn');
  if (on) {
    let s;
    if (cloudState.backupFailed) { s = '⚠ 有變更尚未成功備份，請按「立即備份」或「🔄 同步」。'; els.cloudStatus.classList.add('cloud-warn'); }
    else if (cloudState.pendingBackup) s = '有變更待備份…（自動同步中）';
    else if (cloudState.lastSyncedAt) s = '自動同步已開啟。上次同步：' + fmtSyncTime(cloudState.lastSyncedAt);
    else s = '已連結，自動同步已開啟。';
    if (cloudState.email) s += `\n帳號：${cloudState.email}`;
    els.cloudStatus.textContent = s;
    refreshCacheUsage();
    refreshDriveQuota(); // async; fills in when it returns
  }
}

// Show how much local space the attachment cache is using vs its budget.
function refreshCacheUsage() {
  if (!els.cacheUsage) return;
  const used = cachedTotalBytes();
  const budget = cacheBudgetBytes();
  const cap = isFinite(budget) ? `／上限 ${fmtSize(budget)}` : '（不限制）';
  const n = Object.keys(cacheMeta).length;
  els.cacheUsage.textContent = ` 目前本機快取：${fmtSize(used)}${cap}，共 ${n} 個檔案。`;
}

// Read the connected account's Drive storage quota so the user can judge whether
// a large total (e.g. 10GB of attachments) will fit. Best-effort + cached briefly.
let _quotaAt = 0, _quotaText = '';
async function refreshDriveQuota() {
  if (!els.driveQuota || !cloudState.enabled) return;
  if (_quotaText && Date.now() - _quotaAt < 60000) { els.driveQuota.textContent = _quotaText; return; }
  try {
    const res = await driveFetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota', {});
    if (!res.ok) return;
    const q = (await res.json()).storageQuota || {};
    const used = Number(q.usage || 0);
    if (q.limit) {
      const limit = Number(q.limit);
      const free = Math.max(0, limit - used);
      _quotaText = `☁ Drive 空間：已用 ${fmtSize(used)}／共 ${fmtSize(limit)}，剩 ${fmtSize(free)}。`;
    } else {
      _quotaText = `☁ Drive 空間：已用 ${fmtSize(used)}（此帳號未回報總量上限）。`;
    }
    _quotaAt = Date.now();
    els.driveQuota.textContent = _quotaText;
  } catch (e) { /* best-effort */ }
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
function closeExpenses() {
  stopInvScan();
  if (els.invResult) els.invResult.hidden = true;
  els.expenseModal.hidden = true;
}

// Shared attachment-help modal, opened from the input area and task cards.
function openAttachHelp() { if (els.attachHelpModal) els.attachHelpModal.hidden = false; }
function closeAttachHelp() { if (els.attachHelpModal) els.attachHelpModal.hidden = true; }
function openHelp() { if (els.helpModal) els.helpModal.hidden = false; }
function closeHelp() { if (els.helpModal) els.helpModal.hidden = true; }

// Input modal (新增記事) — the input card + drafts area now live here, opened
// from the header ✏️ button so the homepage shows only tasks and categories.
function openInputModal() {
  if (!els.inputModal) return;
  renderDrafts();
  els.inputModal.hidden = false;
  setTimeout(() => { if (els.inputText) els.inputText.focus(); }, 50);
}
function closeInputModal() {
  if (recognizing) stopRecording();
  if (els.inputModal) els.inputModal.hidden = true;
}

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

/* ---------------- 掃描電子發票 QR 記帳 ---------------- */
// The paper 電子發票證明聯 carries two QR codes. The LEFT one holds a fixed
// 77-char ASCII header (invoice number, date, sales/total amount in hex,
// buyer/seller 統編, an AES check block) followed by the item list; the RIGHT
// one continues the item list, or is just "**" when the full detail lives only
// on the MOF platform. We parse it all locally — no API, no key, nothing leaves
// the device. Only works where the browser has a native QR BarcodeDetector
// (Android Chrome etc.); iOS Safari lacks it, so the section stays hidden.
let invScanStream = null;   // live MediaStream while the camera is open
let invScanTimer = null;    // setTimeout handle for the detect loop
let invDetector = null;     // cached BarcodeDetector instance
let invLeft = '';           // captured left-QR raw string
let invRight = '';          // captured right-QR raw string

async function invScanSupported() {
  if (!('BarcodeDetector' in window)) return false;
  try {
    const fmts = await window.BarcodeDetector.getSupportedFormats();
    return Array.isArray(fmts) && fmts.includes('qr_code');
  } catch { return false; }
}

// The left QR always starts with the invoice number (2 letters + 8 digits) then
// the 7-digit ROC date, and is at least 77 chars. Anything else we treat as the
// right/continuation QR.
function isLeftQR(s) {
  return typeof s === 'string' && s.length >= 77 && /^[A-Z]{2}\d{8}\d{7}/.test(s);
}

function minguoToISO(d) {
  if (!/^\d{7}$/.test(d)) return '';
  const y = parseInt(d.slice(0, 3), 10) + 1911;
  const m = d.slice(3, 5), day = d.slice(5, 7);
  if (+m < 1 || +m > 12 || +day < 1 || +day > 31) return '';
  return `${y}-${m}-${day}`;
}

// Item names may arrive as UTF-8 (already valid CJK) or as Big5 bytes the
// detector handed back byte-for-byte (looks like Latin1 mojibake) — recover the
// latter via a Big5 TextDecoder. English-only names pass through untouched.
function decodeInvName(s) {
  if (typeof s !== 'string') return '';
  s = s.trim();
  if (!s) return '';
  if (/[一-鿿＀-￯]/.test(s)) return s;
  try {
    const bytes = Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
    const dec = new TextDecoder('big5', { fatal: false }).decode(bytes);
    const cleaned = dec.replace(/�/g, '').trim();
    if (/[一-鿿]/.test(cleaned)) return cleaned;
  } catch { /* ignore, fall through */ }
  return s;
}

// Item section = left[77:] + right (minus a leading "**"), colon-delimited as
// barcodeItemCount:invoiceItemCount:encoding:name:qty:price:name:qty:price:...
// "**" on its own means the detail was not embedded in the QR.
function parseInvItems(leftRest, right) {
  let prod = leftRest || '';
  if (right && right !== '**') prod += right.startsWith('**') ? right.slice(2) : right;
  prod = prod.replace(/^:+/, '');
  if (!prod) return [];
  const toks = prod.split(':');
  if (toks.length < 6) return [];           // need at least the 3 headers + 1 triple
  const rest = toks.slice(3);               // drop the two counts + encoding param
  const items = [];
  for (let i = 0; i + 2 < rest.length; i += 3) {
    const name = decodeInvName(rest[i]);
    const qty = parseInt(rest[i + 1], 10);
    const price = Number(rest[i + 2]);
    if (!name || !isFinite(price)) continue;
    items.push({ name, qty: isFinite(qty) && qty > 0 ? qty : 1, price });
  }
  return items;
}

function parseEinvoiceQR(left, right) {
  if (!isLeftQR(left)) return null;
  const total = parseInt(left.slice(29, 37), 16);
  return {
    invNum: left.slice(0, 10),
    date: minguoToISO(left.slice(10, 17)),
    total: isFinite(total) ? total : 0,
    sellerBAN: left.slice(45, 53),
    items: parseInvItems(left.slice(77), right),
  };
}

function updateInvScanStatus() {
  if (!els.invScanStatus) return;
  const l = invLeft ? '左碼 ✓' : '左碼 …';
  const r = invRight ? '右碼 ✓' : '右碼（明細，可略）';
  els.invScanStatus.textContent = `對準發票上的 QR：${l}　${r}`;
  if (els.invScanDone) els.invScanDone.disabled = !invLeft;
}

function invScanTick() {
  invScanTimer = setTimeout(async () => {
    if (!invScanStream) return;
    try {
      const codes = await invDetector.detect(els.invVideo);
      let got = false;
      for (const c of codes) {
        const v = (c.rawValue || '').trim();
        if (!v) continue;
        if (isLeftQR(v)) { if (invLeft !== v) { invLeft = v; got = true; } }
        else if (invRight !== v) { invRight = v; got = true; }
      }
      if (got) {
        if (navigator.vibrate) navigator.vibrate(40);
        updateInvScanStatus();
      }
      if (invLeft && invRight) { finishInvScan(); return; }  // auto-finish once both are in
    } catch { /* transient decode error — keep scanning */ }
    invScanTick();
  }, 250);
}

async function startInvScan() {
  invLeft = ''; invRight = '';
  if (els.invResult) { els.invResult.hidden = true; els.invResult.innerHTML = ''; }
  try {
    invDetector = invDetector || new window.BarcodeDetector({ formats: ['qr_code'] });
    invScanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
  } catch (err) {
    toast('無法開啟相機：' + ((err && err.message) ? err.message : '請確認已允許相機權限'));
    return;
  }
  els.invVideo.srcObject = invScanStream;
  try { await els.invVideo.play(); } catch { /* autoplay quirks — ignore */ }
  els.invScanBox.hidden = false;
  els.invScanBtn.hidden = true;
  updateInvScanStatus();
  invScanTick();
}

function stopInvScan() {
  if (invScanTimer) { clearTimeout(invScanTimer); invScanTimer = null; }
  if (invScanStream) { invScanStream.getTracks().forEach((t) => t.stop()); invScanStream = null; }
  if (els.invVideo) els.invVideo.srcObject = null;
  if (els.invScanBox) els.invScanBox.hidden = true;
  if (els.invScanBtn) els.invScanBtn.hidden = false;
}

function cancelInvScan() {
  stopInvScan();
  if (els.invResult) els.invResult.hidden = true;
}

function finishInvScan() {
  stopInvScan();
  const parsed = parseEinvoiceQR(invLeft, invRight);
  if (!parsed) { toast('沒讀到有效的電子發票 QR（請對準左邊那個較長的 QR code）。'); return; }
  showInvResult(parsed);
}

function showInvResult(p) {
  const box = els.invResult;
  box.hidden = false;
  box.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'inv-result-head';
  head.textContent = `發票 ${p.invNum}　${p.date || '日期未知'}　總計 ${fmtMoney(p.total)}`;
  box.appendChild(head);

  const hasItems = p.items.length > 0;
  const listWrap = document.createElement('div');
  listWrap.className = 'inv-result-items';
  if (hasItems) {
    for (const it of p.items) {
      const row = document.createElement('div');
      row.className = 'inv-item-row';
      const name = document.createElement('span'); name.textContent = it.name;
      const qty = document.createElement('span'); qty.className = 'inv-item-qty'; qty.textContent = '×' + it.qty;
      const amt = document.createElement('span'); amt.className = 'inv-item-amt'; amt.textContent = fmtMoney(it.price * it.qty);
      row.appendChild(name); row.appendChild(qty); row.appendChild(amt);
      listWrap.appendChild(row);
    }
  } else {
    const none = document.createElement('p');
    none.className = 'field-note';
    none.textContent = '這張發票的 QR 沒有內含品項明細（可能品項太多，明細只上傳到財政部平台）。可改用「整張記一筆」記錄總金額。';
    listWrap.appendChild(none);
  }
  box.appendChild(listWrap);

  const actions = document.createElement('div');
  actions.className = 'inv-result-actions';
  if (hasItems) {
    const bItems = document.createElement('button');
    bItems.className = 'primary-btn'; bItems.type = 'button';
    bItems.textContent = `逐項記帳（${p.items.length} 筆）`;
    bItems.addEventListener('click', () => commitInvItems(p));
    actions.appendChild(bItems);
  }
  const bTotal = document.createElement('button');
  bTotal.className = hasItems ? 'ghost-btn' : 'primary-btn'; bTotal.type = 'button';
  bTotal.textContent = '整張記一筆';
  bTotal.addEventListener('click', () => commitInvTotal(p));
  actions.appendChild(bTotal);

  const bRescan = document.createElement('button');
  bRescan.className = 'ghost-btn'; bRescan.type = 'button';
  bRescan.textContent = '重新掃描';
  bRescan.addEventListener('click', () => { box.hidden = true; startInvScan(); });
  actions.appendChild(bRescan);

  box.appendChild(actions);
}

function invAlreadyRecorded(invNum) {
  return state.expenses.some((e) => e.inv && e.inv === invNum);
}

// Scanned records are pushed directly (not through appendExpenses) so identical
// line items within one invoice aren't collapsed, and so we can tag each with
// its source invoice number.
function commitInvItems(p) {
  if (invAlreadyRecorded(p.invNum) && !confirm('這張發票先前已掃描記帳過，仍要再加入一次嗎？')) return;
  const date = p.date || todayStr();
  let n = 0;
  for (const it of p.items) {
    state.expenses.push({
      id: 'ex_' + genId(),
      item: it.name,
      amount: Math.round(it.price * it.qty * 100) / 100,
      date,
      category: '其他',
      createdAt: todayStr(),
      inv: p.invNum,
    });
    n++;
  }
  finalizeInvCommit(`已加入 ${n} 筆消費（發票 ${p.invNum}）。可在下方明細調整分類。`);
}

function commitInvTotal(p) {
  if (invAlreadyRecorded(p.invNum) && !confirm('這張發票先前已掃描記帳過，仍要再加入一次嗎？')) return;
  state.expenses.push({
    id: 'ex_' + genId(),
    item: `發票 ${p.invNum}`,
    amount: Math.round((p.total || 0) * 100) / 100,
    date: p.date || todayStr(),
    category: '其他',
    createdAt: todayStr(),
    inv: p.invNum,
  });
  finalizeInvCommit(`已記入一筆 ${fmtMoney(p.total)}（發票 ${p.invNum}）。`);
}

function finalizeInvCommit(msg) {
  saveState();
  if (els.invResult) els.invResult.hidden = true;
  renderExpenses();
  render();
  toast(msg);
}

if (els.invScanBtn) els.invScanBtn.addEventListener('click', startInvScan);
if (els.invScanCancel) els.invScanCancel.addEventListener('click', cancelInvScan);
if (els.invScanDone) els.invScanDone.addEventListener('click', () => { if (invLeft) finishInvScan(); });
// Reveal the scan UI only where a native QR detector exists (hidden on iOS).
invScanSupported().then((ok) => { if (ok && els.invScanSection) els.invScanSection.hidden = false; });

// Input modal (新增記事)
if (els.addInputBtn) els.addInputBtn.addEventListener('click', openInputModal);
if (els.closeInputBtn) els.closeInputBtn.addEventListener('click', closeInputModal);
if (els.inputModal) els.inputModal.addEventListener('click', (e) => {
  if (e.target === els.inputModal) closeInputModal();
});
{ const b = $('emptyAddInputBtn'); if (b) b.addEventListener('click', openInputModal); }

// Header 🔄 手動同步 — compare with cloud and sync to whichever is newest.
if (els.syncBtn) els.syncBtn.addEventListener('click', async () => {
  els.syncBtn.disabled = true;
  els.syncBtn.classList.add('spinning');
  try { await cloudAutoSync({ manual: true }); }
  finally { els.syncBtn.disabled = false; els.syncBtn.classList.remove('spinning'); }
});

// Attachment help modal
if (els.attachHelpBtn) els.attachHelpBtn.addEventListener('click', openAttachHelp);
if (els.closeAttachHelpBtn) els.closeAttachHelpBtn.addEventListener('click', closeAttachHelp);
if (els.attachHelpDoneBtn) els.attachHelpDoneBtn.addEventListener('click', closeAttachHelp);
if (els.attachHelpModal) els.attachHelpModal.addEventListener('click', (e) => {
  if (e.target === els.attachHelpModal) closeAttachHelp();
});

// Usage guide modal
if (els.helpBtn) els.helpBtn.addEventListener('click', openHelp);
if (els.closeHelpBtn) els.closeHelpBtn.addEventListener('click', closeHelp);
if (els.helpDoneBtn) els.helpDoneBtn.addEventListener('click', closeHelp);
if (els.helpModal) els.helpModal.addEventListener('click', (e) => {
  if (e.target === els.helpModal) closeHelp();
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
  if (els.cacheBudgetSelect) els.cacheBudgetSelect.value = settings.cacheBudgetMB || '500';
  if (els.autoCalToggle) els.autoCalToggle.checked = !!settings.autoAddCalendar;
  updateCalAccountNote();
  // Credential group: collapsed by default (keeps the sensitive fields tucked
  // away); auto-expanded only when nothing is configured yet, so first-time
  // setup is visible.
  if (els.credGroup) {
    const configured = !!(settings.apiKey || settings.workerUrl || settings.accessCode);
    els.credGroup.open = !configured;
    if (els.credStatus) els.credStatus.textContent = configured ? '已設定 ✓' : '尚未設定';
  }
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
  const newApiKey = els.apiKeyInput.value.trim();
  const newWorkerUrl = els.workerUrlInput.value.trim();
  const newAccessCode = els.accessCodeInput.value.trim();

  // Warn only when CHANGING an already-set credential (not when adding one for
  // the first time). Clearing an existing value counts as a change too. This
  // guards against accidentally breaking the connection to Claude.
  const changed = [];
  const isChange = (oldVal, newVal) => oldVal && newVal !== oldVal;
  if (isChange(settings.apiKey, newApiKey)) changed.push('Anthropic API 金鑰');
  if (isChange(settings.workerUrl, newWorkerUrl)) changed.push('共用中繼站網址');
  if (isChange(settings.accessCode, newAccessCode)) changed.push('中繼站存取碼');
  if (changed.length) {
    const ok = confirm(
      `你正在變更以下已設定的項目：\n・${changed.join('\n・')}\n\n` +
      '改錯可能導致無法呼叫 Claude（整理會失敗）。確定要變更嗎？'
    );
    if (!ok) return; // abort save; keep the modal open with the typed values
  }

  settings.apiKey = newApiKey;
  settings.workerUrl = newWorkerUrl;
  settings.accessCode = newAccessCode;
  settings.model = els.modelSelect.value;
  settings.autoDeleteDays = els.autoDeleteSelect.value;
  if (els.cacheBudgetSelect) settings.cacheBudgetMB = els.cacheBudgetSelect.value;
  saveSettings();
  closeSettings();
  enforceCacheBudget().catch(() => {}); // apply a newly-lowered cache cap right away
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
// Auto-add-to-calendar toggle. Enabling requests calendar consent RIGHT NOW (this
// change is a user gesture — the only time the GIS popup can open reliably); the
// setting is only saved as on once consent succeeds, so a later background 整理 can
// get a silent token. Disabling just clears the flag.
if (els.autoCalToggle) els.autoCalToggle.addEventListener('change', async () => {
  if (!els.autoCalToggle.checked) {
    settings.autoAddCalendar = false;
    saveSettings();
    toast('已關閉「整理時自動加入行事曆」');
    return;
  }
  if (!cloudState.enabled) {
    els.autoCalToggle.checked = false;
    toast('請先連結 Google 帳號，才能自動加入行事曆。');
    return;
  }
  try {
    await ensureCalendarScope(); // interactive account chooser + consent within this gesture
  } catch (e) {
    els.autoCalToggle.checked = false;
    settings.autoAddCalendar = false;
    settings.calendarEmail = '';
    saveSettings();
    toast(e.message || '行事曆授權未完成，未開啟自動加入。');
    return;
  }
  settings.autoAddCalendar = true;
  settings.calendarEmail = await fetchCalEmail(); // remember & show which account gets the events
  saveSettings();
  updateCalAccountNote();
  els.autoCalToggle.checked = true;
  const acct = settings.calendarEmail ? `帳號：${settings.calendarEmail}` : '你剛才選擇的帳號';
  const diff = settings.calendarEmail && cloudState.email && settings.calendarEmail !== cloudState.email
    ? `\n（注意：與備份帳號 ${cloudState.email} 不同——事件只會出現在 ${settings.calendarEmail} 的行事曆）` : '';
  toast(`已開啟：整理時有截止日的新任務會加入行事曆 📅\n${acct}${diff}`);
});
if (els.calTestBtn) els.calTestBtn.addEventListener('click', testCalendarWrite);
if (els.cacheClearBtn) els.cacheClearBtn.addEventListener('click', async () => {
  const pending = state.attachments.filter((a) => !a.driveFileId && cacheMeta[a.id]).length;
  const extra = pending ? `\n（有 ${pending} 個附件尚未上傳雲端，會保留、不清除。）` : '';
  if (!confirm(`清空本機的附件快取？\n只清「已在雲端」的本機副本，需要時會自動重新下載。${extra}`)) return;
  const freed = await clearCloudBackedCache();
  refreshCacheUsage();
  toast(freed ? `已清出 ${fmtSize(freed)} 本機空間 ✓` : '沒有可清除的快取。');
});

/* ---------------- Wire up ---------------- */
els.processBtn.addEventListener('click', processInput);
if (els.stashBtn) els.stashBtn.addEventListener('click', stashDraft);
if (els.tabTasks) els.tabTasks.addEventListener('click', () => setPage('tasks'));
if (els.tabNotes) els.tabNotes.addEventListener('click', () => setPage('notes'));
$('addCatBtn').addEventListener('click', addCategory);
$('emptyAddCatBtn').addEventListener('click', () => { setPage('notes'); addCategory(); });
els.clearBtn.addEventListener('click', async () => {
  if (!confirm('清空所有筆記與任務？此動作無法復原。')) return;
  // Best-effort: also drop the Drive copies of every attachment so cleared files
  // don't linger in the cloud, then wipe local blobs + the cache index.
  if (cloudState.enabled) {
    for (const a of state.attachments) if (a.driveFileId) driveDelete(a.driveFileId).catch(() => {});
  }
  state = structuredClone(defaultState);
  try { await idbClearBlobs(); } catch (e) { /* ignore */ }
  cacheMeta = {}; saveCacheMeta();
  saveState();
  render();
});

const appVersionEl = $('appVersion');
if (appVersionEl) appVersionEl.textContent = APP_VERSION;

pruneCompletedTasks();
render();
updateCloudUI();
cloudAutoSync({});   // pull newer data / push pending on startup
startCloudPoll();    // then keep checking every CLOUD_POLL_MS while the app is open

// On foreground: prune, re-check the cloud immediately, and resume polling.
// On background: pause polling and flush any pending backup (best-effort).
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    pruneCompletedTasks();
    render();
    cloudAutoSync({});
    startCloudPoll();
  } else {
    stopCloudPoll();
    if (cloudState.enabled && (cloudState.pendingBackup || cloudState.backupFailed)) cloudBackupNow({});
  }
});

/* ---------------- Service worker ---------------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* ignore */ });
  });
}
