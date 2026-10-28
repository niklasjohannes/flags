// Install metadata and page security (spec #8): the web app manifest, the
// icons it and index.html point at, the iOS meta tags and the CSP. The
// committed PNGs must also be what scripts/build-icons.js draws, so an icon
// edited by hand (or a generator change not re-run) fails here.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import { ICON_FILES, renderIcon, renderSvg } from '../scripts/build-icons.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(readFileSync(join(REPO_ROOT, 'manifest.webmanifest'), 'utf8'));
const HTML = readFileSync(join(REPO_ROOT, 'index.html'), 'utf8');
const HEAD = HTML.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? '';

// ---- Helpers ----

// Minimal PNG reader for the files build-icons.js writes: 8-bit RGBA, one or
// more IDAT chunks, filter type 0 on every row.
function readPng(path) {
  const bytes = readFileSync(path);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${path} is not a PNG.`);
  let offset = 8;
  let header = null;
  const data = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colorType: body[9] };
    } else if (type === 'IDAT') {
      data.push(body);
    }
    offset += 12 + length;
  }
  assert.ok(header !== null, `${path} has no IHDR.`);
  return { ...header, raw: inflateSync(Buffer.concat(data)) };
}

function unfilter({ width, height, raw }) {
  const rowBytes = width * 4;
  const pixels = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * (rowBytes + 1)], 0, 'Unexpected PNG row filter.');
    pixels.set(raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1)), y * rowBytes);
  }
  return pixels;
}

function headElements() {
  return [...HEAD.matchAll(/<(meta|link|title|script)\b([^>]*)>/g)].map(([, tag, attrs]) => ({
    tag,
    attrs: Object.fromEntries([...attrs.matchAll(/([a-z-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]))
  }));
}

function findHead(tag, predicate) {
  return headElements().find((element) => element.tag === tag && predicate(element.attrs));
}

// ---- Tests ----

describe('manifest.webmanifest', () => {
  it('is installable as a standalone app scoped to its own directory', () => {
    assert.equal(MANIFEST.name, 'Flags');
    assert.equal(MANIFEST.short_name, 'Flags');
    assert.equal(MANIFEST.display, 'standalone');
    // Relative, so they resolve to /flags/ on Pages and / locally.
    assert.equal(MANIFEST.start_url, './');
    assert.equal(MANIFEST.scope, './');
    // `id` is the app's identity, never fetched, and resolves against the
    // start_url's *origin* (not the manifest's URL), so `./` would mean the
    // origin root. `/flags/` equals start_url on Pages.
    assert.equal(MANIFEST.id, '/flags/');
    assert.equal(MANIFEST.theme_color, '#ffffff');
    assert.equal(MANIFEST.background_color, '#ffffff');
  });

  it('has 192 and 512 icons, `any` and `maskable`, that exist at their stated size', () => {
    const icons = MANIFEST.icons;
    assert.ok(Array.isArray(icons));
    for (const purpose of ['any', 'maskable']) {
      for (const size of ['192x192', '512x512']) {
        assert.ok(
          icons.some((icon) => icon.purpose === purpose && icon.sizes === size),
          `No ${purpose} icon of ${size}.`
        );
      }
    }
    for (const icon of icons) {
      assert.ok(!/^([a-z]+:|\/)/i.test(icon.src), `\`${icon.src}\` must be a relative path.`);
      assert.equal(icon.type, 'image/png');
      const { width, height } = readPng(join(REPO_ROOT, icon.src));
      assert.equal(`${width}x${height}`, icon.sizes, `${icon.src} is not ${icon.sizes}.`);
    }
  });
});

describe('icons', () => {
  it('are exactly what scripts/build-icons.js draws (run it if not)', () => {
    for (const { file, variant, size } of ICON_FILES) {
      const png = readPng(join(REPO_ROOT, 'icons', file));
      assert.equal(png.width, size);
      assert.equal(png.height, size);
      assert.equal(png.depth, 8);
      assert.equal(png.colorType, 6);
      assert.ok(Buffer.from(unfilter(png)).equals(Buffer.from(renderIcon(variant, size))), `icons/${file} is stale.`);
    }
  });

  it('has the favicon.svg the generator draws', () => {
    assert.equal(readFileSync(join(REPO_ROOT, 'icons', 'favicon.svg'), 'utf8'), renderSvg('favicon'));
  });

  it('has nothing in icons/ that the generator does not write', () => {
    const expected = new Set([...ICON_FILES.map(({ file }) => file), 'favicon.svg']);
    const extra = readdirSync(join(REPO_ROOT, 'icons')).filter((file) => !file.startsWith('.') && !expected.has(file));
    assert.deepEqual(extra, []);
  });

  it('gives iOS an opaque touch icon (transparency turns black there)', () => {
    const png = readPng(join(REPO_ROOT, 'icons', 'apple-touch-icon.png'));
    const pixels = unfilter(png);
    for (let i = 3; i < pixels.length; i += 4) {
      assert.equal(pixels[i], 255);
    }
  });
});

describe('index.html head', () => {
  it('starts with the CSP, `default-src \'self\'` and nothing looser', () => {
    const first = HEAD.trimStart();
    assert.ok(
      first.startsWith('<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">'),
      'The CSP meta tag must be the first child of <head>.'
    );
    assert.equal((HTML.match(/Content-Security-Policy/g) ?? []).length, 1);
  });

  it('links the manifest, favicons and touch icon, and they exist', () => {
    const links = headElements().filter((element) => element.tag === 'link');
    for (const rel of ['manifest', 'icon', 'apple-touch-icon']) {
      assert.ok(links.some((link) => link.attrs.rel === rel), `No <link rel="${rel}">.`);
    }
    for (const { attrs } of links) {
      assert.ok(attrs.href.startsWith('./'), `\`${attrs.href}\` must be relative (Pages serves from /flags/).`);
      assert.ok(existsSync(join(REPO_ROOT, attrs.href)), `\`${attrs.href}\` does not exist.`);
    }
    const touch = findHead('link', (attrs) => attrs.rel === 'apple-touch-icon');
    const { width, height } = readPng(join(REPO_ROOT, touch.attrs.href));
    assert.equal(`${width}x${height}`, '180x180');
  });

  it('preloads exactly the font files css/style.css loads (GitHub #24)', () => {
    const css = readFileSync(join(REPO_ROOT, 'css', 'style.css'), 'utf8');
    const fontUrls = [...css.matchAll(/url\("\.\.\/(fonts\/[^"]+)"\)/g)].map(([, path]) => `./${path}`);
    const preloads = headElements().filter(({ tag, attrs }) => tag === 'link' && attrs.rel === 'preload');
    assert.deepEqual(preloads.map(({ attrs }) => attrs.href), fontUrls);
    for (const { attrs } of preloads) {
      assert.equal(attrs.as, 'font');
      assert.equal(attrs.type, 'font/woff2');
    }
    // Fonts are fetched in CORS mode, so a preload without `crossorigin` is
    // never used and the font downloads twice.
    for (const [tag] of HEAD.matchAll(/<link\b[^>]*\brel="preload"[^>]*>/g)) {
      assert.match(tag, /\scrossorigin[\s>]/, `\`${tag}\` needs \`crossorigin\`.`);
    }
  });

  it('has the iOS and theme meta tags', () => {
    const meta = (name) => findHead('meta', (attrs) => attrs.name === name)?.attrs.content;
    assert.equal(meta('apple-mobile-web-app-capable'), 'yes');
    assert.equal(meta('mobile-web-app-capable'), 'yes');
    // Dark text on the white theme.
    assert.equal(meta('apple-mobile-web-app-status-bar-style'), 'default');
    assert.equal(meta('apple-mobile-web-app-title'), MANIFEST.short_name);
    assert.equal(meta('theme-color'), MANIFEST.theme_color);
  });
});

describe('CSP readiness', () => {
  const webFiles = [
    'index.html',
    ...['css', 'js'].flatMap(function walk(dir) {
      return readdirSync(join(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
        const path = `${dir}/${entry.name}`;
        return entry.isDirectory() ? walk(path) : [path];
      });
    })
  ];

  it('has no inline script, style or event handlers in index.html', () => {
    for (const [, attrs] of HTML.matchAll(/<script\b([^>]*)>/g)) {
      assert.match(attrs, /\ssrc="/, 'Inline <script> blocks are blocked by the CSP.');
    }
    assert.doesNotMatch(HTML, /<style\b/);
    assert.doesNotMatch(HTML, /\sstyle="/);
    assert.doesNotMatch(HTML, /\son[a-z]+="/);
  });

  it('references no other origin from HTML, CSS or JS', () => {
    for (const path of webFiles) {
      const source = readFileSync(join(REPO_ROOT, path), 'utf8');
      assert.doesNotMatch(source, /\b(?:https?:|wss?:)?\/\/[a-z0-9-]+\.[a-z]/i, `${path} references another origin.`);
      assert.doesNotMatch(source, /@import/, `${path} uses @import.`);
    }
  });
});
