/* AIFF.heuristics: pembuat data uji tanpa AI (cadangan + penyeimbang), data Indonesia, deterministik lewat seed.
 * Dipakai di service worker, halaman, dan Node (tes). Tanpa dependensi. */
(function (root) {
  'use strict';
  const AIFF = (root.AIFF = root.AIFF || {});

  // ── RNG berbenih (mulberry32) ───────────────────────────────────────────────
  function makeRng(seed) {
    let a = (seed >>> 0) || 1;
    const next = function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next.int = (min, max) => Math.floor(next() * (max - min + 1)) + min;
    next.pick = (arr) => arr[Math.floor(next() * arr.length)];
    next.digits = (n) => { let s = ''; for (let i = 0; i < n; i++) s += next.int(0, 9); return s; };
    return next;
  }

  const FIRST = ['Budi', 'Siti', 'Agus', 'Dewi', 'Rizky', 'Putri', 'Andi', 'Ayu', 'Hendra', 'Nur', 'Fajar', 'Rina', 'Dimas', 'Maya', 'Yoga', 'Intan', 'Bagas', 'Wulan', 'Eko', 'Citra'];
  const LAST = ['Santoso', 'Wijaya', 'Pratama', 'Kusuma', 'Hidayat', 'Saputra', 'Nugroho', 'Lestari', 'Rahmawati', 'Setiawan', 'Siregar', 'Nasution', 'Gunawan', 'Purnama', 'Hutapea', 'Maulana'];
  const PLACES = [
    ['Jakarta Selatan', 'DKI Jakarta', '12190'], ['Bandung', 'Jawa Barat', '40111'], ['Surabaya', 'Jawa Timur', '60271'],
    ['Medan', 'Sumatera Utara', '20112'], ['Semarang', 'Jawa Tengah', '50134'], ['Yogyakarta', 'DI Yogyakarta', '55281'],
    ['Denpasar', 'Bali', '80111'], ['Makassar', 'Sulawesi Selatan', '90111'], ['Padang', 'Sumatera Barat', '25111'],
    ['Palembang', 'Sumatera Selatan', '30111'], ['Balikpapan', 'Kalimantan Timur', '76111'], ['Malang', 'Jawa Timur', '65111'],
  ];
  const STREETS = ['Jl. Merdeka', 'Jl. Sudirman', 'Jl. Diponegoro', 'Jl. Ahmad Yani', 'Jl. Gatot Subroto', 'Jl. Melati', 'Jl. Kenanga', 'Jl. Pahlawan', 'Jl. Veteran', 'Jl. Raya Industri'];
  const COMPANIES = ['PT Maju Jaya Sentosa', 'CV Berkah Abadi', 'PT Nusantara Mandiri', 'UD Sumber Rezeki', 'PT Cahaya Teknologi Indonesia', 'CV Karya Utama', 'PT Mitra Sejahtera Abadi', 'PT Global Logistik Prima'];
  const BANKS = ['BCA', 'Mandiri', 'BNI', 'BRI', 'CIMB Niaga', 'Permata'];
  const PRODUCTS = ['Beras Premium 5kg', 'Minyak Goreng 2L', 'Gula Pasir 1kg', 'Kopi Arabika 250g', 'Teh Celup 25s', 'Tepung Terigu 1kg', 'Susu UHT 1L', 'Mie Instan Goreng'];
  const NOTES = [
    'Data uji otomatis untuk memeriksa alur pengisian formulir.',
    'Catatan contoh: mohon diproses sesuai prosedur yang berlaku.',
    'Pengujian skenario normal oleh tim QA, data ini boleh dihapus.',
    'Dokumen dibuat untuk keperluan validasi fitur dan tampilan.',
  ];

  function persona(seed) {
    const r = makeRng(seed || Date.now());
    const first = r.pick(FIRST); const last = r.pick(LAST);
    const place = r.pick(PLACES);
    const street = r.pick(STREETS);
    const slug = (first + '.' + last).toLowerCase();
    const company = r.pick(COMPANIES);
    return {
      firstName: first, lastName: last, fullName: first + ' ' + last,
      email: slug + r.int(10, 99) + '@example.com',
      phone: '08' + r.pick(['11', '12', '13', '21', '52', '57', '78', '81', '82', '85', '96']) + r.digits(7),
      company, city: place[0], province: place[1], postal: place[2],
      street, address: street + ' No. ' + r.int(1, 120) + ', RT 0' + r.int(1, 9) + '/RW 0' + r.int(1, 9),
      npwp: r.digits(15), nik: '3171' + r.digits(2) + r.int(10, 28) + r.int(10, 12) + r.int(80, 99) + r.digits(4),
      birth: (1980 + r.int(0, 20)) + '-' + String(r.int(1, 12)).padStart(2, '0') + '-' + String(r.int(1, 28)).padStart(2, '0'),
      username: slug.replace('.', '_') + r.int(1, 99), bank: r.pick(BANKS), account: r.digits(10),
      website: 'https://www.' + company.toLowerCase().replace(/^(pt|cv|ud)\s+/, '').replace(/[^a-z0-9]+/g, '') + '.co.id',
    };
  }

  // ── Klasifikasi field dari petunjuk teks ────────────────────────────────────
  function hay(field) {
    return [field.autocomplete, field.name, field.id, field.label, field.placeholder, field.ariaLabel]
      .filter(Boolean).join(' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-./\[\]]+/g, ' ').toLowerCase();
  }
  const RULES = [
    ['password', /\b(password|kata sandi|sandi)\b/],
    ['email', /\b(e ?mail|surel)\b/],
    ['phone', /\b(phone|telp|telepon|tel|hp|handphone|mobile|whatsapp|wa|no hp|ponsel)\b/],
    ['npwp', /\bnpwp\b/], ['nik', /\b(nik|ktp|identity number)\b/],
    ['postal', /\b(postal|zip|kode pos|kodepos)\b/],
    ['province', /\b(province|provinsi|state)\b/], ['city', /\b(city|kota|kabupaten|regency)\b/],
    ['address', /\b(address|alamat|street|jalan)\b/],
    ['company', /\b(company|perusahaan|organization|organisasi|instansi|business name|nama usaha)\b/],
    ['bank', /\b(bank name|nama bank|bank)\b/], ['account', /\b(account number|no rekening|nomor rekening|rekening|iban)\b/],
    ['url', /\b(url|website|situs|link|tautan)\b/],
    ['username', /\b(username|user name|nama pengguna|login)\b/],
    ['firstName', /\b(first name|given name|nama depan)\b/], ['lastName', /\b(last name|family name|surname|nama belakang)\b/],
    ['fullName', /\b(full name|nama lengkap|name|nama|contact person|pic|penanggung jawab)\b/],
    ['birth', /\b(birth|lahir|dob)\b/],
    ['percent', /\b(percent|persen|persentase|rate|tarif|discount|diskon|ppn|tax rate|pajak)\b/],
    ['qty', /\b(qty|quantity|jumlah|kuantitas|stok|stock|unit)\b/],
    ['money', /\b(price|harga|amount|nominal|total|biaya|cost|gaji|salary|budget|anggaran|saldo|balance|limit|plafon|tarif)\b/],
    ['code', /\b(code|kode|sku|number|nomor|no|ref|reference|referensi|key)\b/],
    ['notes', /\b(note|notes|catatan|description|deskripsi|keterangan|remark|memo|alasan|reason|comment|komentar|message|pesan)\b/],
    ['product', /\b(product|produk|item|barang)\b/],
  ];
  function classify(field) {
    const h = hay(field);
    const ac = (field.autocomplete || '').toLowerCase();
    const acMap = { 'given-name': 'firstName', 'family-name': 'lastName', name: 'fullName', email: 'email', tel: 'phone', 'postal-code': 'postal',
      'street-address': 'address', 'address-line1': 'address', organization: 'company', username: 'username', 'new-password': 'password',
      'current-password': 'password', bday: 'birth', url: 'url', 'address-level2': 'city', 'address-level1': 'province' };
    if (acMap[ac]) return acMap[ac];
    for (const [key, re] of RULES) if (re.test(h)) return key;
    return null;
  }

  function digitsFromPattern(r, pattern, len) {
    const m = /\\d\{(\d+)(?:,(\d+))?\}/.exec(pattern || '');
    const n = m ? Number(m[2] || m[1]) : len;
    return n ? r.digits(n) : null;
  }

  function clampNumber(field, n, r) {
    let v = n;
    const min = field.min !== undefined && field.min !== '' ? Number(field.min) : null;
    const max = field.max !== undefined && field.max !== '' ? Number(field.max) : null;
    if (min !== null && v < min) v = min;
    if (max !== null && v > max) v = max;
    const step = field.step && field.step !== 'any' ? Number(field.step) : null;
    if (step && step > 0 && Number.isFinite(step)) {
      const base = min !== null ? min : 0;
      v = base + Math.round((v - base) / step) * step;
      if (max !== null && v > max) v = max - ((max - base) % step);
      v = Number(v.toFixed(6));
    }
    return v;
  }

  function isoDate(d) { return d.toISOString().slice(0, 10); }
  function addDays(base, n) { const d = new Date(base.getTime()); d.setUTCDate(d.getUTCDate() + n); return d; }

  /** Nilai untuk satu field menurut klasifikasi; null bila tidak ada tebakan. */
  function generate(field, ctx) {
    const r = ctx.rng; const p = ctx.persona; const kind = field.kind;
    const key = classify(field);
    const today = ctx.today || new Date();
    const max = Number(field.maxLength) > 0 ? Number(field.maxLength) : null;
    const fit = (s) => (max && s.length > max ? s.slice(0, max) : s);

    if ((kind === 'select' || kind === 'radio') && field.options && field.options.length) return r.pick(field.options).value;
    if (kind === 'multiselect' && field.options && field.options.length) return [r.pick(field.options).value];
    if (kind === 'checkbox' || kind === 'switch') return r() < 0.6;
    if (kind === 'color') return '#3b82f6';
    if (kind === 'range') return clampNumber(field, (Number(field.min || 0) + Number(field.max || 100)) / 2, r);
    if (kind === 'date' || kind === 'datetime-local' || kind === 'time' || kind === 'month' || kind === 'week') {
      const h = hay(field);
      let d;
      if (key === 'birth') d = new Date(p.birth + 'T00:00:00Z');
      else if (/(due|jatuh tempo|tempo|berlaku sampai|valid until|expired|expiry|akhir|selesai|sampai|end|deadline|tenggat)/.test(h)) d = addDays(today, r.int(7, 45));
      else if (/(mulai|start|awal|from|dari|berlaku)/.test(h)) d = addDays(today, r.int(0, 3));
      else d = addDays(today, -r.int(0, 3));
      const iso = isoDate(d);
      if (kind === 'datetime-local') return iso + 'T' + String(r.int(8, 16)).padStart(2, '0') + ':00';
      if (kind === 'time') return String(r.int(8, 16)).padStart(2, '0') + ':' + r.pick(['00', '15', '30', '45']);
      if (kind === 'month') return iso.slice(0, 7);
      if (kind === 'week') return iso.slice(0, 4) + '-W' + String(r.int(1, 52)).padStart(2, '0');
      return iso;
    }
    if (kind === 'number' || key === 'qty' || key === 'money' || key === 'percent') {
      if (kind === 'number' || /^\d/.test(field.placeholder || '')) {
        let n;
        if (key === 'percent') n = r.pick([5, 10, 11, 12, 15]);
        else if (key === 'money') n = r.pick([50000, 75000, 150000, 250000, 500000, 1250000, 2500000]);
        else if (key === 'qty') n = r.int(1, 20);
        else n = r.int(1, 100);
        return clampNumber(field, n, r);
      }
    }
    switch (key) {
      case 'email': return fit(p.email);
      case 'phone': { const s = digitsFromPattern(r, field.pattern, 0); return fit(s ? '08' + s.slice(2) : p.phone); }
      case 'npwp': return /\./.test(field.placeholder || '') ? fit(p.npwp.replace(/^(\d{2})(\d{3})(\d{3})(\d)(\d{3})(\d{3})$/, '$1.$2.$3.$4-$5.$6')) : fit(p.npwp);
      case 'nik': return fit(p.nik);
      case 'postal': return fit(p.postal);
      case 'province': return fit(p.province);
      case 'city': return fit(p.city);
      case 'address': return fit(p.address);
      case 'company': return fit(p.company);
      case 'bank': return fit(p.bank);
      case 'account': return fit(p.account);
      case 'url': return fit(p.website);
      case 'username': return fit(p.username);
      case 'firstName': return fit(p.firstName);
      case 'lastName': return fit(p.lastName);
      case 'fullName': return fit(p.fullName);
      case 'password': return fit('Uji@' + r.digits(6));
      case 'birth': return p.birth;
      case 'product': return fit(r.pick(PRODUCTS));
      case 'code': { const s = fit('DEMO-' + r.digits(4)); return field.pattern && !new RegExp('^(?:' + field.pattern + ')$').test(s) ? (digitsFromPattern(r, field.pattern, 6) || s) : s; }
      case 'notes': return fit(r.pick(NOTES));
      default: break;
    }
    if (kind === 'textarea') return fit(r.pick(NOTES));
    if (kind === 'tel') return fit(p.phone);
    if (kind === 'email') return fit(p.email);
    if (kind === 'url') return fit(p.website);
    if (kind === 'text' || kind === 'search' || kind === 'combobox' || kind === 'contenteditable') {
      return fit(r.pick(PRODUCTS));
    }
    return null;
  }

  AIFF.heuristics = { makeRng, persona, classify, generate, clampNumber, hay, PRODUCTS, NOTES };
  if (typeof module !== 'undefined' && module.exports) module.exports = AIFF.heuristics;
})(typeof self !== 'undefined' ? self : globalThis);
