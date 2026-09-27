/**
 * Renders the app icons as PNGs with zero dependencies: a tiny SDF
 * rasterizer (supersampled) plus a minimal PNG encoder on node:zlib.
 * The artwork mirrors the favicon — a cream pad with an ink frame, a big
 * golden touch point and two guest touches (green and ink).
 *
 * Run: node scripts/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');

const CREAM = [246, 230, 200]; // --bg
const INK = [28, 20, 12]; // --ink
const GOLD = [242, 193, 75]; // --sun / --accent
const GREEN = [47, 143, 85]; // --plant

/* ---------- PNG encoder ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- Artwork ---------- */

// Signed distance to a rounded rect centered at (cx, cy) with half-size
// (hw, hh) and corner radius r. Negative inside.
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function circle(u, v, cx, cy, fillR, ringR, fill) {
  const d = Math.hypot(u - cx, v - cy);
  if (d <= fillR) return fill;
  if (d <= ringR) return INK;
  return null;
}

// Design space is 32 units; maskable shrinks the artwork into the safe zone.
function design(u, v, maskable) {
  if (maskable) {
    u = 16 + (u - 16) / 0.78;
    v = 16 + (v - 16) / 0.78;
  }
  let color = CREAM;
  if (!maskable && sdRoundRect(u, v, 16, 16, 16, 16, 7.5) > -3 && sdRoundRect(u, v, 16, 16, 16, 16, 7.5) <= 0) {
    color = INK;
  }
  return (
    circle(u, v, 15, 16, 6, 7.6, GOLD) ??
    circle(u, v, 24, 9, 2.7, 3.9, GREEN) ??
    circle(u, v, 23.5, 23.5, 2.4, 2.4, INK) ??
    color
  );
}

function render(size, maskable) {
  const SS = 4;
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const u = ((x + (sx + 0.5) / SS) / size) * 32;
          const v = ((y + (sy + 0.5) / SS) / size) * 32;
          const [cr, cg, cb] = design(u, v, maskable);
          r += cr;
          g += cg;
          b += cb;
        }
      }
      const i = (y * size + x) * 4;
      const n = SS * SS;
      rgba[i] = Math.round(r / n);
      rgba[i + 1] = Math.round(g / n);
      rgba[i + 2] = Math.round(b / n);
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, false],
]) {
  writeFileSync(join(OUT_DIR, name), encodePng(size, render(size, maskable)));
  console.log(`wrote icons/${name}`);
}
