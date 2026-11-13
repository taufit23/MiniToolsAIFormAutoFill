// Tes simpan & pasang isian (engine.snapshot / engine.restore) di jsdom: isian lama dibaca, halaman "dimuat ulang", lalu dipasang kembali.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ENGINE = fs.readFileSync(path.join(__dirname, '..', 'content', 'engine.js'), 'utf8');

const FORM = `
<h1>Kontak Baru</h1>
<form>
  <div class="field"><label for="nm">Nama Lengkap *</label><input id="nm" name="name"></div>
  <div class="field"><label for="em">Email</label><input id="em" type="email" name="email"></div>
  <div class="field"><label for="tp">Tipe</label>
    <select id="tp" name="type"><option value="">-- pilih --</option><option value="customer">Pelanggan</option><option value="supplier">Pemasok</option></select></div>
  <div class="field"><label for="tg">Tag</label>
    <select id="tg" name="tags" multiple><option value="a">A</option><option value="b">B</option><option value="c">C</option></select></div>
  <fieldset><legend>Status</legend>
    <label><input type="radio" name="status" value="active"> Aktif</label>
    <label><input type="radio" name="status" value="inactive"> Nonaktif</label></fieldset>
  <label><input type="checkbox" name="vip"> Pelanggan VIP</label>
  <div class="field"><label for="dob">Tanggal Lahir</label><input id="dob" type="date"></div>
  <div class="field"><label for="nt">Catatan</label><textarea id="nt"></textarea></div>
  <div class="field"><label>Item<input class="row" aria-label="Item"></label></div>
  <div class="field"><label>Item<input class="row" aria-label="Item"></label></div>
</form>`;

function boot(html) {
  const dom = new JSDOM('<!doctype html><title>Uji</title><body>' + html + '</body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost:3000/contacts/create' });
  const w = dom.window;
  w.Element.prototype.getBoundingClientRect = function () { return { width: 120, height: 24, top: 0, left: 0, right: 120, bottom: 24 }; };
  w.eval(ENGINE);
  return w;
}
const plain = (o) => JSON.parse(JSON.stringify(o));

function fillAll(w) {
  const d = w.document;
  d.getElementById('nm').value = 'Budi Santoso';
  d.getElementById('em').value = 'budi@contoh.id';
  d.getElementById('tp').value = 'supplier';
  for (const o of d.getElementById('tg').options) o.selected = o.value !== 'b';
  d.querySelector('input[value="inactive"]').checked = true;
  d.querySelector('input[name="vip"]').checked = true;
  d.getElementById('dob').value = '1990-05-17';
  d.getElementById('nt').value = 'baris 1\nbaris 2';
  const rows = d.querySelectorAll('.row'); rows[0].value = 'Kopi'; rows[1].value = 'Teh';
}

test('snapshot membaca semua isian (select ambil nilai sekarang) dan melewati yang kosong', () => {
  const w = boot(FORM); fillAll(w);
  w.document.getElementById('nt').value = '';
  const { items, page } = plain(w.__aiFill.snapshot({}));
  const by = (l) => items.filter((i) => i.label === l);
  assert.equal(by('Nama Lengkap')[0].value, 'Budi Santoso');
  assert.equal(by('Tipe')[0].value, 'supplier');
  assert.equal(by('Tipe')[0].text, 'Pemasok');
  assert.deepEqual(by('Tag')[0].value, ['a', 'c']);
  assert.equal(by('Status')[0].value, 'inactive');
  assert.equal(by('Pelanggan VIP')[0].value, true);
  assert.equal(by('Tanggal Lahir')[0].value, '1990-05-17');
  assert.equal(by('Item').length, 2);
  assert.ok(!items.find((i) => i.label === 'Catatan'), 'textarea kosong tidak disimpan');
  assert.equal(page.path, '/contacts/create');
});

test('restore memasang kembali ke halaman yang baru dimuat (field kosong)', async () => {
  const w1 = boot(FORM); fillAll(w1);
  const saved = plain(w1.__aiFill.snapshot({})).items;

  const w2 = boot(FORM); // "muat ulang"
  const r = plain(await w2.__aiFill.restore(saved, { highlight: false, waitMs: 5 }));
  const d = w2.document;
  assert.deepEqual(r.missing, []);
  assert.equal(d.getElementById('nm').value, 'Budi Santoso');
  assert.equal(d.getElementById('tp').value, 'supplier');
  assert.deepEqual([...d.getElementById('tg').selectedOptions].map((o) => o.value), ['a', 'c']);
  assert.equal(d.querySelector('input[value="inactive"]').checked, true);
  assert.equal(d.querySelector('input[name="vip"]').checked, true);
  assert.equal(d.getElementById('dob').value, '1990-05-17');
  assert.equal(d.getElementById('nt').value, 'baris 1\nbaris 2');
  const rows = d.querySelectorAll('.row');
  assert.equal(rows[0].value, 'Kopi');
  assert.equal(rows[1].value, 'Teh', 'dua field berlabel sama dipasangkan berdasarkan urutan');
});

test('restore memicu event input dan bisa diurungkan', async () => {
  const w1 = boot(FORM); fillAll(w1);
  const saved = plain(w1.__aiFill.snapshot({})).items;
  const w2 = boot(FORM);
  let inputs = 0; w2.document.getElementById('em').addEventListener('input', () => inputs++);
  await w2.__aiFill.restore(saved, { highlight: false, waitMs: 5 });
  assert.ok(inputs >= 1);
  w2.__aiFill.undo();
  assert.equal(w2.document.getElementById('nm').value, '');
});

test('restore mencoba lagi sampai opsi select yang dimuat belakangan tersedia', async () => {
  const w1 = boot(FORM); fillAll(w1);
  const saved = plain(w1.__aiFill.snapshot({})).items;
  const w2 = boot(FORM);
  const sel = w2.document.getElementById('tp');
  sel.querySelector('option[value="supplier"]').remove(); // opsi belum ada, seperti dropdown dari API
  setTimeout(() => { const o = w2.document.createElement('option'); o.value = 'supplier'; o.textContent = 'Pemasok'; sel.appendChild(o); }, 30);
  const r = plain(await w2.__aiFill.restore(saved, { highlight: false, waitMs: 60 }));
  assert.equal(sel.value, 'supplier');
  assert.deepEqual(r.missing, []);
});

test('restore melaporkan isian yang tidak ketemu, tanpa menebak', async () => {
  const w1 = boot(FORM); fillAll(w1);
  const saved = plain(w1.__aiFill.snapshot({})).items;
  const w2 = boot(FORM.replace('<option value="supplier">Pemasok</option>', ''));
  const r = plain(await w2.__aiFill.restore(saved, { highlight: false, waitMs: 5, passes: 2 }));
  assert.deepEqual(r.missing, ['Tipe']);
  assert.equal(w2.document.getElementById('tp').value, '');
  assert.equal(w2.document.getElementById('nm').value, 'Budi Santoso', 'yang lain tetap terpasang');
});

test('restore mode ketat pada combobox ARIA tidak memilih opsi lain bila yang sama tidak ada', async () => {
  const html = '<label for="cb">Pemasok</label><input id="cb" role="combobox" aria-controls="lb"><ul id="lb" role="listbox"><li role="option">PT Maju</li><li role="option">CV Jaya</li></ul>';
  const item = { frame: 'top', kind: 'combobox', label: 'Pemasok', name: '', domId: 'cb', section: '', value: 'CV Jaya', text: '' };
  const w = boot(html);
  let r = plain(await w.__aiFill.restore([item], { highlight: false, waitMs: 5, passes: 1 }));
  assert.equal(r.restored.length, 1);
  const w2 = boot(html);
  r = plain(await w2.__aiFill.restore([Object.assign({}, item, { value: 'PT Tidak Ada' })], { highlight: false, waitMs: 5, passes: 1 }));
  assert.deepEqual(r.missing, ['Pemasok']);
});
