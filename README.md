# AI Form Fill Lokal

Ekstensi browser (Chrome / Edge, Manifest V3) untuk **mengisi formulir web otomatis dengan data uji yang masuk akal**, dibuat oleh
**model AI di komputer sendiri** (Ollama, LM Studio, dll). Tidak ada cloud, tidak ada telemetri: data hanya dikirim ke `localhost`.

Berbeda dari pengisi form biasa yang mengacak nilai dari nama input, ekstensi ini membaca **label, placeholder, batas (maxlength/min/max/step/pattern),
daftar pilihan, judul seksi, dan konteks halaman**, lalu meminta model membuat isian yang koheren (nama, email, telepon, kota, perusahaan saling cocok).

## Pasang (mode pengembang)

1. Buka `chrome://extensions` (atau `edge://extensions`), aktifkan **Developer mode**.
2. **Load unpacked** lalu pilih folder ini.
3. Nyalakan server LLM lokal, mis. Ollama (`ollama serve`) dengan minimal satu model chat (disarankan `qwen2.5:7b-instruct` atau sejenis).
4. Klik ikon ekstensi, atau tekan **Alt+Shift+F** di halaman yang berisi form.

Pintasan bisa diubah di `chrome://extensions/shortcuts`.

## Cara pakai

| Aksi | Cara |
| --- | --- |
| Isi seluruh form halaman (atau isi **dialog/modal** yang sedang terbuka) | Alt+Shift+F, atau tombol **Isi form** di popup, atau klik kanan halaman |
| Isi satu field | Klik kanan field -> **Isi field ini dengan AI** |
| Urungkan | Alt+Shift+Z, atau tombol **Urungkan** di kartu hasil |
| Perbaiki error validasi | Setelah kirim form dan muncul pesan galat -> **Perbaiki error validasi** (pesan galat dikirim ke model untuk dikoreksi) |

Kartu hasil di pojok kanan bawah menampilkan setiap field, nilainya, dan sumbernya (**AI** atau **lokal**). Field yang diisi diberi bingkai warna
(ungu = AI, biru = generator lokal).

## Deteksi model otomatis

Saat popup dibuka, ekstensi memeriksa paralel: Ollama (`11434`), LM Studio (`1234`), llama.cpp/LocalAI/vLLM (`8080`), Jan (`1337`), GPT4All (`4891`).
Semua model terdeteksi tampil di dropdown; model **embedding diabaikan**, dan satu model diberi tanda ★ sebagai rekomendasi (instruct, ukuran menengah, bukan model "thinking").
Server lain bisa ditambah di **Opsi**. Model dimuat ke memori sejak popup dibuka supaya isian pertama tidak menunggu.

## Mode isian

- **Realistis** (bawaan): data valid, masuk akal, saling konsisten.
- **Hanya field wajib**: field opsional dibiarkan kosong.
- **Batas (boundary)**: teks sepanjang batas, angka di min/max, karakter khusus yang sah.
- **Negatif**: sengaja tidak valid (email salah, angka di luar batas, wajib dikosongkan) untuk menguji pesan validasi.

**Strategi**: *Cerdas* (semua field oleh AI, paling koheren) atau *Cepat* (AI hanya untuk pilihan, teks bebas, dan field yang tidak dikenali; sisanya generator lokal).

## Fitur tambahan

- **Persona konsisten**: satu identitas (nama, email, telepon, kota, perusahaan, NIK/NPWP) dipakai ulang 30 menit, jadi alur beberapa halaman tetap nyambung.
- **Catatan per situs**: tulis aturan bisnis di popup (mis. "NPWP 15 digit tanpa titik, telepon maks 13 digit"); dikirim ke model setiap kali di situs itu.
- **Jaring pengaman**: jawaban model selalu divalidasi ulang (pilihan harus ada di opsi, `maxlength`, `min/max/step`, `pattern`, format email/tanggal). Yang melanggar diganti generator lokal. Bila server LLM mati, form tetap terisi dari generator lokal.
- **Komponen kustom**: combobox/listbox ARIA, switch/checkbox ARIA, radio group, `contenteditable`, shadow DOM, iframe, dan dialog.
- **Aman**: field `hidden`, `file`, `captcha`, disabled, dan readonly dilewati; form **tidak pernah dikirim** otomatis. Opsi daftar situs yang diizinkan.
- **Seed**: isi angka di Opsi supaya data generator lokal bisa diulang persis.
- Tema terang/gelap mengikuti sistem.

## Catatan teknis

- Ollama menolak permintaan dengan `Origin: chrome-extension://…`. Ekstensi memasang aturan `declarativeNetRequest` **sesi** yang membuang header `Origin`
  **hanya untuk permintaan milik service worker** (`tabIds: [-1]`) ke `localhost`/`127.0.0.1`, sehingga situs web lain tidak terpengaruh.
- Keluaran model dipaksa berbentuk JSON Schema (Ollama `format`, OpenAI `response_format`) dengan `enum` untuk pilihan; `think:false` untuk model yang punya mode berpikir.
- Struktur: `lib/` (heuristik, prompt, provider, pengaturan), `content/engine.js` (pemindai + pengisi), `content/panel.js` (kartu hasil),
  `background.js` (orkestrasi), `popup/`, `options/`.

## Uji

```
npm install        # sekali, untuk jsdom
npm test           # 20 tes: mesin halaman, jalur data, orkestrasi (chrome API palsu)
npm run test:live  # tambah tes end-to-end ke Ollama lokal sungguhan
```

## Batasan yang perlu diketahui

- Belum diuji langsung di browser sungguhan (tes memakai jsdom dan API chrome palsu); komponen UI pihak ketiga seperti Nuxt UI `USelectMenu`
  ditangani lewat pola ARIA umum dan perlu dicoba di aplikasi nyata.
- Tidak mengisi unggah file dan CAPTCHA.
- Kecepatan bergantung model dan perangkat keras: model 7B sekitar 10-15 dtk per form (pertama kali 30 dtk saat model dimuat). Pakai strategi **Cepat** untuk form besar.
