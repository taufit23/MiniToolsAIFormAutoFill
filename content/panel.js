/* window.__aiFillPanel: kartu status melayang (Shadow DOM, hanya di frame atas). Menampilkan progres, ringkasan isian, dan tombol Undo / Perbaiki error / Isi ulang. */
(function () {
  'use strict';
  if (window.__aiFillPanel) return;
  let host = null; let root = null; let hideTimer = null;

  const CSS = `
    :host{all:initial;color-scheme:light}
    .card{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:340px;max-height:70vh;display:flex;flex-direction:column;font:13px/1.45 system-ui,Segoe UI,sans-serif;color:#0f172a;background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 10px 30px rgba(15,23,42,.18);overflow:hidden}
    .head{display:flex;align-items:center;gap:8px;padding:10px 12px;font-weight:600}
    .dot{width:8px;height:8px;border-radius:50%;background:#8b5cf6;flex:none}.dot.busy{animation:p 1s infinite}.dot.err{background:#ef4444}.dot.ok{background:#22c55e}
    @keyframes p{50%{opacity:.25}}
    .x{margin-left:auto;cursor:pointer;border:0;background:none;font-size:16px;color:inherit;opacity:.6}
    .body{padding:0 12px 10px}.muted{color:#64748b;font-size:12px}
    .list{overflow:auto;max-height:34vh;border-top:1px solid #e2e8f0}
    .row{display:flex;gap:8px;padding:5px 12px;border-bottom:1px solid #f1f5f9;font-size:12px}
    .row b{flex:0 0 38%;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .tag{flex:none;font-size:10px;padding:1px 6px;border-radius:99px;background:#ede9fe;color:#6d28d9}.tag.h{background:#e0f2fe;color:#0369a1}
    .actions{display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px;border-top:1px solid #e2e8f0}
    .btn{cursor:pointer;border:1px solid #cbd5e1;background:#f8fafc;border-radius:8px;padding:5px 10px;font:inherit;font-size:12px}
    .btn.primary{background:#7c3aed;border-color:#7c3aed;color:#fff}
  `;

  function ensure() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = 'aifill-panel-host';
    root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style'); style.textContent = CSS; root.appendChild(style);
    (document.documentElement || document.body).appendChild(host);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  /** state: { status: 'busy'|'ok'|'err', title, message, items?: [{label,value,source}], actions?: [{id,label,primary}] } */
  function show(state) {
    ensure();
    clearTimeout(hideTimer);
    const old = root.querySelector('.card'); if (old) old.remove();
    const card = document.createElement('div'); card.className = 'card';
    const items = (state.items || []).slice(0, 80);
    card.innerHTML =
      '<div class="head"><span class="dot ' + esc(state.status || '') + (state.status === 'busy' ? ' busy' : '') + '"></span><span>' + esc(state.title || 'AI Form Fill') + '</span><button class="x" title="Tutup">×</button></div>' +
      '<div class="body">' + (state.message ? '<div class="muted">' + esc(state.message) + '</div>' : '') + '</div>' +
      (items.length ? '<div class="list">' + items.map((i) => '<div class="row"><b title="' + esc(i.label) + '">' + esc(i.label || i.id) + '</b><span title="' + esc(i.value) + '">' + esc(i.value) + '</span><i class="tag ' + (i.source === 'ai' ? '' : 'h') + '">' + (i.source === 'ai' ? 'AI' : 'lokal') + '</i></div>').join('') + '</div>' : '') +
      ((state.actions || []).length ? '<div class="actions">' + state.actions.map((a) => '<button class="btn' + (a.primary ? ' primary' : '') + '" data-a="' + esc(a.id) + '">' + esc(a.label) + '</button>').join('') + '</div>' : '');
    card.querySelector('.x').addEventListener('click', hide);
    for (const b of card.querySelectorAll('[data-a]')) b.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'panelAction', action: b.getAttribute('data-a') }));
    root.appendChild(card);
    if (state.autoHideMs) hideTimer = setTimeout(hide, state.autoHideMs);
  }
  function hide() { if (host) { host.remove(); host = null; root = null; } }

  window.__aiFillPanel = { show, hide };
})();
