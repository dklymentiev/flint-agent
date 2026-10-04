#!/usr/bin/env node
// Builds assets/icon/ from one description of the mark.
//
// The icon grows out of the launcher wordmark (src/launcher.js,
// assets/flint-mark-*.svg): its F with the top bar standing apart, and the
// spark that sits over the i. Here the i is bent into a bracket that closes
// the lower right corner, so the figure fills the square instead of leaving
// it half empty. It is drawn as rectangles on an 8x8 grid, so at 16 px a cell
// is exactly two pixels and nothing is blurred where it matters most.
//
// No dependencies on purpose: a PNG of flat rectangles needs zlib and a CRC,
// both of which Node has, and an image library would be the largest thing in
// the repository for the sake of six files that change about never.
//
//   node scripts/build-icons.mjs

import { deflateSync, crc32 } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "assets", "icon");

const BASALT = "#0D0F12";
const TITANIUM = "#BCBCBC";
const SPARK = "#FFD700";

const GRID = 8;
// x, y, width, height in grid cells.
const RECTS = [
  [1, 1, 6, 1, TITANIUM], // F, top bar, apart from the rest as in the launcher
  [1, 3, 4, 1, TITANIUM], // F, middle bar
  [1, 3, 1, 4, TITANIUM], // F, stem
  [6, 3, 1, 1, SPARK],    // the spark
  [6, 5, 1, 2, TITANIUM], // bracket, upright
  [3, 6, 4, 1, TITANIUM], // bracket, foot
];

const PNG_SIZES = [16, 32, 48, 180, 192, 512];
const ICO_SIZES = [16, 32, 48];
// 180 is not a multiple of the grid, so edges fall between pixels there.
// Each pixel is averaged from this many samples per side.
const SAMPLES = 8;

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function colorAt(gx, gy) {
  for (let i = RECTS.length - 1; i >= 0; i--) {
    const [x, y, w, h, color] = RECTS[i];
    if (gx >= x && gx < x + w && gy >= y && gy < y + h) return color;
  }
  return BASALT;
}

function render(size) {
  const px = Buffer.alloc(size * size * 3);
  const palette = new Map([BASALT, TITANIUM, SPARK].map((c) => [c, rgb(c)]));
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      const sum = [0, 0, 0];
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const gx = ((pxl + (sx + 0.5) / SAMPLES) / size) * GRID;
          const gy = ((py + (sy + 0.5) / SAMPLES) / size) * GRID;
          const c = palette.get(colorAt(gx, gy));
          sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2];
        }
      }
      const n = SAMPLES * SAMPLES;
      const o = (py * size + pxl) * 3;
      px[o] = Math.round(sum[0] / n);
      px[o + 1] = Math.round(sum[1] / n);
      px[o + 2] = Math.round(sum[2] / n);
    }
  }
  return px;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const px = render(size);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour, no alpha: the icon is a full square
  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    // Each row starts with filter byte 0, already there from alloc.
    px.copy(rows, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// An .ico is a directory of images; PNG entries are valid in it.
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = size; e[1] = size;
    e.writeUInt16LE(1, 4);  // colour planes
    e.writeUInt16LE(24, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

function svg() {
  const rects = RECTS.map(([x, y, w, h, c]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}" shape-rendering="crispEdges" role="img" aria-label="Flint Agent">` +
    `<title>Flint Agent</title><rect width="${GRID}" height="${GRID}" fill="${BASALT}"/>${rects}</svg>\n`;
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "icon.svg"), svg());
const built = new Map(PNG_SIZES.map((s) => [s, png(s)]));
for (const [size, data] of built) writeFileSync(join(OUT, `icon-${size}.png`), data);
writeFileSync(join(OUT, "apple-touch-icon.png"), built.get(180));
writeFileSync(join(OUT, "favicon.ico"), ico(ICO_SIZES.map((size) => ({ size, data: built.get(size) }))));
console.log(`assets/icon: icon.svg, favicon.ico, apple-touch-icon.png, ${PNG_SIZES.map((s) => `icon-${s}.png`).join(", ")}`);
