// Tes mesin halaman (content/engine.js) di jsdom: pemindaian field, pengelompokan radio, cakupan dialog, pengisian, dan urungkan.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ENGINE = fs.readFileSync(path.join(__dirname, '..', 'content', 'engine.js'), 'utf8');

const FORM = `
<h1>Kontak Baru</h1>
<form id="f">
  <div class="field"><label for="nm">Nama Lengkap *</label><input id="nm" name="name" required maxlength="40"></div>
  <div class="field"><label for="em">Email</label><input id="em" type="email" name="email" autocomplete="email"></div>
  <div class="field"><label>Telepon<input name="phone" inputmode="numeric" pattern="\\d{10,13}" maxlength="13"></label></div>
  <div class="field"><label for="tp">Tipe</label>
    <select id="tp" name="type"><option value="">-- pilih --</option><option value="customer">Pelanggan</option><option value="supplier">Pemasok</option></select></div>
  <fieldset><legend>Status</legend>
    <label><input type="radio" name="status" value="active"> Aktif</label>
    <label><input type="radio" name="status" value="inactive"> Nonaktif</label></fieldset>
  <label><input type="checkbox" name="vip"> Pelanggan VIP</label>
  <div class="field"><label for="dob">Tanggal Lahir</label><input id="dob" type="date"></div>
  <div class="field"><label for="amt">Limit Kredit</label><input id="amt" type="number" min="0" max="1000000" step="1000"></div>
  <div class="field"><label for="nt">Catatan</label><textarea id="nt"></textarea></div>
  <div class="field"><label for="pw">Password</label><input id="pw" type="password"></div>
  <input type="hidden" name="csrf" value="x"><input type="file" name="doc"><button type="submit">Simpan</button>
  <input name="g-recaptcha-response">
  <input id="pre" name="prefilled" value="sudah ada">
  <input id="dis" disabled>
</form>`;

function boot(html) {
  const dom = new JSDOM('<!doctype html><title>Uji</title><body>' + html + '</body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost:3000/contacts/create' });
  const w = dom.window;
  w.Element.prototype.getBoundingClientRect = function () { return { width: 120, height: 24, top: 0, left: 0, right: 120, bottom: 24 }; };
  w.eval(ENGINE);
  return w;
}

test('scan membaca label, kind, wajib, batas, dan opsi', () => {
  const w = boot(FORM);
  const r = w.__aiFill.scan({});
  const by = (label) => r.fields.find((f) => f.label === label);
  assert.equal(by('Nama Lengkap').required, true);
  assert.equal(by('Nama Lengkap').maxLength, 40);
  assert.equal(by('Email').kind, 'email');
  assert.equal(by('Email').autocomplete, 'email');
  assert.equal(by('Tipe').kind, 'select');
  assert.deepEqual(JSON.parse(JSON.stringify(by('Tipe').options.map((o) => o.value))), ['customer', 'supplier']);
  assert.equal(by('Tanggal Lahir').kind, 'date');
  assert.equal(by('Limit Kredit').step, '1000');
  assert.equal(by('Status').kind, 'radio');
  assert.equal(by('Status').options.length, 2);
  assert.ok(r.fields.find((f) => f.kind === 'checkbox'));
  const names = r.fields.map((f) => f.name);
  assert.ok(!names.includes('csrf'), 'hidden dilewati');
  assert.ok(!names.includes('doc'), 'file dilewati');
  assert.ok(!names.includes('g-recaptcha-response'), 'captcha dilewati');
  assert.ok(!names.includes('prefilled'), 'yang sudah terisi dilewati tanpa overwrite');
  assert.equal(r.fields.find((f) => f.name === 'phone').pattern, '\\d{10,13}');
});

test('overwrite menyertakan field terisi', () => {
  const w = boot(FORM);
  const r = w.__aiFill.scan({ overwrite: true });
  assert.ok(r.fields.find((f) => f.name === 'prefilled'));
});

test('apply mengisi dengan event input/change lalu undo mengembalikan', async () => {
  const w = boot(FORM);
  const r = w.__aiFill.scan({});
  const log = [];
  w.document.getElementById('nm').addEventListener('input', () => log.push('input'));
  w.document.getElementById('tp').addEventListener('change', () => log.push('change'));
  const id = (label) => r.fields.find((f) => f.label === label).id;
  const radio = r.fields.find((f) => f.kind === 'radio');
  const vip = r.fields.find((f) => f.kind === 'checkbox');
  const res = await w.__aiFill.apply([
    { id: id('Nama Lengkap'), value: 'Budi Santoso', source: 'ai' }, { id: id('Tipe'), value: 'supplier', source: 'ai' },
    { id: radio.id, value: 'inactive', source: 'ai' }, { id: vip.id, value: true, source: 'heuristic' },
    { id: id('Tanggal Lahir'), value: '1990-05-17', source: 'heuristic' }, { id: id('Limit Kredit'), value: 250000, source: 'heuristic' },
  ]);
  assert.ok(res.every((x) => x.ok), JSON.stringify(res));
  const d = w.document;
  assert.equal(d.getElementById('nm').value, 'Budi Santoso');
  assert.equal(d.getElementById('tp').value, 'supplier');
  assert.equal(d.querySelector('input[value="inactive"]').checked, true);
  assert.equal(d.querySelector('[name="vip"]').checked, true);
  assert.equal(d.getElementById('dob').value, '1990-05-17');
  assert.equal(d.getElementById('amt').value, '250000');
  assert.ok(log.includes('input') && log.includes('change'));
  const n = w.__aiFill.undo();
  assert.ok(n >= 6);
  assert.equal(d.getElementById('nm').value, '');
  assert.equal(d.getElementById('tp').value, '');
  assert.equal(d.querySelector('[name="vip"]').checked, false);
});

test('dialog terbuka membatasi cakupan', () => {
  const w = boot('<input id="out" aria-label="Di luar"><div role="dialog" aria-modal="true"><label for="in">Di dalam</label><input id="in"></div>');
  const r = w.__aiFill.scan({});
  assert.deepEqual(JSON.parse(JSON.stringify(r.fields.map((f) => f.label))), ['Di dalam']);
  assert.equal(r.scopedToDialog, true);
});

test('combobox ARIA: memilih opsi yang cocok', async () => {
  const w = boot('<label for="c">Provinsi</label><input id="c" role="combobox" aria-controls="lb"><ul id="lb" role="listbox" style="display:block"><li role="option">Jawa Barat</li><li role="option">Bali</li></ul>');
  const r = w.__aiFill.scan({});
  const f = r.fields.find((x) => x.kind === 'combobox');
  assert.ok(f);
  let picked = '';
  w.document.querySelectorAll('[role="option"]').forEach((o) => o.addEventListener('click', () => { picked = o.textContent; }));
  const res = await w.__aiFill.apply([{ id: f.id, value: 'Bali', source: 'ai' }]);
  assert.equal(res[0].ok, true);
  assert.equal(picked, 'Bali');
});

test('collectErrors membaca field yang ditandai tidak valid beserta pesannya', () => {
  const w = boot('<div><label for="e">Email</label><input id="e" aria-invalid="true" aria-describedby="m"><p id="m">Format email tidak valid</p></div>');
  const errs = w.__aiFill.collectErrors();
  assert.equal(errs.length, 1);
  assert.equal(errs[0].label, 'Email');
  assert.match(errs[0].message, /tidak valid/);
  const s = w.__aiFill.scanInvalid();
  assert.equal(s.fixes.length, 1);
});
