'use strict';
// Vẽ icon ">_" cho app (PNG 512x512) bằng Node thuần, không cần thư viện ảnh.
// Ghi ra build/icon.png (electron-builder tự tạo .ico) và electron/icon.png (icon cửa sổ).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 512;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function roundRectDist(px, py, half, r) {
  const qx = Math.abs(px) - half + r;
  const qy = Math.abs(py) - half + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

const TOP = hex('#18222f');
const BOTTOM = hex('#0a0f15');
const BORDER = hex('#2f3c4d');
const ACCENT = hex('#3b9eff');
const CURSOR = hex('#79c0ff');
const STROKE = 0.085;

const px = Buffer.alloc(S * S * 4);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S;
    const v = (y + 0.5) / S;
    // Nền: hình vuông bo góc, gradient dọc, viền mảnh.
    const d = roundRectDist(u - 0.5, v - 0.5, 0.47, 0.11) * S;
    const shape = clamp(0.5 - d);
    if (shape <= 0) continue;
    let col = TOP.map((c, i) => c + (BOTTOM[i] - c) * v);
    const border = clamp(1 - Math.abs(d + 2) / 1.5);
    col = col.map((c, i) => c + (BORDER[i] - c) * border);
    // Dấu ">" và "_".
    const chev = Math.min(segDist(u, v, 0.25, 0.31, 0.47, 0.5), segDist(u, v, 0.47, 0.5, 0.25, 0.69));
    const a1 = clamp(0.5 - (chev - STROKE / 2) * S);
    col = col.map((c, i) => c + (ACCENT[i] - c) * a1);
    const bar = segDist(u, v, 0.56, 0.69, 0.76, 0.69);
    const a2 = clamp(0.5 - (bar - STROKE / 2) * S);
    col = col.map((c, i) => c + (CURSOR[i] - c) * a2);
    const o = (y * S + x) * 4;
    px[o] = Math.round(col[0]);
    px[o + 1] = Math.round(col[1]);
    px[o + 2] = Math.round(col[2]);
    px[o + 3] = Math.round(shape * 255);
  }
}

const png = encodePng(px, S, S);
const root = path.join(__dirname, '..');
fs.writeFileSync(path.join(root, 'build', 'icon.png'), png);
fs.writeFileSync(path.join(root, 'electron', 'icon.png'), png);
console.log(`Đã tạo icon ${S}x${S} (${png.length} bytes)`);
