/* Service worker: orkestrasi. Deteksi model lokal -> pindai form (semua frame) -> minta LLM -> rapikan -> isi -> tampilkan ringkasan. */
importScripts('lib/heuristics.js', 'lib/prompt.js', 'lib/providers.js', 'lib/settings.js');

const { heuristics: H, prompt: P, providers: PR, settings: S } = self.AIFF;
const ENGINE_FILES = ['content/engine.js', 'content/panel.js'];
let lastRun = {}; // tabId -> { mode, itemsByFrame }

// ── Ollama menolak Origin chrome-extension:// (403). Buang header Origin HANYA untuk permintaan milik service worker ini (tabId -1)
//    ke localhost, supaya halaman web lain tidak ikut terpengaruh.
async function installOriginRule() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1],
      addRules: [{
        id: 1, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
        condition: { regexFilter: '^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?/', resourceTypes: ['xmlhttprequest', 'other'], tabIds: [-1] },
      }],
    });
  } catch (e) { console.warn('DNR rule gagal', e); }
}
function installMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'aifill-field', title: 'Isi field ini dengan AI', contexts: ['editable'] });
    chrome.contextMenus.create({ id: 'aifill-page', title: 'Isi seluruh form halaman ini dengan AI', contexts: ['page', 'editable'] });
  });
}
chrome.runtime.onInstalled.addListener(() => { installOriginRule(); installMenus(); });
chrome.runtime.onStartup.addListener(() => { installOriginRule(); });
installOriginRule();

// ── pemanggil ───────────────────────────────────────────────────────────────
chrome.commands.onCommand.addListener(async (cmd) => {
  const tab = await activeTab(); if (!tab) return;
  if (cmd === 'fill-page') runFill(tab.id, {});
  if (cmd === 'undo-fill') runUndo(tab.id);
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  if (info.menuItemId === 'aifill-field') runFill(tab.id, { onlyElement: true, overwrite: true });
  if (info.menuItemId === 'aifill-page') runFill(tab.id, {});
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'detect') return sendResponse({ ok: true, data: await detectAll(true) });
      if (msg.type === 'warmup') {
        const s = await S.get();
        try { const r = await resolveModel(s); return sendResponse({ ok: true, data: await PR.warmup(r.endpoint, r.model) }); } catch (e) { return sendResponse({ ok: true, data: false }); }
      }
      const tabId = msg.tabId || (sender.tab && sender.tab.id) || (await activeTab() || {}).id;
      if (msg.type === 'fill') return sendResponse({ ok: true, data: await runFill(tabId, msg.opts || {}) });
      if (msg.type === 'undo') return sendResponse({ ok: true, data: await runUndo(tabId) });
      if (msg.type === 'fixErrors') return sendResponse({ ok: true, data: await runFix(tabId) });
      if (msg.type === 'panelAction') {
        if (msg.action === 'undo') await runUndo(tabId);
        else if (msg.action === 'fix') await runFix(tabId);
        else if (msg.action === 'refill') await runFill(tabId, Object.assign({ overwrite: true }, lastRun[tabId] && lastRun[tabId].opts));
        return sendResponse({ ok: true });
      }
      sendResponse({ ok: false, error: 'pesan tidak dikenal' });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true;
});

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// ── deteksi endpoint & model ────────────────────────────────────────────────
async function detectAll(force) {
  const s = await S.get();
  const cacheKey = 'detectCache';
  if (!force) {
    const c = (await chrome.storage.session.get(cacheKey))[cacheKey];
    if (c && Date.now() - c.at < 20000) return c.data;
  }
  const endpoints = s.endpoints.length ? s.endpoints : PR.DEFAULT_ENDPOINTS;
  const found = await PR.detect(endpoints, 1800);
  const data = found.map((f) => ({ endpoint: f.endpoint, models: f.models, recommended: (PR.recommend(f.models) || {}).id || null }));
  await chrome.storage.session.set({ [cacheKey]: { at: Date.now(), data } });
  return data;
}
async function resolveModel(s) {
  const all = await detectAll(false);
  if (!all.length) throw new Error('Tidak ada server LLM lokal yang terdeteksi (coba Ollama: pastikan sedang berjalan).');
  let entry = s.endpointId ? all.find((a) => a.endpoint.id === s.endpointId) : null;
  if (!entry) entry = all[0];
  let model = s.model && entry.models.some((m) => m.id === s.model) ? s.model : entry.recommended;
  if (!model) throw new Error('Server ' + entry.endpoint.name + ' aktif tetapi belum ada model yang bisa dipakai.');
  return { endpoint: entry.endpoint, model };
}

// ── persona konsisten antar halaman ─────────────────────────────────────────
async function getPersona(s) {
  if (s.keepPersona) {
    const c = (await chrome.storage.session.get('persona')).persona;
    if (c && Date.now() - c.at < 30 * 60 * 1000) return c.value;
  }
  const seed = s.seed !== '' && Number.isFinite(Number(s.seed)) ? Number(s.seed) : Date.now() % 1e9;
  const value = H.persona(seed);
  await chrome.storage.session.set({ persona: { at: Date.now(), value } });
  return value;
}

// ── inti ────────────────────────────────────────────────────────────────────
async function injectEngine(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ENGINE_FILES });
}
function frameResults(results) { return (results || []).filter((r) => r && r.result); }
async function panel(tabId, state) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: (st) => window.__aiFillPanel && window.__aiFillPanel.show(st), args: [state] });
  } catch (e) { /* tab khusus (chrome://) tidak bisa disuntik */ }
}
function hostOf(url) { try { return new URL(url).host; } catch (e) { return ''; } }

async function llmFill(s, fields, page, mode, persona, userNotes, fixes) {
  const { endpoint, model } = await resolveModel(s);
  const schema = P.buildSchema(fields, mode);
  const messages = P.buildMessages({ fields, page, mode, locale: s.locale, persona, siteNotes: userNotes, userContext: s.userContext, fixes });
  const raw = await PR.chatJson(endpoint, model, messages, { temperature: s.temperature, schema, timeoutMs: s.timeoutSec * 1000 });
  const values = P.parseResponse(raw);
  if (!values) throw new Error('Jawaban model tidak bisa dibaca sebagai JSON.');
  return { values, model, endpoint };
}

async function runFill(tabId, overrides) {
  const s = Object.assign(await S.get(), overrides || {});
  const tab = await chrome.tabs.get(tabId);
  const host = hostOf(tab.url);
  if (!/^https?:|^file:/.test(tab.url || '')) { return { error: 'Halaman ini tidak bisa diisi (halaman khusus browser).' }; }
  if (!S.hostAllowed(s, host)) {
    await panel(tabId, { status: 'err', title: 'Situs tidak diizinkan', message: host + ' tidak ada di daftar situs yang diizinkan (Opsi).', autoHideMs: 5000 });
    return { error: 'host tidak diizinkan' };
  }
  await injectEngine(tabId);
  await panel(tabId, { status: 'busy', title: 'Memindai form…', message: 'Membaca field di halaman ini.' });

  const scanOpts = { scope: 'auto', overwrite: !!s.overwrite, includePassword: !!s.includePassword, onlyElement: !!overrides.onlyElement };
  const scans = frameResults(await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: (o) => window.__aiFill.scan(o), args: [scanOpts] }));

  // id global g1.. -> { frameId, localId }
  const map = {}; const fields = []; let n = 0; let page = null; const skipped = [];
  for (const fr of scans) {
    if (!page || fr.frameId === 0) page = fr.result.page;
    skipped.push(...fr.result.skipped);
    for (const f of fr.result.fields) {
      const gid = 'g' + (++n);
      map[gid] = { frameId: fr.frameId, localId: f.id };
      fields.push(Object.assign({}, f, { id: gid }));
    }
  }
  if (!fields.length) {
    await panel(tabId, { status: 'ok', title: 'Tidak ada yang perlu diisi', message: s.overwrite ? 'Tidak ada field terlihat.' : 'Semua field terlihat sudah terisi (aktifkan "Timpa" untuk mengisi ulang).', autoHideMs: 4000 });
    return { filled: 0 };
  }

  const mode = s.mode;
  const persona = await getPersona(s);
  const seed = s.seed !== '' && Number.isFinite(Number(s.seed)) ? Number(s.seed) : Date.now() % 1e9;
  const ctx = { mode, rng: H.makeRng(seed), persona, today: new Date() };
  const siteNotes = (s.siteNotes && s.siteNotes[host]) || '';

  await panel(tabId, { status: 'busy', title: 'Menunggu AI…', message: fields.length + ' field · mode ' + (P.MODES[mode] || P.MODES.realistic).label });
  const aiValues = {}; let usedModel = ''; let aiError = '';
  // Strategi cepat: field yang jelas (nama, email, telepon, angka, tanggal, centang) cukup dari generator lokal; AI hanya untuk
  // pilihan, teks bebas, dan field yang labelnya tidak dikenali.
  const needsAI = (f) => s.strategy !== 'hybrid' || ['select', 'radio', 'multiselect', 'combobox', 'textarea'].includes(f.kind) || !H.classify(f) || ['notes', 'product', 'code'].includes(H.classify(f));
  const aiFields = fields.filter(needsAI);
  for (let i = 0; i < aiFields.length; i += s.chunkSize) {
    const chunk = aiFields.slice(i, i + s.chunkSize);
    try {
      const r = await llmFill(s, chunk, page || {}, mode, persona, siteNotes, null);
      Object.assign(aiValues, r.values); usedModel = r.model;
    } catch (e) { aiError = String(e && e.message || e); }
  }

  const resolved = P.resolveValues(fields, aiValues, ctx);
  const byFrame = {};
  for (const r of resolved) { const m = map[r.id]; (byFrame[m.frameId] = byFrame[m.frameId] || []).push({ id: m.localId, value: r.value, source: r.source }); }
  const applied = [];
  for (const [frameId, items] of Object.entries(byFrame)) {
    const out = await chrome.scripting.executeScript({ target: { tabId, frameIds: [Number(frameId)] }, func: (it, o) => window.__aiFill.apply(it, o), args: [items, { highlight: !!s.highlight }] });
    applied.push(...((out[0] && out[0].result) || []));
  }
  const okCount = applied.filter((a) => a.ok).length;
  lastRun[tabId] = { opts: Object.assign({}, overrides), at: Date.now() };

  const items = resolved.map((r) => { const f = fields.find((x) => x.id === r.id); return { id: r.id, label: (f && (f.label || f.name || f.placeholder)) || r.id, value: Array.isArray(r.value) ? r.value.join(', ') : String(r.value), source: r.source }; });
  const aiCount = resolved.filter((r) => r.source === 'ai').length;
  await panel(tabId, {
    status: aiError && !aiCount ? 'err' : 'ok',
    title: okCount + ' field terisi' + (usedModel ? ' · ' + usedModel : ''),
    message: aiError ? 'AI bermasalah (' + aiError.slice(0, 120) + '). Sisanya diisi data lokal.' : (aiCount + ' dari AI, ' + (resolved.length - aiCount) + ' dari generator lokal') + (skipped.length ? ' · dilewati: ' + skipped.map((x) => x.label || x.reason).join(', ') : ''),
    items,
    actions: [{ id: 'undo', label: 'Urungkan' }, { id: 'fix', label: 'Perbaiki error validasi' }, { id: 'refill', label: 'Isi ulang', primary: true }],
  });
  return { filled: okCount, ai: aiCount, model: usedModel, error: aiError || null };
}

async function runUndo(tabId) {
  const out = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => (window.__aiFill ? window.__aiFill.undo() : 0) });
  const n = out.reduce((a, r) => a + (r.result || 0), 0);
  await panel(tabId, { status: 'ok', title: n + ' field dikembalikan', autoHideMs: 2500 });
  return { reverted: n };
}

async function runFix(tabId) {
  const s = await S.get();
  const tab = await chrome.tabs.get(tabId);
  const host = hostOf(tab.url);
  await injectEngine(tabId);
  await panel(tabId, { status: 'busy', title: 'Membaca pesan galat…' });
  const scans = frameResults(await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => window.__aiFill.scanInvalid() }));
  const map = {}; const fields = []; const fixes = []; let n = 0; let page = null;
  for (const fr of scans) {
    if (!page || fr.frameId === 0) page = fr.result.page;
    const idMap = {};
    for (const f of fr.result.fields) { const gid = 'g' + (++n); idMap[f.id] = gid; map[gid] = { frameId: fr.frameId, localId: f.id }; fields.push(Object.assign({}, f, { id: gid })); }
    for (const fx of fr.result.fixes) if (idMap[fx.id]) fixes.push(Object.assign({}, fx, { id: idMap[fx.id] }));
  }
  if (!fields.length) { await panel(tabId, { status: 'ok', title: 'Tidak ada field bermasalah', message: 'Tidak ada pesan galat validasi yang terlihat.', autoHideMs: 3500 }); return { fixed: 0 }; }
  const persona = await getPersona(s);
  const ctx = { mode: 'realistic', rng: H.makeRng(Date.now() % 1e9), persona, today: new Date() };
  let aiValues = {}; let err = '';
  try { aiValues = (await llmFill(s, fields, page || {}, 'realistic', persona, (s.siteNotes && s.siteNotes[host]) || '', fixes)).values; } catch (e) { err = String(e && e.message || e); }
  const resolved = P.resolveValues(fields, aiValues, ctx);
  const byFrame = {};
  for (const r of resolved) { const m = map[r.id]; (byFrame[m.frameId] = byFrame[m.frameId] || []).push({ id: m.localId, value: r.value, source: r.source }); }
  let ok = 0;
  for (const [frameId, items] of Object.entries(byFrame)) {
    const out = await chrome.scripting.executeScript({ target: { tabId, frameIds: [Number(frameId)] }, func: (it, o) => window.__aiFill.apply(it, o), args: [items, { highlight: true }] });
    ok += ((out[0] && out[0].result) || []).filter((a) => a.ok).length;
  }
  await panel(tabId, { status: err ? 'err' : 'ok', title: ok + ' field diperbaiki', message: err || 'Coba kirim ulang formulirnya.', items: resolved.map((r) => ({ id: r.id, label: (fields.find((f) => f.id === r.id) || {}).label, value: String(r.value), source: r.source })), actions: [{ id: 'undo', label: 'Urungkan' }, { id: 'fix', label: 'Periksa lagi', primary: true }] });
  return { fixed: ok };
}
