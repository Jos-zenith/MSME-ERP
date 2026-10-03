// Generates the PNG app icons with no dependencies (a rounded blue square with a 2x2 grid glyph).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/icons');
fs.mkdirSync(out, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// signed distance to a rounded rectangle -> soft edge (anti-aliased)
const rr = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return Math.hypot(x - cx, y - cy) - r;
};
const cover = (d) => Math.max(0, Math.min(1, 0.5 - d));

function icon(size, { maskable = false } = {}) {
  const BLUE = [42, 120, 214], WHITE = [255, 255, 255];
  const corner = maskable ? 0 : size * 0.22;
  const g = maskable ? size * 0.5 : size * 0.6;            // glyph box (kept inside the maskable safe zone)
  const gx = (size - g) / 2, cell = g * 0.44, gap = g - cell * 2, cr = cell * 0.22;
  return png(size, (x, y) => {
    const bg = cover(rr(x + 0.5, y + 0.5, 0, 0, size, size, corner));
    let w = 0;
    for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const x0 = gx + ox * (cell + gap), y0 = gx + oy * (cell + gap);
      w = Math.max(w, cover(rr(x + 0.5, y + 0.5, x0, y0, x0 + cell, y0 + cell, cr)));
    }
    return [0, 1, 2].map((i) => Math.round(BLUE[i] * (1 - w) + WHITE[i] * w)).concat(Math.round(255 * bg));
  });
}

fs.writeFileSync(path.join(out, 'icon-192.png'), icon(192));
fs.writeFileSync(path.join(out, 'icon-512.png'), icon(512));
fs.writeFileSync(path.join(out, 'icon-maskable-512.png'), icon(512, { maskable: true }));
fs.writeFileSync(path.join(out, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#2a78d6"/><g fill="#fff"><rect x="103" y="103" width="146" height="146" rx="32"/><rect x="263" y="103" width="146" height="146" rx="32"/><rect x="103" y="263" width="146" height="146" rx="32"/><rect x="263" y="263" width="146" height="146" rx="32"/></g></svg>\n`);
console.log('icons written to', out);
