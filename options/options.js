'use strict';
const $ = (id) => document.getElementById(id);
const DEFAULT_ENDPOINTS = self.AIFF.providers.DEFAULT_ENDPOINTS;
let s = null;
let endpoints = [];

async function load() {
  const stored = await chrome.storage.local.get('settings');
  s = Object.assign({ temperature: 0.7, chunkSize: 24, timeoutSec: 120, seed: '', keepPersona: true, highlight: true, userContext: '', allowedHosts: '', siteNotes: {}, endpoints: [] }, stored.settings || {});
  endpoints = (s.endpoints && s.endpoints.length ? s.endpoints : DEFAULT_ENDPOINTS).map((e) => Object.assign({ enabled: true }, e));
  for (const k of ['temperature', 'chunkSize', 'timeoutSec', 'seed', 'userContext', 'allowedHosts']) $(k).value = s[k];
  $('keepPersona').checked = !!s.keepPersona;
  $('highlight').checked = !!s.highlight;
  renderEndpoints();
  renderNotes();
}

function renderEndpoints() {
  const tb = $('endpoints').querySelector('tbody');
  tb.innerHTML = '';
  endpoints.forEach((e, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><input type="text" data-k="name"></td><td><input type="text" data-k="url"></td>' +
      '<td><select data-k="api"><option value="ollama">Ollama</option><option value="openai">OpenAI-compatible</option></select></td>' +
      '<td><input type="text" data-k="apiKey" placeholder="opsional"></td><td><input type="checkbox" data-k="enabled"></td><td><button data-del="1">Hapus</button></td>';
    for (const el of tr.querySelectorAll('[data-k]')) {
      const k = el.dataset.k;
      if (el.type === 'checkbox') { el.checked = e[k] !== false; el.addEventListener('change', () => { endpoints[i][k] = el.checked; }); }
      else { el.value = e[k] || ''; el.addEventListener('input', () => { endpoints[i][k] = el.value; }); }
    }
    tr.querySelector('[data-del]').addEventListener('click', () => { endpoints.splice(i, 1); renderEndpoints(); });
    tb.appendChild(tr);
  });
}

function renderNotes() {
  const tb = $('notes').querySelector('tbody');
  tb.innerHTML = '';
  const entries = Object.entries(s.siteNotes || {});
  if (!entries.length) { tb.innerHTML = '<tr><td colspan="3" class="hint">Belum ada. Tulis dari popup ekstensi saat berada di situs terkait.</td></tr>'; return; }
  for (const [host, note] of entries) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td><td></td><td><button>Hapus</button></td>';
    tr.children[0].textContent = host;
    tr.children[1].textContent = note;
    tr.querySelector('button').addEventListener('click', () => { delete s.siteNotes[host]; renderNotes(); });
    tb.appendChild(tr);
  }
}

async function save() {
  const patch = {
    temperature: Number($('temperature').value) || 0.7,
    chunkSize: Math.max(5, Number($('chunkSize').value) || 24),
    timeoutSec: Math.max(10, Number($('timeoutSec').value) || 120),
    seed: $('seed').value.trim(),
    keepPersona: $('keepPersona').checked,
    highlight: $('highlight').checked,
    userContext: $('userContext').value,
    allowedHosts: $('allowedHosts').value,
    siteNotes: s.siteNotes || {},
    endpoints: JSON.stringify(endpoints) === JSON.stringify(DEFAULT_ENDPOINTS.map((e) => Object.assign({ enabled: true }, e))) ? [] : endpoints.filter((e) => e.url),
  };
  const stored = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: Object.assign({}, stored.settings || {}, patch) });
  await chrome.storage.session.remove('detectCache');
  $('saved').textContent = 'Tersimpan ✓';
  setTimeout(() => { $('saved').textContent = ''; }, 2000);
}

$('addEndpoint').addEventListener('click', () => { endpoints.push({ id: 'custom' + Date.now(), name: 'Server kustom', url: 'http://localhost:8000', api: 'openai', enabled: true }); renderEndpoints(); });
$('resetEndpoints').addEventListener('click', () => { endpoints = DEFAULT_ENDPOINTS.map((e) => Object.assign({ enabled: true }, e)); renderEndpoints(); });
$('testEndpoints').addEventListener('click', async () => {
  $('detectOut').textContent = 'Memeriksa…';
  const found = await self.AIFF.providers.detect(endpoints, 2500);
  $('detectOut').textContent = found.length ? found.map((f) => f.endpoint.name + ': ' + f.models.length + ' model').join(' · ') : 'Tidak ada server yang merespons (untuk Ollama via ekstensi, jalankan dulu Ollama).';
});
$('save').addEventListener('click', save);
$('export').addEventListener('click', async () => {
  const stored = await chrome.storage.local.get('settings');
  const blob = new Blob([JSON.stringify(stored.settings || {}, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'ai-form-fill-settings.json'; a.click();
});
$('importBtn').addEventListener('click', (e) => { e.preventDefault(); $('import').click(); });
$('import').addEventListener('change', async () => {
  const file = $('import').files[0]; if (!file) return;
  try { await chrome.storage.local.set({ settings: JSON.parse(await file.text()) }); await load(); $('saved').textContent = 'Diimpor ✓'; } catch (e) { $('saved').textContent = 'File tidak valid'; }
});
load();
