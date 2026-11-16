// The plugin's icon (MCP launch plan L3, Decision 18's README/LICENSE/author/icon):
// a square PNG drawn here, byte for byte the same on every build, so no binary
// sits in the repository. Claude Code's plugin directory wants a square PNG of
// 512–2048 px under 2 MB; this is 512 px: a dark tile, three note lines and a teal
// recall dot. Replace it with a designed icon before the first directory submission
// (the directory keeps the first icon it sees).

import zlib from "node:zlib";

export const ICON_SIZE = 512;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

// Inside a rounded rectangle (x0, y0, x1, y1, radius)?
const inRound = (x, y, [x0, y0, x1, y1, r]) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

/** The icon as PNG bytes (RGBA, 4×4 supersampled edges). */
export function iconPng(size = ICON_SIZE) {
  const s = size / 512;
  const tile = [16, 16, 496, 496, 96].map((v) => v * s);
  const bars = [
    [112, 168, 336, 208, 20],
    [112, 240, 400, 280, 20],
    [112, 312, 288, 352, 20],
  ].map((b) => b.map((v) => v * s));
  const dot = { x: 384 * s, y: 188 * s, r: 40 * s };
  const BG = [17, 24, 39];
  const INK = [243, 244, 246];
  const ACCENT = [20, 184, 166];
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const SS = 4;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (!inRound(px, py, tile)) continue;
          const c = (px - dot.x) ** 2 + (py - dot.y) ** 2 <= dot.r ** 2 ? ACCENT : bars.some((bar) => inRound(px, py, bar)) ? INK : BG;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const o = row + 1 + x * 4;
      // Colour averaged over covered samples; alpha = coverage (edges blend into any page).
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
