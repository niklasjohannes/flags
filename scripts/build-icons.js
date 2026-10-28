// Builds the app icons in `icons/` from one geometry: a white waving flag on
// a pole, on the app's accent colour. Generic on purpose: a plain cloth, no
// real country's flag. Zero dependencies: shapes are rasterised here with
// supersampled coverage and encoded as PNG with `node:zlib`; the SVG favicon
// is drawn from the same functions.
//
// Usage (from the repo root):
//   node scripts/build-icons.js
//
// Output:
//   icons/icon-192.png, icon-512.png            manifest `any`: rounded tile,
//                                               transparent corners
//   icons/icon-maskable-192.png, -512.png       manifest `maskable`: full
//                                               bleed, mark inside the safe zone
//   icons/apple-touch-icon.png (180)            opaque, full bleed (iOS rounds
//                                               the corners itself)
//   icons/favicon-32.png, icons/favicon.svg     browser tab
//
// After changing any icon, run `node scripts/build-sw.js` so the service
// worker precaches the new files under a new cache version.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ICONS_DIR = join(REPO_ROOT, 'icons');

/** Accent colour (`--color-accent` in css/style.css). */
export const ACCENT_RGB = Object.freeze([0x4f, 0x72, 0x82]);
const MARK_RGB = Object.freeze([0xff, 0xff, 0xff]);

// Samples per pixel along each axis (SUPERSAMPLE² per pixel).
const SUPERSAMPLE = 6;

// ---- Geometry (unit square, y down) ----

// The mark is drawn in its own unit square, then scaled about the centre.
const POLE = Object.freeze({ x0: 0.17, y0: 0.06, x1: 0.25, y1: 0.94, r: 0.04 });
const CLOTH = Object.freeze({ x0: 0.245, x1: 0.85, top: 0.12, height: 0.44, wave: 0.045 });
const CLOTH_CORNER = 0.02;

function insideRoundedRect(x, y, { x0, y0, x1, y1, r }) {
  if (x < x0 || x > x1 || y < y0 || y > y1) {
    return false;
  }
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// Top edge of the cloth at `x`: one full sine period across its width.
function clothTop(x) {
  const t = (x - CLOTH.x0) / (CLOTH.x1 - CLOTH.x0);
  return CLOTH.top - CLOTH.wave * Math.sin(2 * Math.PI * t);
}

function insideCloth(x, y) {
  if (x < CLOTH.x0 || x > CLOTH.x1) {
    return false;
  }
  const top = clothTop(x);
  const bottom = top + CLOTH.height;
  if (y < top || y > bottom) {
    return false;
  }
  // Round the two free (right-hand) corners slightly.
  const dx = CLOTH.x1 - x;
  if (dx < CLOTH_CORNER) {
    const dyTop = y - top;
    const dyBottom = bottom - y;
    const dy = Math.min(dyTop, dyBottom);
    if (dy < CLOTH_CORNER) {
      return (CLOTH_CORNER - dx) ** 2 + (CLOTH_CORNER - dy) ** 2 <= CLOTH_CORNER ** 2;
    }
  }
  return true;
}

function insideMark(x, y) {
  return insideRoundedRect(x, y, POLE) || insideCloth(x, y);
}

/**
 * Icon variants: tile shape and how large the mark is.
 *
 * `tileRadius` is the corner radius of the accent tile as a fraction of the
 * size (`0` = full-bleed square). `markScale` is the mark's size as a
 * fraction of the icon. Maskable icons keep the mark inside the central
 * 80 % safe-zone circle, so any launcher mask leaves it whole.
 */
export const VARIANTS = Object.freeze({
  any: Object.freeze({ tileRadius: 0.2, markScale: 0.62 }),
  maskable: Object.freeze({ tileRadius: 0, markScale: 0.5 }),
  apple: Object.freeze({ tileRadius: 0, markScale: 0.62 }),
  favicon: Object.freeze({ tileRadius: 0.2, markScale: 0.78 })
});

/** Files written by `buildIcons`, with their variant and pixel size. */
export const ICON_FILES = Object.freeze([
  Object.freeze({ file: 'icon-192.png', variant: 'any', size: 192 }),
  Object.freeze({ file: 'icon-512.png', variant: 'any', size: 512 }),
  Object.freeze({ file: 'icon-maskable-192.png', variant: 'maskable', size: 192 }),
  Object.freeze({ file: 'icon-maskable-512.png', variant: 'maskable', size: 512 }),
  Object.freeze({ file: 'apple-touch-icon.png', variant: 'apple', size: 180 }),
  Object.freeze({ file: 'favicon-32.png', variant: 'favicon', size: 32 })
]);

function getVariant(name) {
  if (!Object.hasOwn(VARIANTS, name)) {
    throw new RangeError(`\`variant\` must be one of ${Object.keys(VARIANTS).join(', ')}.`);
  }
  return VARIANTS[name];
}

// ---- Raster ----

/**
 * Rasterise one icon variant.
 *
 * @param {string} variant A key of `VARIANTS`.
 * @param {number} size Width and height in pixels.
 * @returns {Uint8Array} RGBA pixels, row-major, `size * size * 4` bytes.
 */
export function renderIcon(variant, size) {
  const { tileRadius, markScale } = getVariant(variant);
  if (!Number.isInteger(size) || size < 1 || size > 4_096) {
    throw new RangeError('`size` must be an integer between 1 and 4096.');
  }
  const tile = { x0: 0, y0: 0, x1: 1, y1: 1, r: tileRadius };
  const pixels = new Uint8Array(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let tileHits = 0;
      let markHits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) / size;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / size;
          if (!insideRoundedRect(x, y, tile)) {
            continue;
          }
          tileHits += 1;
          const mx = (x - 0.5) / markScale + 0.5;
          const my = (y - 0.5) / markScale + 0.5;
          if (insideMark(mx, my)) {
            markHits += 1;
          }
        }
      }
      // The mark only ever sits on the tile, so blending white over accent by
      // the mark's share of the tile's coverage is exact.
      const offset = (py * size + px) * 4;
      const markShare = tileHits === 0 ? 0 : markHits / tileHits;
      for (let c = 0; c < 3; c += 1) {
        pixels[offset + c] = Math.round(ACCENT_RGB[c] + (MARK_RGB[c] - ACCENT_RGB[c]) * markShare);
      }
      pixels[offset + 3] = Math.round((255 * tileHits) / samples);
    }
  }
  return pixels;
}

// ---- PNG ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

/**
 * Encode RGBA pixels as a PNG (8-bit RGBA, no filtering, zlib-compressed).
 *
 * @param {Uint8Array} pixels RGBA pixels, row-major.
 * @param {number} width Width in pixels.
 * @param {number} height Height in pixels.
 * @returns {Buffer} The PNG file.
 */
export function encodePng(pixels, width, height) {
  if (!(pixels instanceof Uint8Array)) {
    throw new TypeError('`pixels` must be a `Uint8Array`.');
  }
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new RangeError('`width` and `height` must be positive integers.');
  }
  if (pixels.length !== width * height * 4) {
    throw new RangeError('`pixels` must hold exactly `width * height * 4` bytes.');
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // Bytes 10-12: compression, filter and interlace methods, all 0.

  // Each scanline is prefixed with its filter type (0 = none).
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (rowBytes + 1)] = 0;
    raw.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ---- SVG ----

// Coordinates on a 0-100 grid, rounded to 0.01.
function formatNumber(value) {
  return String(Math.round(value * 10_000) / 100);
}

/**
 * Draw a variant as SVG, from the same geometry as `renderIcon`.
 *
 * @param {string} variant A key of `VARIANTS`.
 * @returns {string} A standalone SVG document (viewBox `0 0 100 100`).
 */
export function renderSvg(variant) {
  const { tileRadius, markScale } = getVariant(variant);
  const toIcon = (value) => formatNumber((value - 0.5) * markScale + 0.5);
  const steps = 32;
  const top = [];
  const bottom = [];
  for (let i = 0; i <= steps; i += 1) {
    const x = CLOTH.x0 + ((CLOTH.x1 - CLOTH.x0) * i) / steps;
    top.push(`${toIcon(x)} ${toIcon(clothTop(x))}`);
    bottom.push(`${toIcon(x)} ${toIcon(clothTop(x) + CLOTH.height)}`);
  }
  const cloth = `M${top.join('L')}L${bottom.reverse().join('L')}Z`;
  const poleWidth = (POLE.x1 - POLE.x0) * markScale;
  const poleHeight = (POLE.y1 - POLE.y0) * markScale;
  const hex = (rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
    `<rect width="100" height="100" rx="${formatNumber(tileRadius)}" fill="${hex(ACCENT_RGB)}"/>`,
    `<g fill="${hex(MARK_RGB)}">`,
    `<rect x="${toIcon(POLE.x0)}" y="${toIcon(POLE.y0)}" width="${formatNumber(poleWidth)}" height="${formatNumber(poleHeight)}" rx="${formatNumber(POLE.r * markScale)}"/>`,
    `<path d="${cloth}"/>`,
    '</g>',
    '</svg>',
    ''
  ].join('\n');
}

// ---- Entry point ----

/**
 * Write every icon into `icons/`.
 *
 * @returns {string[]} Paths written, relative to the repo root.
 */
export function buildIcons() {
  mkdirSync(ICONS_DIR, { recursive: true });
  const written = [];
  for (const { file, variant, size } of ICON_FILES) {
    writeFileSync(join(ICONS_DIR, file), encodePng(renderIcon(variant, size), size, size));
    written.push(`icons/${file}`);
  }
  writeFileSync(join(ICONS_DIR, 'favicon.svg'), renderSvg('favicon'));
  written.push('icons/favicon.svg');
  return written;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const path of buildIcons()) {
    console.log(`Wrote ${path}`);
  }
}
