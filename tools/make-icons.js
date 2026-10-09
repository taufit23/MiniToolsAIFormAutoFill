// Membuat ikon PNG (16/48/128) tanpa dependensi: persegi ungu membulat dengan bintang putih. Jalankan: node tools/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c; let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const r = size * 0.22; // radius sudut
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4;
      // persegi membulat
      const cx = Math.min(Math.max(x + 0.5, r), size - r); const cy = Math.min(Math.max(y + 0.5, r), size - r);
      const inside = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r + 0.5;
      if (!inside) { raw[o + 3] = 0; continue; }
      const t = (x + y) / (2 * size);
      let R = Math.round(124 + (59 - 124) * t); let G = Math.round(58 + (130 - 58) * t); let B = Math.round(237 + (246 - 237) * t); // ungu -> biru
      // bintang 4 sudut: |dx|^0.6 + |dy|^0.6 <= k
      const dx = Math.abs((x + 0.5) / size - 0.5) * 2; const dy = Math.abs((y + 0.5) / size - 0.5) * 2;
      if (Math.pow(dx, 0.55) + Math.pow(dy, 0.55) <= 0.95) { R = 255; G = 255; B = 255; }
      raw[o] = R; raw[o + 1] = G; raw[o + 2] = B; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const dir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const s of [16, 48, 128]) fs.writeFileSync(path.join(dir, s + '.png'), png(s));
console.log('Ikon dibuat di', dir);
