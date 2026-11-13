/* AIFF.snapshots: isian form yang disimpan (chrome.storage.local) supaya bisa dipasang lagi setelah halaman dimuat ulang.
 * Disimpan per host + path halaman; paling banyak MAX_TOTAL entri, yang terlama dibuang. Data tidak keluar dari komputer. */
(function (root) {
  'use strict';
  const AIFF = (root.AIFF = root.AIFF || {});
  const KEY = 'snapshots';
  const MAX_TOTAL = 40;

  async function all() {
    const stored = await chrome.storage.local.get(KEY);
    return Array.isArray(stored[KEY]) ? stored[KEY] : [];
  }
  async function add({ host, path, name, title, items }) {
    const list = await all();
    const at = Date.now();
    const entry = { id: 's' + at.toString(36) + Math.random().toString(36).slice(2, 6), host, path, name: name || '', title: title || '', at, count: items.length, items };
    list.unshift(entry);
    await chrome.storage.local.set({ [KEY]: list.slice(0, MAX_TOTAL) });
    return entry;
  }
  /** Milik host ini, halaman yang sama lebih dulu, lalu yang terbaru. */
  async function listFor(host, path) {
    const list = (await all()).filter((e) => e.host === host);
    return list.sort((a, b) => (b.path === path) - (a.path === path) || b.at - a.at);
  }
  async function get(id) { return (await all()).find((e) => e.id === id) || null; }
  async function remove(id) { await chrome.storage.local.set({ [KEY]: (await all()).filter((e) => e.id !== id) }); }
  const summary = (e) => ({ id: e.id, host: e.host, path: e.path, name: e.name, title: e.title, at: e.at, count: e.count });

  AIFF.snapshots = { all, add, listFor, get, remove, summary, MAX_TOTAL };
})(typeof self !== 'undefined' ? self : this);
