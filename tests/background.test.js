// Tes orkestrasi service worker (background.js) dengan API chrome palsu + jsdom sebagai halaman + server Ollama palsu.
// Memverifikasi: deteksi model, pemindaian lintas frame, permintaan ke LLM, rapikan, pengisian, panel, urungkan, perbaikan galat.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PAGE = `
<h1>Supplier Baru</h1>
<form>
  <label for="nm">Nama Supplier *</label><input id="nm" name="name" required maxlength="25">
  <label for="em">Email</label><input id="em" type="email" name="email">
  <label for="ty">Tipe</label><select id="ty"><option value="">--</option><option value="lokal">Lokal</option><option value="impor">Impor</option></select>
  <label for="no">Catatan</label><textarea id="no"></textarea>
  <label for="lm">Limit</label><input id="lm" type="number" min="0" max="1000" step="100">
</form>`;

function setup(opts) {
  opts = Object.assign({ ollamaUp: true, llmBody: null }, opts || {});
  const dom = new JSDOM('<!doctype html><title>Supplier</title><body>' + PAGE, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost:3000/suppliers/create' });
  const w = dom.window;
  w.Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20 });
  const panelMessages = [];
  w.chrome = { runtime: { sendMessage: (m) => panelMessages.push(m) } };

  const mem = (init) => { const d = Object.assign({}, init); return { get: async (k) => (typeof k === 'string' ? (k in d ? { [k]: d[k] } : {}) : Object.assign({}, d)), set: async (o) => { Object.assign(d, o); }, remove: async (k) => { delete d[k]; }, _d: d }; };
  const listeners = { message: null, command: null };
  const calls = { chat: [], dnr: [] };

  const chrome = {
    runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener: (f) => { listeners.message = f; } } },
    commands: { onCommand: { addListener: (f) => { listeners.command = f; } } },
    contextMenus: { create() {}, removeAll: (cb) => cb && cb(), onClicked: { addListener() {} } },
    declarativeNetRequest: { updateSessionRules: async (r) => { calls.dnr.push(r); } },
    storage: { local: mem({}), session: mem({}) },
    tabs: { query: async () => [{ id: 1, url: w.location.href }], get: async () => ({ id: 1, url: w.location.href }) },
    scripting: {
      executeScript: async (inj) => {
        if (inj.files) { for (const f of inj.files) w.eval(read(f)); return [{ frameId: 0, result: undefined }]; }
        const fn = w.eval('(' + inj.func.toString() + ')');
        const args = JSON.parse(JSON.stringify(inj.args || []));
        const result = await fn(...args);
        return [{ frameId: 0, result: result === undefined ? undefined : JSON.parse(JSON.stringify(result)) }];
      },
    },
  };

  const fakeFetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/api/tags')) {
      if (!opts.ollamaUp) throw new Error('ECONNREFUSED');
      return { ok: true, json: async () => ({ models: [
        { name: 'nomic-embed-text', details: { parameter_size: '137M' }, capabilities: ['embedding'], size: 274e6 },
        { name: 'qwen2.5:7b-instruct', details: { parameter_size: '7.6B', quantization_level: 'Q4_K_M' }, capabilities: ['completion', 'tools'], size: 4.7e9 },
      ] }) };
    }
    if (u.endsWith('/api/generate')) return { ok: true, json: async () => ({}) };
    if (u.endsWith('/api/chat')) {
      const body = JSON.parse(init.body);
      calls.chat.push(body);
      const userMsg = body.messages[1].content;
      const fieldLines = userMsg.split('Field:\n')[1].split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
      const values = {};
      for (const f of fieldLines) {
        if (f.kind === 'select') values[f.id] = 'Impor'; // label, bukan nilai: harus dirapikan ke "impor"
        else if (f.kind === 'number') values[f.id] = 1234;   // di luar step & max: harus dirapikan
        else if (f.kind === 'email') values[f.id] = 'bukan email';
        else if (f.kind === 'textarea') values[f.id] = 'Catatan dari AI palsu';
        else values[f.id] = 'Nama Supplier Yang Sangat Panjang Sekali Melebihi Batas';
      }
      const content = opts.llmBody ? opts.llmBody(fieldLines) : JSON.stringify({ values });
      return { ok: true, json: async () => ({ message: { content } }) };
    }
    throw new Error('URL tak terduga ' + u);
  };

  const sandbox = { self: null, console, fetch: fakeFetch, AbortController, setTimeout, clearTimeout, URL, Date, JSON, Math, Promise, Object, Array, Number, String, RegExp, Set, Map, Error, chrome };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.importScripts = (...files) => { for (const f of files) vm.runInContext(read(f), ctx, { filename: f }); };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read('background.js') + '\n;this.__bg = { runFill, runUndo, runFix, detectAll };', ctx, { filename: 'background.js' });

  const send = (msg) => new Promise((resolve) => listeners.message(msg, {}, resolve));
  return { w, chrome, sandbox, send, calls, panelMessages, listeners, doc: w.document };
}

test('mendeteksi model, melewati embedding, merekomendasikan instruct, memasang aturan Origin hanya untuk service worker', async () => {
  const t = setup();
  const res = await t.send({ type: 'detect' });
  assert.equal(res.ok, true);
  assert.equal(res.data.length, 1);
  assert.equal(res.data[0].endpoint.id, 'ollama');
  assert.equal(res.data[0].recommended, 'qwen2.5:7b-instruct');
  const rule = t.calls.dnr[0].addRules[0];
  assert.deepEqual(JSON.parse(JSON.stringify(rule.condition.tabIds)), [-1]);
  assert.equal(rule.action.requestHeaders[0].operation, 'remove');
});

test('fill: memindai, bertanya ke LLM dengan skema, merapikan jawaban, mengisi, menampilkan panel, lalu undo', async () => {
  const t = setup();
  const out = await t.send({ type: 'fill', opts: {} });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.data.filled, 5);
  assert.equal(out.data.model, 'qwen2.5:7b-instruct');
  assert.equal(out.data.error, null);

  // permintaan ke Ollama: skema JSON + think:false, persona dan konteks halaman ikut terkirim
  const body = t.calls.chat[0];
  assert.equal(body.think, false);
  assert.equal(body.format.type, 'object');
  assert.match(body.messages[1].content, /Persona:/);
  assert.match(body.messages[1].content, /Supplier Baru/);

  const d = t.doc;
  assert.ok(d.getElementById('nm').value.length > 0 && d.getElementById('nm').value.length <= 25, 'dipotong ke maxlength');
  assert.match(d.getElementById('em').value, /^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'email tak valid diganti');
  assert.equal(d.getElementById('ty').value, 'impor', 'label dipetakan ke nilai opsi');
  assert.equal(d.getElementById('no').value, 'Catatan dari AI palsu');
  const lim = Number(d.getElementById('lm').value);
  assert.ok(lim >= 0 && lim <= 1000 && lim % 100 === 0, 'angka dijepit ke min/max/step: ' + lim);

  // panel ringkasan dirender di frame atas
  const panelHost = d.getElementById('aifill-panel-host');
  assert.ok(panelHost && panelHost.shadowRoot.textContent.includes('field terisi'));

  const undone = await t.send({ type: 'undo' });
  assert.equal(undone.data.reverted, 5);
  assert.equal(d.getElementById('nm').value, '');
  assert.equal(d.getElementById('ty').value, '');
});

test('persona sama dipakai ulang dalam 30 menit', async () => {
  const t = setup();
  await t.send({ type: 'fill', opts: {} });
  await t.send({ type: 'undo' });
  await t.send({ type: 'fill', opts: {} });
  const personaOf = (b) => /Persona: (\{.*\})/.exec(b.messages[1].content)[1];
  assert.equal(personaOf(t.calls.chat[0]), personaOf(t.calls.chat[1]));
});

test('LLM mati: tetap terisi dari generator lokal dan galat dilaporkan', async () => {
  const t = setup({ ollamaUp: false });
  const out = await t.send({ type: 'fill', opts: {} });
  assert.equal(out.ok, true);
  assert.equal(out.data.filled, 5);
  assert.equal(out.data.ai, 0);
  assert.match(out.data.error, /Tidak ada server LLM/);
  assert.ok(t.doc.getElementById('nm').value.length > 0);
});

test('jawaban model bukan JSON: jatuh ke generator lokal', async () => {
  const t = setup({ llmBody: () => 'maaf saya tidak bisa' });
  const out = await t.send({ type: 'fill', opts: {} });
  assert.equal(out.data.filled, 5);
  assert.equal(out.data.ai, 0);
  assert.match(out.data.error, /JSON/);
});

test('strategi cepat: AI hanya untuk field yang sulit', async () => {
  const t = setup();
  await t.chrome.storage.local.set({ settings: { strategy: 'hybrid' } });
  const out = await t.send({ type: 'fill', opts: {} });
  assert.equal(out.data.filled, 5);
  const sent = t.calls.chat[0].messages[1].content.split('Field:\n')[1].split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  const kinds = sent.map((f) => f.kind).sort();
  assert.deepEqual(JSON.parse(JSON.stringify(kinds)), ['select', 'textarea'], 'hanya select & textarea yang ke AI, sisanya lokal');
});

test('host tidak diizinkan ditolak', async () => {
  const t = setup();
  await t.chrome.storage.local.set({ settings: { allowedHosts: 'erp.perusahaan.com' } });
  const out = await t.send({ type: 'fill', opts: {} });
  assert.equal(out.data.error, 'host tidak diizinkan');
  assert.equal(t.doc.getElementById('nm').value, '');
});

test('perbaiki error: membaca pesan galat lalu mengirimnya ke LLM', async () => {
  const t = setup({ llmBody: (fields) => JSON.stringify({ values: Object.fromEntries(fields.map((f) => [f.id, 'perbaikan@example.com'])) }) });
  const em = t.doc.getElementById('em');
  em.setAttribute('aria-invalid', 'true');
  const p = t.doc.createElement('p'); p.id = 'err'; p.textContent = 'Email wajib berformat nama@domain'; t.doc.body.appendChild(p);
  em.setAttribute('aria-describedby', 'err');
  const out = await t.send({ type: 'fixErrors' });
  assert.equal(out.data.fixed, 2, 'email bertanda aria-invalid + nama wajib yang masih kosong');
  assert.equal(em.value, 'perbaikan@example.com');
  assert.match(t.calls.chat[0].messages[1].content, /ditolak validasi/);
  assert.match(t.calls.chat[0].messages[1].content, /Email wajib berformat/);
});
