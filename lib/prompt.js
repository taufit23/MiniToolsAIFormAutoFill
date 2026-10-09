/* AIFF.prompt: susun prompt + skema keluaran untuk LLM, urai jawabannya, lalu rapikan agar lolos batasan field. */
(function (root) {
  'use strict';
  const AIFF = (root.AIFF = root.AIFF || {});
  const H = () => AIFF.heuristics;

  const MODES = {
    realistic: {
      label: 'Realistis (data valid & masuk akal)',
      rule: 'Isi dengan data fiktif yang realistis, valid, dan konsisten satu sama lain. Isi SEMUA field kecuali yang jelas opsional dan tidak relevan.',
    },
    required_only: {
      label: 'Hanya field wajib',
      rule: 'Isi HANYA field bertanda wajib (req=true). Field opsional dibiarkan kosong: jangan sertakan idnya.',
    },
    edge: {
      label: 'Batas (boundary / unik)',
      rule: 'Isi dengan nilai batas yang tetap valid: teks sepanjang batas maksimum, angka di nilai min/max, karakter khusus/aksen/Unicode yang sah, spasi di tengah. Tetap patuhi tipe, pola, dan pilihan yang tersedia.',
    },
    invalid: {
      label: 'Negatif (sengaja tidak valid)',
      rule: 'Isi dengan nilai yang SENGAJA tidak valid untuk memicu pesan validasi: format email/telepon salah, angka di luar min/max, teks melebihi batas, tanggal mustahil, field wajib dikosongkan "". Pilihan (select/radio) tetap diambil dari opsi yang ada.',
    },
  };

  const KIND_TYPE = {
    checkbox: 'boolean', switch: 'boolean', number: 'number', range: 'number', multiselect: 'array',
  };

  function compactField(f) {
    const o = { id: f.id, kind: f.kind };
    if (f.label) o.label = f.label;
    if (f.name && f.name !== f.label) o.name = f.name;
    if (f.placeholder) o.ph = f.placeholder;
    if (f.required) o.req = true;
    if (f.section) o.sec = f.section;
    if (f.autocomplete) o.ac = f.autocomplete;
    if (f.maxLength) o.max_len = f.maxLength;
    if (f.minLength) o.min_len = f.minLength;
    if (f.min !== undefined && f.min !== '') o.min = f.min;
    if (f.max !== undefined && f.max !== '') o.max = f.max;
    if (f.step && f.step !== 'any') o.step = f.step;
    if (f.pattern) o.pattern = f.pattern;
    if (f.hint) o.hint = f.hint;
    if (f.options && f.options.length) o.options = f.options.slice(0, 60).map((x) => (x.value === x.label ? x.label : { v: x.value, l: x.label }));
    if (f.currentValue) o.current = f.currentValue;
    return o;
  }

  /** JSON Schema keluaran (dipakai Ollama/OpenAI structured output). Enum untuk pilihan membuat jawaban pasti valid. */
  function buildSchema(fields, mode) {
    const props = {}; const required = [];
    for (const f of fields) {
      let s;
      const t = KIND_TYPE[f.kind];
      if (f.kind === 'select' || f.kind === 'radio') {
        const vals = (f.options || []).map((o) => o.value).filter((v) => v !== '');
        s = vals.length && mode !== 'invalid-free' ? { type: 'string', enum: vals } : { type: 'string' };
      } else if (f.kind === 'multiselect') {
        const vals = (f.options || []).map((o) => o.value);
        s = { type: 'array', items: vals.length ? { type: 'string', enum: vals } : { type: 'string' } };
      } else if (t === 'boolean') s = { type: 'boolean' };
      else if (t === 'number') s = { type: 'number' };
      else s = { type: 'string' };
      props[f.id] = s;
      if (mode !== 'required_only' || f.required) required.push(f.id);
    }
    return { type: 'object', properties: { values: { type: 'object', properties: props, required, additionalProperties: false } }, required: ['values'], additionalProperties: false };
  }

  function buildMessages(input) {
    const { fields, page = {}, mode = 'realistic', locale = 'id-ID', persona, siteNotes = '', userContext = '', fixes = null } = input;
    const m = MODES[mode] || MODES.realistic;
    const sys = [
      'Kamu adalah generator data uji untuk formulir web (QA ERP). Jawab HANYA dengan satu objek JSON: {"values":{"<id>": nilai, ...}}.',
      'Aturan nilai per kind: text/textarea/email/tel/url/search=string; number/range=angka; checkbox/switch=true|false; select/radio=NILAI (v) dari options, bukan labelnya;',
      'multiselect=array nilai; date="YYYY-MM-DD"; datetime-local="YYYY-MM-DDTHH:mm"; time="HH:mm"; month="YYYY-MM"; combobox=teks yang akan dicocokkan dengan opsi.',
      'Patuhi max_len, min_len, min, max, step, pattern, dan options yang diberikan. Bahasa isian bebas teks: ' + (locale.startsWith('id') ? 'Indonesia' : 'Inggris') + '.',
      'Gunakan identitas persona di bawah secara konsisten (nama, email, telepon, kota, perusahaan) bila field-nya sesuai. Jangan mengarang id yang tidak ada.',
      'MODE: ' + m.rule,
    ].join('\n');
    const lines = [];
    lines.push('Halaman: ' + (page.title || '-') + ' | ' + (page.host || '') + (page.path || ''));
    if (page.heading) lines.push('Judul/seksi utama: ' + page.heading);
    if (persona) lines.push('Persona: ' + JSON.stringify(persona));
    if (siteNotes) lines.push('Catatan aturan situs ini (WAJIB dipatuhi):\n' + siteNotes);
    if (userContext) lines.push('Konteks tambahan dari penguji:\n' + userContext);
    if (fixes) lines.push('Isian sebelumnya ditolak validasi. Perbaiki HANYA field berikut sesuai pesan galatnya:\n' + JSON.stringify(fixes));
    lines.push('Field:\n' + fields.map((f) => JSON.stringify(compactField(f))).join('\n'));
    return [{ role: 'system', content: sys }, { role: 'user', content: lines.join('\n\n') }];
  }

  /** Urai jawaban model: toleran terhadap pagar kode, teks pembuka, pikiran model (<think>), dan bentuk {values} / langsung map. */
  function parseResponse(text) {
    if (!text) return null;
    let s = String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const tryParse = (str) => { try { return JSON.parse(str); } catch (e) { return undefined; } };
    let obj = tryParse(s);
    if (obj === undefined) {
      const a = s.indexOf('{'); const b = s.lastIndexOf('}');
      if (a >= 0 && b > a) obj = tryParse(s.slice(a, b + 1));
    }
    if (!obj || typeof obj !== 'object') return null;
    const values = obj.values && typeof obj.values === 'object' ? obj.values : obj;
    return values;
  }

  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function bestOption(options, wanted) {
    if (!options || !options.length) return null;
    const w = norm(wanted);
    let hit = options.find((o) => o.value === wanted) || options.find((o) => norm(o.label) === w || norm(o.value) === w);
    if (hit) return hit;
    hit = options.find((o) => w && (norm(o.label).includes(w) || w.includes(norm(o.label))) && norm(o.label));
    return hit || null;
  }

  /** Rapikan nilai mentah agar lolos batasan; mengembalikan {value, source, note} atau null (lewati). */
  function coerce(field, raw, ctx) {
    const mode = ctx.mode || 'realistic';
    const strict = mode !== 'invalid';
    let v = raw;
    const kind = field.kind;
    const h = H();

    if (v === undefined || v === null) return null;
    if (kind === 'select' || kind === 'radio') {
      const real = (field.options || []).filter((o) => o.value !== '' || kind === 'radio');
      const opt = bestOption(real, String(v));
      if (opt) return { value: opt.value, source: 'ai' };
      if (!real.length) return null;
      return { value: real[Math.min(real.length - 1, ctx.rng.int(0, real.length - 1))].value, source: 'heuristic', note: 'pilihan tidak cocok' };
    }
    if (kind === 'multiselect') {
      const arr = (Array.isArray(v) ? v : [v]).map((x) => bestOption(field.options, String(x))).filter(Boolean).map((o) => o.value);
      return { value: arr.length ? arr : [field.options[0] && field.options[0].value].filter(Boolean), source: 'ai' };
    }
    if (kind === 'checkbox' || kind === 'switch') {
      const b = typeof v === 'string' ? /^(true|ya|yes|1|on)$/i.test(v) : !!v;
      return { value: b, source: 'ai' };
    }
    if (kind === 'number' || kind === 'range') {
      let n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
      if (!Number.isFinite(n)) { const g = h.generate(field, ctx); return g == null ? null : { value: g, source: 'heuristic', note: 'angka tidak terbaca' }; }
      if (strict) n = h.clampNumber(field, n, ctx.rng);
      return { value: n, source: 'ai' };
    }

    v = String(v);
    if (kind === 'combobox') return { value: v, source: 'ai' };
    if (strict) {
      if (field.maxLength && v.length > field.maxLength) v = v.slice(0, field.maxLength);
      if (field.minLength && v.length < field.minLength) v = v + 'x'.repeat(field.minLength - v.length);
      if (kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { const g = h.generate(field, ctx); if (g) return { value: g, source: 'heuristic', note: 'email tidak valid' }; }
      if (field.pattern) {
        let ok = true;
        try { ok = new RegExp('^(?:' + field.pattern + ')$').test(v); } catch (e) { ok = true; }
        if (!ok) { const g = h.generate(field, ctx); if (g != null && String(g) !== v) return { value: String(g), source: 'heuristic', note: 'tidak sesuai pola' }; }
      }
      if (kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { const g = h.generate(field, ctx); if (g) return { value: g, source: 'heuristic', note: 'format tanggal' }; }
      if (kind === 'datetime-local' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) { const g = h.generate(field, ctx); if (g) return { value: g, source: 'heuristic', note: 'format tanggal-waktu' }; }
      if (kind === 'time' && !/^\d{2}:\d{2}/.test(v)) { const g = h.generate(field, ctx); if (g) return { value: g, source: 'heuristic', note: 'format jam' }; }
    }
    return { value: v, source: 'ai' };
  }

  /** Gabungkan jawaban AI dengan cadangan heuristik untuk field yang tidak terjawab. */
  function resolveValues(fields, aiValues, ctx) {
    const out = [];
    for (const f of fields) {
      const wantsEmpty = ctx.mode === 'required_only' && !f.required;
      if (wantsEmpty) continue;
      let r = null;
      if (aiValues && Object.prototype.hasOwnProperty.call(aiValues, f.id)) r = coerce(f, aiValues[f.id], ctx);
      if (!r && ctx.mode !== 'invalid') {
        const g = H().generate(f, ctx);
        if (g !== null && g !== undefined) r = coerce(f, g, ctx) || { value: g, source: 'heuristic' };
        if (r) r.source = 'heuristic';
      }
      if (r) out.push({ id: f.id, value: r.value, source: r.source, note: r.note || '' });
    }
    return out;
  }

  AIFF.prompt = { MODES, buildSchema, buildMessages, parseResponse, coerce, resolveValues, compactField, bestOption };
  if (typeof module !== 'undefined' && module.exports) module.exports = AIFF.prompt;
})(typeof self !== 'undefined' ? self : globalThis);
