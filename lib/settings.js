/* AIFF.settings: pengaturan tersimpan (chrome.storage.local) dengan nilai bawaan. Dipakai service worker, popup, dan opsi. */
(function (root) {
  'use strict';
  const AIFF = (root.AIFF = root.AIFF || {});

  const DEFAULTS = {
    endpoints: [],            // kosong = pakai DEFAULT_ENDPOINTS; isi = daftar kustom (termasuk yang dimatikan)
    endpointId: '',           // '' = otomatis
    model: '',                // '' = otomatis (rekomendasi)
    mode: 'realistic',
    strategy: 'ai',           // ai = semua field oleh AI (paling koheren); hybrid = AI hanya untuk yang sulit, sisanya generator lokal (cepat)
    locale: 'id-ID',
    temperature: 0.7,
    chunkSize: 24,
    overwrite: false,         // timpa field yang sudah terisi
    includePassword: true,
    highlight: true,
    keepPersona: true,        // persona sama dalam 30 menit supaya alur banyak halaman konsisten
    seed: '',                 // angka tertentu = hasil heuristik yang bisa diulang
    userContext: '',          // konteks umum untuk semua situs
    siteNotes: {},            // { host: "aturan situs ini" }
    allowedHosts: '',         // kosong = semua; isi = daftar host dipisah koma/baris yang diizinkan
    timeoutSec: 120,
  };

  async function get() {
    const stored = await chrome.storage.local.get('settings');
    return Object.assign({}, DEFAULTS, stored.settings || {});
  }
  async function set(patch) {
    const cur = await get();
    const next = Object.assign({}, cur, patch);
    await chrome.storage.local.set({ settings: next });
    return next;
  }
  function hostAllowed(settings, host) {
    const list = String(settings.allowedHosts || '').split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!list.length) return true;
    return list.some((h) => host === h || host.endsWith('.' + h));
  }

  AIFF.settings = { DEFAULTS, get, set, hostAllowed };
})(typeof self !== 'undefined' ? self : globalThis);
