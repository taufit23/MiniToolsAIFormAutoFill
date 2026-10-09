// Tes jalur data: heuristik, rapikan jawaban (coerce), urai jawaban model, dan (opsional, AIFF_LIVE=1) end-to-end ke Ollama lokal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const H = require('../lib/heuristics.js');
const P = require('../lib/prompt.js');
const PR = require('../lib/providers.js');

const ctx = (mode) => ({ mode: mode || 'realistic', rng: H.makeRng(42), persona: H.persona(42), today: new Date('2026-10-09T00:00:00Z') });

test('heuristik deterministik untuk seed yang sama dan persona konsisten', () => {
  const a = H.persona(7); const b = H.persona(7); const c = H.persona(8);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.match(a.email, /^[a-z]+\.[a-z]+\d+@example\.com$/);
  assert.ok(a.phone.length <= 13 && /^08\d+$/.test(a.phone));
  assert.equal(a.nik.length, 16);
});

test('klasifikasi & generate menghormati tipe dan batas', () => {
  const x = ctx();
  assert.equal(H.classify({ label: 'Nomor NPWP' }), 'npwp');
  assert.equal(H.classify({ label: 'Harga Satuan', kind: 'number' }), 'money');
  assert.equal(H.classify({ autocomplete: 'postal-code' }), 'postal');
  const n = H.generate({ kind: 'number', label: 'Qty', min: '1', max: '5', step: '1' }, x);
  assert.ok(n >= 1 && n <= 5 && Number.isInteger(n));
  const phone = H.generate({ kind: 'tel', label: 'Telepon', maxLength: 13, pattern: '\\d{10,13}' }, x);
  assert.match(String(phone), /^\d{10,13}$/);
  const due = H.generate({ kind: 'date', label: 'Jatuh tempo' }, x);
  assert.ok(due > '2026-10-09');
  const birth = H.generate({ kind: 'date', label: 'Tanggal lahir' }, x);
  assert.ok(birth < '2010-01-01');
});

test('coerce memperbaiki jawaban yang melanggar batas', () => {
  const x = ctx();
  const sel = { id: 'g1', kind: 'select', options: [{ value: 'customer', label: 'Pelanggan' }, { value: 'supplier', label: 'Pemasok' }] };
  assert.equal(P.coerce(sel, 'Pemasok', x).value, 'supplier');
  assert.ok(['customer', 'supplier'].includes(P.coerce(sel, 'tidak ada', x).value));
  assert.equal(P.coerce({ id: 'g2', kind: 'text', maxLength: 5 }, 'abcdefgh', x).value, 'abcde');
  assert.equal(P.coerce({ id: 'g3', kind: 'number', min: '0', max: '10', step: '2' }, 'Rp 7', x).value, 8);
  assert.equal(P.coerce({ id: 'g4', kind: 'email' }, 'bukan-email', x).source, 'heuristic');
  assert.equal(P.coerce({ id: 'g5', kind: 'checkbox' }, 'ya', x).value, true);
  // mode negatif tidak memaksa batas
  assert.equal(P.coerce({ id: 'g6', kind: 'text', maxLength: 5 }, 'abcdefgh', ctx('invalid')).value, 'abcdefgh');
});

test('parseResponse toleran pagar kode, teks pembuka, dan <think>', () => {
  assert.deepEqual(P.parseResponse('{"values":{"g1":"a"}}'), { g1: 'a' });
  assert.deepEqual(P.parseResponse('```json\n{"values":{"g1":"a"}}\n```'), { g1: 'a' });
  assert.deepEqual(P.parseResponse('<think>hmm</think>Berikut: {"values":{"g1":"a"}} selesai'), { g1: 'a' });
  assert.deepEqual(P.parseResponse('{"g1":"a"}'), { g1: 'a' });
  assert.equal(P.parseResponse('bukan json'), null);
});

test('schema memuat enum pilihan dan hanya field wajib pada mode required_only', () => {
  const fields = [{ id: 'g1', kind: 'select', required: true, options: [{ value: 'a', label: 'A' }] }, { id: 'g2', kind: 'text' }];
  const full = P.buildSchema(fields, 'realistic');
  assert.deepEqual(full.properties.values.properties.g1.enum, ['a']);
  assert.deepEqual(full.properties.values.required, ['g1', 'g2']);
  assert.deepEqual(P.buildSchema(fields, 'required_only').properties.values.required, ['g1']);
  const r = P.resolveValues(fields, {}, ctx('required_only'));
  assert.deepEqual(r.map((x) => x.id), ['g1']);
});

test('rekomendasi model: hindari embedding dan pilih instruct ukuran menengah', () => {
  const models = [
    { id: 'nomic-embed-text', chat: false, params: 0.1 }, { id: 'qwen3:1.7b', chat: true, params: 2, thinking: true },
    { id: 'qwen2.5:7b-instruct', chat: true, params: 7.6 }, { id: 'llama3:70b', chat: true, params: 70 },
  ];
  assert.equal(PR.recommend(models).id, 'qwen2.5:7b-instruct');
});

// ── Live: end-to-end ke Ollama lokal. Jalankan: AIFF_LIVE=1 node --test tests/pipeline.test.js ───────────────
const FORM = `
<h1>Pelanggan Baru</h1><form>
 <label for="nm">Nama Lengkap *</label><input id="nm" name="name" required maxlength="30">
 <label for="em">Email *</label><input id="em" type="email" name="email" required>
 <label for="ph">Telepon</label><input id="ph" name="phone" pattern="\\d{10,13}" maxlength="13">
 <label for="co">Perusahaan</label><input id="co" name="company">
 <label for="ty">Tipe Pelanggan *</label><select id="ty" name="type" required><option value="">--</option><option value="retail">Retail</option><option value="grosir">Grosir</option><option value="agen">Agen</option></select>
 <fieldset><legend>Status</legend><label><input type="radio" name="st" value="active"> Aktif</label><label><input type="radio" name="st" value="inactive"> Nonaktif</label></fieldset>
 <label for="lim">Limit Kredit (Rp)</label><input id="lim" type="number" min="0" max="50000000" step="500000">
 <label for="tgl">Tanggal Bergabung</label><input id="tgl" type="date">
 <label for="al">Alamat</label><textarea id="al" maxlength="120"></textarea>
 <label for="np">NPWP</label><input id="np" name="npwp" maxlength="15">
 <label><input type="checkbox" name="tax"> Kena PPN</label>
</form>`;

test('LIVE end-to-end dengan Ollama lokal', { skip: !process.env.AIFF_LIVE, timeout: 240000 }, async (t) => {
  const found = await PR.detect(null, 2500);
  if (!found.length) return t.skip('Tidak ada server LLM lokal');
  const entry = found[0];
  const model = (PR.recommend(entry.models) || {}).id;
  console.log('   server:', entry.endpoint.name, '| model:', model);
  assert.ok(model);

  const dom = new JSDOM('<!doctype html><title>Pelanggan</title><body>' + FORM, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost:3000/customers/create' });
  const w = dom.window;
  w.Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20 });
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'content', 'engine.js'), 'utf8'));
  const scan = JSON.parse(JSON.stringify(w.__aiFill.scan({})));
  const persona = H.persona(2026);
  const x = { mode: 'realistic', rng: H.makeRng(2026), persona, today: new Date('2026-10-09T00:00:00Z') };

  const started = Date.now();
  const messages = P.buildMessages({ fields: scan.fields, page: scan.page, mode: 'realistic', locale: 'id-ID', persona, siteNotes: 'NPWP 15 digit angka tanpa titik.' });
  const raw = await PR.chatJson(entry.endpoint, model, messages, { schema: P.buildSchema(scan.fields, 'realistic'), temperature: 0.7, timeoutMs: 200000 });
  console.log('   waktu:', ((Date.now() - started) / 1000).toFixed(1) + ' dtk');
  const values = P.parseResponse(raw);
  assert.ok(values, 'jawaban harus berupa JSON: ' + String(raw).slice(0, 200));

  const resolved = P.resolveValues(scan.fields, values, x);
  const res = await w.__aiFill.apply(resolved.map((r) => ({ id: r.id, value: r.value, source: r.source })));
  const d = w.document;
  console.log('   hasil:', JSON.stringify(resolved.map((r) => [scan.fields.find((f) => f.id === r.id).label, r.value, r.source])));

  assert.ok(res.every((r) => r.ok), JSON.stringify(res));
  assert.ok(d.getElementById('nm').value.length > 0 && d.getElementById('nm').value.length <= 30);
  assert.match(d.getElementById('em').value, /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  assert.match(d.getElementById('ph').value, /^\d{10,13}$/);
  assert.ok(['retail', 'grosir', 'agen'].includes(d.getElementById('ty').value));
  assert.ok(d.querySelector('[name="st"]:checked'));
  const lim = Number(d.getElementById('lim').value);
  assert.ok(lim >= 0 && lim <= 50000000 && lim % 500000 === 0, 'limit ' + lim);
  assert.match(d.getElementById('tgl').value, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(d.getElementById('al').value.length <= 120);
  assert.match(d.getElementById('np').value, /^\d{1,15}$/);
});
