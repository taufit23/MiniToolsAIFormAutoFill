'use strict';
const $ = (id) => document.getElementById(id);
let detected = [];
let host = '';
let settings = null;

const send = (msg) => chrome.runtime.sendMessage(msg);

async function load() {
  const stored = await chrome.storage.local.get('settings');
  const defaults = { mode: 'realistic', locale: 'id-ID', overwrite: false, includePassword: true, endpointId: '', model: '', siteNotes: {} };
  settings = Object.assign(defaults, stored.settings || {});

  const modes = { realistic: 'Realistis (valid & masuk akal)', required_only: 'Hanya field wajib', edge: 'Batas (boundary)', invalid: 'Negatif (sengaja tidak valid)' };
  $('mode').innerHTML = Object.entries(modes).map(([k, v]) => '<option value="' + k + '">' + v + '</option>').join('');
  $('mode').value = settings.mode;
  $('locale').value = settings.locale;
  $('strategy').value = settings.strategy || 'ai';
  $('overwrite').checked = !!settings.overwrite;
  $('includePassword').checked = !!settings.includePassword;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { host = new URL(tab.url).host; } catch (e) { host = ''; }
  $('host').textContent = host ? '· ' + host : '';
  $('siteNotes').value = (settings.siteNotes && settings.siteNotes[host]) || '';

  const res = await send({ type: 'detect' });
  detected = (res && res.ok && res.data) || [];
  renderModels();
  if (detected.length) send({ type: 'warmup' }); // muat model ke memori selagi pengguna mengatur pilihan
}

function renderModels() {
  const sel = $('model');
  if (!detected.length) {
    $('status').textContent = 'Tidak ada server LLM lokal terdeteksi';
    sel.innerHTML = '<option value="">— nyalakan Ollama / LM Studio (tetap bisa isi dengan data lokal) —</option>';
    return;
  }
  $('status').textContent = 'Terhubung: ' + detected.map((d) => d.endpoint.name).join(', ');
  const opts = [];
  let count = 0;
  for (const d of detected) {
    for (const m of d.models.filter((x) => x.chat)) {
      count++;
      const value = d.endpoint.id + '::' + m.id;
      opts.push('<option value="' + value + '">' + m.label + (m.detail ? ' — ' + m.detail : '') + (d.recommended === m.id ? ' ★' : '') + '</option>');
    }
  }
  sel.innerHTML = '<option value="">Otomatis (rekomendasi ★)</option>' + opts.join('');
  const cur = settings.endpointId && settings.model ? settings.endpointId + '::' + settings.model : '';
  sel.value = Array.prototype.some.call(sel.options, (o) => o.value === cur) ? cur : '';
  $('modelHint').textContent = count + ' model tersedia';
}

async function persist() {
  const parts = $('model').value ? $('model').value.split('::') : ['', ''];
  const siteNotes = Object.assign({}, settings.siteNotes);
  if (host) siteNotes[host] = $('siteNotes').value.trim();
  Object.assign(settings, { mode: $('mode').value, strategy: $('strategy').value, locale: $('locale').value, overwrite: $('overwrite').checked, includePassword: $('includePassword').checked, endpointId: parts[0], model: parts[1] || '', siteNotes });
  const stored = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: Object.assign({}, stored.settings || {}, settings) });
}

async function run(type, btn) {
  await persist();
  btn.disabled = true;
  $('result').textContent = 'Memproses…';
  const res = await send({ type });
  btn.disabled = false;
  const d = res && res.data;
  if (!res || !res.ok) { $('result').textContent = 'Gagal: ' + ((res && res.error) || 'tidak ada respons'); return; }
  if (type === 'fill') $('result').textContent = d.error && !d.filled ? d.error : (d.filled || 0) + ' field terisi' + (d.model ? ' (' + d.model + ')' : '');
  else if (type === 'undo') $('result').textContent = (d.reverted || 0) + ' field dikembalikan';
  else $('result').textContent = (d.fixed || 0) + ' field diperbaiki';
}

$('fill').addEventListener('click', () => run('fill', $('fill')));
$('undo').addEventListener('click', () => run('undo', $('undo')));
$('fix').addEventListener('click', () => run('fixErrors', $('fix')));
$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
load();
