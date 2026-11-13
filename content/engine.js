/* window.__aiFill: mesin di dalam halaman. scan() membaca field form (termasuk shadow DOM, dialog/modal, komponen kustom ARIA),
 * apply() mengisi dengan event yang dimengerti Vue/React, undo() mengembalikan, collectErrors() membaca pesan galat validasi. */
(function () {
  'use strict';
  if (window.__aiFill && window.__aiFill.version >= 2) return;

  const registry = new Map(); // id -> { el|els, field }
  let history = []; // [{ el, kind, prev }]
  let seq = 0;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));

  // ── util DOM ────────────────────────────────────────────────────────────────
  function* deepQuery(root, selector) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (node.querySelectorAll) {
        for (const el of node.querySelectorAll(selector)) yield el;
        for (const host of node.querySelectorAll('*')) if (host.shadowRoot) stack.push(host.shadowRoot);
      }
    }
  }
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    // checkVisibility (Chrome 105+) memperhitungkan leluhur yang display:none / content-visibility, tidak hanya elemen itu sendiri.
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true })) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (cs.opacity !== '' && parseFloat(cs.opacity) === 0 && el.type !== 'checkbox' && el.type !== 'radio') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0 || el.type === 'checkbox' || el.type === 'radio';
  }
  const text = (n) => (n && n.textContent ? n.textContent.replace(/\s+/g, ' ').trim() : '');

  function labelOf(el) {
    const bits = [];
    if (el.labels && el.labels.length) bits.push(text(el.labels[0]));
    const aria = el.getAttribute('aria-label');
    if (aria) bits.push(aria);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) bits.push(lb.split(/\s+/).map((id) => text(document.getElementById(id))).join(' '));
    if (!bits.filter(Boolean).length) {
      // label yang langsung mendahului kontrol (mis. <label>Notifikasi</label><button role="switch">)
      const pv = el.previousElementSibling;
      if (pv && pv.tagName === 'LABEL' && !pv.querySelector('input,select,textarea,button') && text(pv).length < 80) bits.push(text(pv));
    }
    if (!bits.filter(Boolean).length) {
      // Nuxt UI / pola umum: <div><label>…</label><div><input></div></div>
      let p = el.parentElement;
      for (let i = 0; p && i < 4; i++, p = p.parentElement) {
        const l = p.querySelector(':scope > label, :scope > [data-slot="label"], :scope > .label');
        if (l && !l.contains(el)) { bits.push(text(l)); break; }
        const prev = p.previousElementSibling;
        if (prev && /^(LABEL|SPAN|DIV|P|LEGEND)$/.test(prev.tagName) && text(prev).length < 80 && !prev.querySelector('input,select,textarea')) { bits.push(text(prev)); break; }
      }
    }
    const t = bits.filter(Boolean)[0] || el.getAttribute('title') || el.placeholder || '';
    return t.replace(/\s*\*+\s*$/, '').replace(/\s*\(wajib\)\s*$/i, '').trim();
  }
  function sectionOf(el) {
    const fs = el.closest('fieldset');
    if (fs) { const lg = fs.querySelector(':scope > legend'); if (lg) return text(lg); }
    let p = el.parentElement;
    for (let i = 0; p && i < 8; i++, p = p.parentElement) {
      const h = p.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > header h1, :scope > header h2, :scope > header h3, :scope > [data-slot="title"], :scope > [data-slot="header"]');
      if (h && !h.contains(el)) return text(h).slice(0, 80);
    }
    return '';
  }
  function hintOf(el) {
    const d = el.getAttribute('aria-describedby');
    if (d) return d.split(/\s+/).map((id) => text(document.getElementById(id))).join(' ').slice(0, 160);
    return '';
  }
  function isRequired(el, label) {
    if (el.required || el.getAttribute('aria-required') === 'true') return true;
    const l = el.labels && el.labels[0] ? text(el.labels[0]) : '';
    return /\*\s*$/.test(l) || /\*\s*$/.test(label || '');
  }

  // ── pemilihan cakupan ───────────────────────────────────────────────────────
  function openDialog() {
    const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open]')].filter(isVisible);
    return dialogs.length ? dialogs[dialogs.length - 1] : null;
  }
  function scopeRoot(scope) {
    if (scope === 'focused') {
      const a = document.activeElement;
      if (a && a !== document.body) return a.closest('form') || a.closest('[role="dialog"]') || a.parentElement || document;
    }
    return openDialog() || document;
  }

  const SKIP_INPUT = new Set(['hidden', 'submit', 'button', 'image', 'reset', 'file']);

  // ── scan ────────────────────────────────────────────────────────────────────
  function scan(opts) {
    opts = Object.assign({ scope: 'auto', overwrite: false, includePassword: true, onlyElement: false, keep: false }, opts || {});
    if (!opts.keep) registry.clear();
    const root = opts.onlyElement && document.activeElement && document.activeElement !== document.body ? document.activeElement.parentElement || document : scopeRoot(opts.scope);
    const selector = 'input, select, textarea, [contenteditable=""], [contenteditable="true"], [role="combobox"], [role="switch"], [role="checkbox"], [role="radiogroup"]';
    const fields = [];
    const radioGroups = new Map();
    const seen = new Set();
    const skipped = [];

    for (const el of deepQuery(root, selector)) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (opts.onlyElement && el !== document.activeElement) continue;
      const tag = el.tagName;
      const role = el.getAttribute('role');
      let kind = null;

      if (tag === 'INPUT') {
        const t = (el.type || 'text').toLowerCase();
        if (SKIP_INPUT.has(t)) { if (t === 'file') skipped.push({ reason: 'file', label: labelOf(el) }); continue; }
        if (t === 'password' && !opts.includePassword) continue;
        kind = t === 'checkbox' ? 'checkbox' : t === 'radio' ? 'radio' : t;
        if (role === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') kind = 'combobox';
        if (el.getAttribute('role') === 'switch') kind = 'switch';
      } else if (tag === 'TEXTAREA') kind = 'textarea';
      else if (tag === 'SELECT') kind = el.multiple ? 'multiselect' : 'select';
      else if (role === 'combobox') kind = 'combobox';
      else if (role === 'switch') kind = 'switch';
      else if (role === 'checkbox') kind = 'checkbox';
      else if (role === 'radiogroup') continue; // item radio diproses lewat input[type=radio] / [role=radio]
      else if (el.isContentEditable) kind = 'contenteditable';
      if (!kind) continue;

      if (!isVisible(el) && !(kind === 'checkbox' || kind === 'radio' || kind === 'switch')) continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      if (el.readOnly && kind !== 'combobox') continue;
      if (el.closest('[hidden],[aria-hidden="true"]') && !el.closest('[role="dialog"]')) continue;
      if (/captcha|recaptcha|honeypot/i.test((el.name || '') + (el.id || '') + (el.className || ''))) { skipped.push({ reason: 'captcha', label: el.name || el.id }); continue; }

      const label = labelOf(el);
      const base = {
        kind, label, name: el.getAttribute('name') || '', domId: el.id || '', placeholder: el.getAttribute('placeholder') || '',
        autocomplete: el.getAttribute('autocomplete') || '', section: sectionOf(el), hint: hintOf(el), required: isRequired(el, label),
        ariaLabel: el.getAttribute('aria-label') || '',
      };

      if (kind === 'radio') {
        const g = (el.name ? 'n:' + el.name : 'e:' + (el.closest('[role="radiogroup"]') ? 'rg' : '') + seq) + '|' + (el.form ? 'f' : '');
        let grp = radioGroups.get(g);
        if (!grp) {
          grp = Object.assign({}, base, { kind: 'radio', options: [], els: [] });
          grp.label = sectionOfRadio(el) || (el.closest('fieldset') && text(el.closest('fieldset').querySelector('legend'))) || base.label;
          radioGroups.set(g, grp); fields.push(grp);
        }
        grp.options.push({ value: el.value, label: optionLabel(el) || el.value });
        grp.els.push(el);
        if (el.checked) grp.currentValue = el.value;
        continue;
      }

      const f = base;
      if (kind === 'select' || kind === 'multiselect') {
        f.options = [...el.options].map((o) => ({ value: o.value, label: text(o) || o.value })).filter((o) => o.value !== '');
        f.currentValue = kind === 'multiselect' ? [...el.selectedOptions].map((o) => o.value).join(',') : el.value;
      } else if (kind === 'checkbox' || kind === 'switch') {
        f.currentValue = (el.checked !== undefined && tag === 'INPUT') ? String(el.checked) : String(el.getAttribute('aria-checked') === 'true');
      } else if (kind === 'contenteditable') {
        f.currentValue = text(el);
      } else if (kind === 'combobox') {
        f.currentValue = el.value || text(el);
      } else {
        f.currentValue = el.value || '';
        if (el.maxLength > 0 && el.maxLength < 100000) f.maxLength = el.maxLength;
        if (el.minLength > 0) f.minLength = el.minLength;
        for (const a of ['min', 'max', 'step', 'pattern']) { const v = el.getAttribute(a); if (v !== null && v !== '') f[a] = v; }
        if (el.getAttribute('inputmode') === 'numeric' && !f.pattern) f.pattern = '\\d*';
      }

      if (!opts.overwrite && f.currentValue && f.currentValue !== 'false' && kind !== 'select' && kind !== 'multiselect') continue;
      if (!opts.overwrite && (kind === 'select') && f.currentValue && el.selectedIndex > 0) continue;
      f.id = 'f' + (++seq);
      registry.set(f.id, { el, field: f });
      fields.push(f);
    }

    for (const g of radioGroups.values()) {
      if (!opts.overwrite && g.currentValue) { fields.splice(fields.indexOf(g), 1); continue; }
      g.id = 'f' + (++seq);
      registry.set(g.id, { els: g.els, field: g });
      delete g.els;
    }
    const clean = fields.filter((f) => f.id).map((f) => { const c = Object.assign({}, f); delete c.els; return c; });
    const heading = text(document.querySelector('h1')) || text(document.querySelector('[data-slot="title"]')) || '';
    return { fields: clean, skipped, page: { title: document.title, host: location.host, path: location.pathname, heading: heading.slice(0, 100) }, scopedToDialog: root !== document && !!openDialog() };
  }
  function sectionOfRadio(el) {
    const g = el.closest('[role="radiogroup"]') || el.closest('div');
    if (!g) return '';
    const lead = [...g.querySelectorAll('legend,label,span,p')].find((n) => !n.querySelector('input') && !n.contains(el) && !(n.tagName === 'LABEL' && n.control));
    return lead ? text(lead).replace(/[:：]\s*$/, '').slice(0, 60) : '';
  }
  function optionLabel(el) {
    if (el.labels && el.labels[0]) return text(el.labels[0]);
    const p = el.closest('label'); if (p) return text(p);
    const n = el.nextElementSibling || (el.parentElement && el.parentElement.nextElementSibling);
    return text(n).slice(0, 60);
  }

  // ── isi ─────────────────────────────────────────────────────────────────────
  function nativeSet(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
  }
  function fire(el, types) {
    for (const t of types) {
      if (t === 'input') el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
      else el.dispatchEvent(new Event(t, { bubbles: true }));
    }
  }
  function mark(el, source) {
    try {
      el.style.outline = '2px solid ' + (source === 'ai' ? '#8b5cf6' : '#0ea5e9');
      el.style.outlineOffset = '1px';
      el.dataset.aiFilled = source;
      setTimeout(() => { if (el.dataset.aiFilled) { el.style.outline = ''; el.style.outlineOffset = ''; } }, 6000);
    } catch (e) { /* abaikan */ }
  }

  async function fillCombobox(el, wanted, strict) {
    const w = String(wanted || '').toLowerCase().trim();
    const isInput = el.tagName === 'INPUT';
    el.focus();
    el.click();
    if (isInput && w) { nativeSet(el, String(wanted)); fire(el, ['input']); }
    await sleep(250);
    const listId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    let list = listId ? document.getElementById(listId) : null;
    if (!list) list = [...document.querySelectorAll('[role="listbox"]')].filter(isVisible).pop();
    const items = list ? [...list.querySelectorAll('[role="option"]')].filter(isVisible) : [...document.querySelectorAll('[role="option"]')].filter(isVisible);
    if (!items.length) { if (strict) closeList(el); return false; }
    let pick = items.find((i) => text(i).toLowerCase() === w) || items.find((i) => w && text(i).toLowerCase().includes(w)) || items.find((i) => w && w.includes(text(i).toLowerCase()) && text(i));
    // Mode ketat (pasang isian tersimpan): jangan menebak. Bila pilihan yang sama belum ada (mis. opsi dari API belum dimuat), gagal agar dicoba lagi.
    if (!pick && strict) { closeList(el); return false; }
    if (!pick) pick = items.find((i) => !i.getAttribute('aria-disabled')) || items[0];
    pick.click();
    await sleep(80);
    return true;
  }

  function closeList(el) {
    try { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); } catch (e) { /* abaikan */ }
  }

  async function apply(items, opts) {
    opts = Object.assign({ highlight: true }, opts || {});
    const results = [];
    for (const it of items) {
      const entry = registry.get(it.id);
      if (!entry) { results.push({ id: it.id, ok: false, reason: 'tidak ditemukan' }); continue; }
      try {
        const ok = await applyOne(entry, it.value, it.source, opts);
        results.push({ id: it.id, ok });
      } catch (e) {
        results.push({ id: it.id, ok: false, reason: String(e && e.message || e) });
      }
    }
    return results;
  }

  async function applyOne(entry, value, source, opts) {
    const f = entry.field; const el = entry.el;
    if (f.kind === 'radio') {
      const target = entry.els.find((r) => r.value === value) || entry.els[0];
      history.push({ el: target, kind: 'radio-group', prev: entry.els.map((r) => r.checked), els: entry.els });
      target.click();
      if (opts.highlight) mark(target, source);
      return true;
    }
    if (f.kind === 'checkbox' || f.kind === 'switch') {
      const cur = el.tagName === 'INPUT' ? el.checked : el.getAttribute('aria-checked') === 'true';
      history.push({ el, kind: 'toggle', prev: cur });
      if (cur !== !!value) el.click();
      if (opts.highlight) mark(el, source);
      return true;
    }
    if (f.kind === 'select') {
      history.push({ el, kind: 'value', prev: el.value });
      nativeSet(el, String(value)); fire(el, ['input', 'change']);
      if (opts.highlight) mark(el, source);
      return el.value === String(value);
    }
    if (f.kind === 'multiselect') {
      const want = new Set((Array.isArray(value) ? value : [value]).map(String));
      history.push({ el, kind: 'multiselect', prev: [...el.options].map((o) => o.selected) });
      for (const o of el.options) o.selected = want.has(o.value);
      fire(el, ['input', 'change']);
      if (opts.highlight) mark(el, source);
      return true;
    }
    if (f.kind === 'combobox') {
      history.push({ el, kind: 'value', prev: el.value || '' });
      const ok = await fillCombobox(el, value);
      if (opts.highlight) mark(el, source);
      return ok;
    }
    if (f.kind === 'contenteditable') {
      history.push({ el, kind: 'text', prev: el.textContent });
      el.focus(); el.textContent = String(value); fire(el, ['input']);
      if (opts.highlight) mark(el, source);
      return true;
    }
    // input teks/angka/tanggal/dll + textarea
    history.push({ el, kind: 'value', prev: el.value });
    el.focus();
    nativeSet(el, String(value));
    fire(el, ['input', 'change']);
    el.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    if (opts.highlight) mark(el, source);
    return true;
  }

  function undo() {
    let n = 0;
    for (const h of history.reverse()) {
      try {
        if (h.kind === 'value') { nativeSet(h.el, h.prev); fire(h.el, ['input', 'change']); }
        else if (h.kind === 'text') { h.el.textContent = h.prev; fire(h.el, ['input']); }
        else if (h.kind === 'toggle') { const cur = h.el.tagName === 'INPUT' ? h.el.checked : h.el.getAttribute('aria-checked') === 'true'; if (cur !== h.prev) h.el.click(); }
        else if (h.kind === 'multiselect') { [...h.el.options].forEach((o, i) => { o.selected = h.prev[i]; }); fire(h.el, ['input', 'change']); }
        else if (h.kind === 'radio-group') { h.els.forEach((r, i) => { r.checked = h.prev[i]; }); fire(h.els[0], ['change']); }
        h.el.style.outline = ''; delete h.el.dataset.aiFilled; n++;
      } catch (e) { /* lanjut */ }
    }
    history = [];
    return n;
  }

  // ── galat validasi (untuk "Perbaiki error") ─────────────────────────────────
  function collectErrors() {
    const out = [];
    const seenEl = new Set();
    for (const el of deepQuery(document, 'input, select, textarea, [role="combobox"]')) {
      if (seenEl.has(el) || !isVisible(el)) continue;
      const invalidAria = el.getAttribute('aria-invalid') === 'true';
      const invalidNative = typeof el.checkValidity === 'function' && !el.checkValidity();
      if (!invalidAria && !invalidNative) continue;
      seenEl.add(el);
      let msg = el.validationMessage || '';
      const d = el.getAttribute('aria-describedby');
      if (d) msg = d.split(/\s+/).map((id) => text(document.getElementById(id))).filter(Boolean).join(' ') || msg;
      if (!msg) { const p = el.closest('[class*="field"],[data-slot="root"],div'); const e = p && p.querySelector('[role="alert"],.text-error,[class*="error"],[data-slot="error"]'); msg = text(e); }
      out.push({ el, label: labelOf(el), message: msg.slice(0, 200) });
    }
    return out;
  }
  /** Scan ulang hanya untuk field yang sedang bermasalah, dengan pesan galatnya. */
  function scanInvalid() {
    registry.clear();
    const errs = collectErrors();
    const fields = []; const fixes = [];
    for (const e of errs) {
      const sub = scanSingle(e.el);
      if (!sub) continue;
      fields.push(sub);
      fixes.push({ id: sub.id, label: sub.label, error: e.message, current: sub.currentValue || '' });
    }
    return { fields, fixes, page: { title: document.title, host: location.host, path: location.pathname, heading: text(document.querySelector('h1')).slice(0, 100) } };
  }
  function scanSingle(el) {
    const prevActive = document.activeElement;
    try { el.focus(); } catch (e) { /* abaikan */ }
    const r = scan({ onlyElement: true, overwrite: true, keep: true });
    if (prevActive && prevActive.focus) { try { prevActive.focus(); } catch (e) { /* abaikan */ } }
    return r.fields[0] || null;
  }

  // ── simpan & pasang isian ───────────────────────────────────────────────────
  // snapshot() membaca SEMUA isian yang terlihat (termasuk yang sudah terisi); restore() memasangnya kembali ke field yang cocok,
  // mengulang beberapa putaran supaya dropdown yang opsinya baru dimuat (bergantung dropdown lain / API) sempat tersedia.
  function kindOf(el) {
    const tag = el.tagName; const role = el.getAttribute('role');
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      if (SKIP_INPUT.has(t)) return null;
      if (role === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') return 'combobox';
      if (role === 'switch') return 'switch';
      return t === 'checkbox' ? 'checkbox' : t === 'radio' ? 'radio' : t;
    }
    if (tag === 'TEXTAREA') return 'textarea';
    if (tag === 'SELECT') return el.multiple ? 'multiselect' : 'select';
    if (role === 'combobox') return 'combobox';
    if (role === 'switch') return 'switch';
    if (role === 'checkbox') return 'checkbox';
    if (el.isContentEditable && role !== 'radiogroup') return 'contenteditable';
    return null;
  }
  // id bawaan framework (v-0-1, reka-…, :r1:) berubah tiap muat ulang, jadi tidak dipakai sebagai kunci.
  const stableId = (id) => (id && !/\d{2,}|^[:_]|reka|radix|headless|^v-|^ui-/i.test(id) ? id : '');
  const frameTag = () => (window === window.top ? 'top' : location.origin + location.pathname);
  const EMPTY_COMBO = /^(pilih|select|choose|search|cari|--)/i;

  function collect(opts) {
    const root = scopeRoot('auto');
    const selector = 'input, select, textarea, [contenteditable=""], [contenteditable="true"], [role="combobox"], [role="switch"], [role="checkbox"]';
    const out = []; const groups = new Map(); const seen = new Set();
    for (const el of deepQuery(root, selector)) {
      if (seen.has(el)) continue;
      seen.add(el);
      const kind = kindOf(el);
      if (!kind) continue;
      if (kind === 'password' && !opts.includePassword) continue;
      const toggle = kind === 'checkbox' || kind === 'radio' || kind === 'switch';
      if (!isVisible(el) && !toggle) continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      if (el.readOnly && kind !== 'combobox') continue;
      if (el.closest('[hidden],[aria-hidden="true"]') && !el.closest('[role="dialog"]')) continue;
      if (/captcha|recaptcha|honeypot/i.test((el.name || '') + (el.id || '') + (el.className || ''))) continue;
      const label = labelOf(el);
      const base = { kind, label, name: el.getAttribute('name') || '', domId: stableId(el.id), section: sectionOf(el), placeholder: el.getAttribute('placeholder') || '' };
      if (kind === 'radio') {
        const g = (el.name ? 'n:' + el.name : 'e:' + out.length) + '|' + (el.form ? 'f' : '');
        let grp = groups.get(g);
        if (!grp) {
          grp = Object.assign({}, base, { els: [] });
          grp.label = sectionOfRadio(el) || (el.closest('fieldset') && text(el.closest('fieldset').querySelector('legend'))) || base.label;
          groups.set(g, grp); out.push(grp);
        }
        grp.els.push(el);
        if (el.checked) grp.value = el.value;
        continue;
      }
      const c = base; c.el = el;
      if (kind === 'select') { c.value = el.value; c.text = el.selectedIndex >= 0 ? text(el.options[el.selectedIndex]) : ''; }
      else if (kind === 'multiselect') c.value = [...el.selectedOptions].map((o) => o.value);
      else if (kind === 'checkbox' || kind === 'switch') c.value = el.tagName === 'INPUT' ? el.checked : el.getAttribute('aria-checked') === 'true';
      else if (kind === 'contenteditable') c.value = text(el);
      else if (kind === 'combobox') { const t = el.tagName === 'INPUT' ? el.value : text(el); c.value = EMPTY_COMBO.test(t) || t === base.placeholder ? '' : t; }
      else c.value = el.value || '';
      out.push(c);
    }
    return out;
  }
  const hasValue = (c) => (Array.isArray(c.value) ? c.value.length > 0 : c.value !== '' && c.value !== undefined && c.value !== null);
  const strongKey = (c) => [c.kind, c.domId, c.name, c.label, c.section].join('|');
  const weakKey = (c) => [c.kind, c.name, c.label].join('|');

  function snapshot(opts) {
    opts = Object.assign({ includePassword: true }, opts || {});
    const tag = frameTag();
    // Teks/pilihan kosong tidak disimpan (tidak ada yang perlu dipulihkan); centang disimpan apa adanya supaya keadaan "tidak dicentang" juga kembali.
    const items = collect(opts).filter((c) => (c.kind === 'checkbox' || c.kind === 'switch') || hasValue(c))
      .map((c) => ({ frame: tag, kind: c.kind, label: c.label, name: c.name, domId: c.domId, section: c.section, value: c.value, text: c.text || '' }));
    const heading = text(document.querySelector('h1')) || text(document.querySelector('[data-slot="title"]')) || '';
    return { items, page: { title: document.title, host: location.host, path: location.pathname, heading: heading.slice(0, 100) } };
  }

  /** Cocokkan tiap isian tersimpan ke field yang ada: kunci kuat (id/name/label/seksi) + urutan kemunculan, lalu kunci lemah, lalu label saja. */
  function matchItems(items, current) {
    const strong = new Map(); const weak = new Map(); const byLabel = new Map();
    const push = (m, k, c) => { if (!m.has(k)) m.set(k, []); m.get(k).push(c); };
    for (const c of current) { push(strong, strongKey(c), c); push(weak, weakKey(c), c); push(byLabel, c.kind + '|' + c.label, c); }
    const used = new Set(); const seenStrong = new Map(); const pairs = [];
    for (const it of items) {
      const sk = strongKey(it); const occ = seenStrong.get(sk) || 0; seenStrong.set(sk, occ + 1);
      let target = (strong.get(sk) || [])[occ];
      if (!target || used.has(target)) target = (weak.get(weakKey(it)) || []).find((c) => !used.has(c));
      if (!target && it.label) target = (byLabel.get(it.kind + '|' + it.label) || []).find((c) => !used.has(c));
      if (target && !used.has(target)) { used.add(target); pairs.push({ item: it, target }); } else pairs.push({ item: it, target: null });
    }
    return pairs;
  }

  const same = (c, it) => {
    if (it.kind === 'multiselect') return [...(c.value || [])].sort().join(',') === [...(it.value || [])].sort().join(',');
    if (it.kind === 'combobox') return String(c.value).trim().toLowerCase() === String(it.value).trim().toLowerCase();
    return c.value === it.value;
  };

  async function restoreOne(c, it, opts) {
    const k = it.kind;
    if (k === 'radio') {
      if (!c.els.some((x) => x.value === it.value)) return false;
      return applyOne({ field: { kind: 'radio' }, els: c.els }, it.value, 'restore', opts);
    }
    if (k === 'select') {
      const opt = [...c.el.options].find((o) => o.value === it.value) || (it.text && [...c.el.options].find((o) => text(o) === it.text));
      if (!opt) return false;
      return applyOne({ field: { kind: 'select' }, el: c.el }, opt.value, 'restore', opts);
    }
    if (k === 'multiselect') {
      const have = new Set([...c.el.options].map((o) => o.value));
      if (!(it.value || []).every((v) => have.has(v))) return false;
      return applyOne({ field: { kind: 'multiselect' }, el: c.el }, it.value, 'restore', opts);
    }
    if (k === 'combobox') {
      history.push({ el: c.el, kind: 'value', prev: c.el.tagName === 'INPUT' ? c.el.value : '' });
      const ok = await fillCombobox(c.el, it.value, true);
      if (ok && opts.highlight) mark(c.el, 'restore');
      return ok;
    }
    return applyOne({ field: { kind: k }, el: c.el }, it.value, 'restore', opts);
  }

  async function restore(items, opts) {
    opts = Object.assign({ highlight: true, passes: 4, waitMs: 700, includePassword: true }, opts || {});
    const tag = frameTag();
    let todo = (items || []).filter((it) => !it.frame || it.frame === tag);
    const restored = []; let unchanged = 0;
    for (let pass = 0; pass < opts.passes && todo.length; pass++) {
      if (pass) await sleep(opts.waitMs);
      const pairs = matchItems(todo, collect({ includePassword: opts.includePassword }));
      const next = []; let progress = false;
      for (const { item, target } of pairs) {
        if (!target) { next.push(item); continue; }
        if (same(target, item)) { unchanged++; progress = true; continue; }
        let ok = false;
        try { ok = await restoreOne(target, item, opts); } catch (e) { ok = false; }
        if (ok) { progress = true; restored.push({ label: item.label || item.name, value: Array.isArray(item.value) ? item.value.join(', ') : String(item.value) }); } else next.push(item);
        await sleep(60); // beri waktu isian ini memicu dropdown / field turunannya
      }
      todo = next;
      if (!progress && pass > 0) break;
    }
    return { restored, unchanged, missing: todo.map((it) => it.label || it.name || it.kind) };
  }

  window.__aiFill = { version: 2, scan, apply, undo, collectErrors, scanInvalid, snapshot, restore, registrySize: () => registry.size, _internals: { labelOf, sectionOf, collect, matchItems } };
})();
