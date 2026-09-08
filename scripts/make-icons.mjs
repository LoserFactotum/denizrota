// Uygulama ikonlarini uretir: node scripts/make-icons.mjs
// Bagimlilik yok — PNG kodlayici Node'un zlib'i ile yazildi. Sekil 4x
// supersampling ile cizilir, sonra kucultulur; kenarlar yumusak cikar.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

const BACKGROUND = [6, 40, 58];
const SAIL = [76, 199, 216];
const HULL = [235, 245, 248];
const WAVE = [10, 125, 140];

function crc32(bytes) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;   // bit depth
  header[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const insideTriangle = (x, y, a, b, c) => {
  const sign = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const d1 = sign([x, y], a, b), d2 = sign([x, y], b, c), d3 = sign([x, y], c, a);
  const negative = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const positive = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(negative && positive);
};

/** u,v are 0..1 in icon space. Returns [r,g,b] or null for transparent. */
function paint(u, v, rounded) {
  if (rounded) {
    // Yuvarlatilmis kare maske (superellipse benzeri)
    const dx = Math.abs(u - 0.5) * 2, dy = Math.abs(v - 0.5) * 2;
    if (Math.pow(dx, 5) + Math.pow(dy, 5) > 1) return null;
  }
  // Dalgalar
  const wave1 = 0.74 + 0.035 * Math.sin(u * Math.PI * 3.1);
  const wave2 = 0.84 + 0.030 * Math.sin(u * Math.PI * 3.1 + 1.9);
  if (v > wave1 && v < wave1 + 0.045) return WAVE;
  if (v > wave2 && v < wave2 + 0.040) return WAVE;

  // Tekne govdesi: v 0.62..0.72 arasinda daralan bir yamuk
  if (v >= 0.615 && v <= 0.715) {
    const t = (v - 0.615) / 0.1;
    const half = 0.30 - 0.13 * t * t;
    if (Math.abs(u - 0.5) < half) return HULL;
  }
  // Yelken: ust ucgen
  if (insideTriangle(u, v, [0.50, 0.19], [0.735, 0.585], [0.50, 0.585])) return SAIL;
  if (insideTriangle(u, v, [0.465, 0.235], [0.465, 0.585], [0.285, 0.585])) return HULL;
  // Direk
  if (Math.abs(u - 0.487) < 0.014 && v > 0.18 && v < 0.615) return HULL;
  return BACKGROUND;
}

function render(size, { rounded = true, scale = 4 } = {}) {
  const big = size * scale;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const u = (x * scale + sx + 0.5) / big;
          const v = (y * scale + sy + 0.5) / big;
          const colour = paint(u, v, rounded);
          if (colour) { r += colour[0]; g += colour[1]; b += colour[2]; a += 255; }
        }
      }
      const samples = scale * scale;
      const offset = (y * size + x) * 4;
      if (a > 0) {
        rgba[offset] = Math.round(r / (a / 255));
        rgba[offset + 1] = Math.round(g / (a / 255));
        rgba[offset + 2] = Math.round(b / (a / 255));
      }
      rgba[offset + 3] = Math.round(a / samples);
    }
  }
  return encodePNG(size, size, rgba);
}

for (const [name, size, options] of [
  ['icon-180.png', 180, { rounded: false }],   // apple-touch-icon: kare olmali
  ['icon-192.png', 192, { rounded: true }],
  ['icon-512.png', 512, { rounded: true }],
  ['icon-maskable-512.png', 512, { rounded: false }],
]) {
  const file = join(OUT, name);
  writeFileSync(file, render(size, options));
  console.log('yazildi', name);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#06283a"/>
  <path d="M50 19 L73.5 58.5 H50 Z" fill="#4cc7d8"/>
  <path d="M46.5 23.5 V58.5 H28.5 Z" fill="#ebf5f8"/>
  <rect x="47.3" y="18" width="2.8" height="40.5" fill="#ebf5f8"/>
  <path d="M20 61.5 H80 L71 71.5 H29 Z" fill="#ebf5f8"/>
  <path d="M8 78 q10 -5 20 0 t20 0 t20 0 t20 0 v5 q-10 5 -20 0 t-20 0 t-20 0 t-20 0 Z" fill="#0a7d8c"/>
</svg>
`;
writeFileSync(join(OUT, 'icon.svg'), svg);
console.log('yazildi icon.svg');
