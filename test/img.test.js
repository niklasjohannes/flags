// The hand-drawn UI images in img/ (GitHub #24: the pixel check and cross
// marks). They are served same-origin and used as CSS masks, so they are
// held to an allowlist far tighter than the flags' one (scripts/svg-safety.js,
// which is pinned to what flag-icons uses): one `<svg>` holding only
// `<path>`s, with only `xmlns`, `viewBox`, `shape-rendering` and `d`, and
// plain values for each. Anything else (another element or attribute, an
// entity or character reference, a comment, text) fails.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMG_DIR = join(REPO_ROOT, 'img');
const SVG_NS = 'http://www.w3.org/2000/svg';

// Attribute name -> pattern its whole value must match, per element.
const ALLOWED = Object.freeze({
  svg: Object.freeze({
    xmlns: new RegExp(`^${SVG_NS.replace(/[./]/g, '\\$&')}$`),
    viewBox: /^-?\d+(?:\.\d+)?(?: -?\d+(?:\.\d+)?){3}$/,
    'shape-rendering': /^(?:auto|crispEdges|geometricPrecision|optimizeSpeed)$/
  }),
  path: Object.freeze({
    d: /^[MmLlHhVvZz0-9 .,-]+$/
  })
});

// ---- Helpers ----

/**
 * List what keeps an SVG source off the img/ allowlist.
 *
 * @param {string} source SVG file contents.
 * @returns {string[]} Issues, empty when the file passes.
 */
function findImgSvgIssues(source) {
  const issues = [];
  const tags = [];
  // Tags and the text between them; every character must belong to one.
  const rest = source.trim().replace(/<(\/?)([^\s/>]+)((?:\s+[^\s=/>]+="[^"<>]*")*)\s*(\/?)>/g, (tag, close, name, attrs, selfClose) => {
    tags.push({ close: close === '/', name, attrs, selfClose: selfClose === '/' });
    return '';
  });
  if (rest.trim() !== '') {
    issues.push(`unexpected content outside allowed tags: ${JSON.stringify(rest.trim().slice(0, 40))}`);
  }
  if (/[&]/.test(source)) {
    issues.push('entity or character reference');
  }

  const first = tags[0];
  const last = tags.at(-1);
  if (first === undefined || first.name !== 'svg' || first.close || first.selfClose) {
    issues.push('must start with an opening `<svg>`');
  }
  if (last === undefined || last.name !== 'svg' || !last.close || tags.length < 2) {
    issues.push('must end with `</svg>`');
  }
  tags.slice(1, -1).forEach((tag) => {
    if (tag.name !== 'path' || tag.close || !tag.selfClose) {
      issues.push(`only self-closing \`<path/>\` may sit inside \`<svg>\`, not \`${tag.close ? '/' : ''}${tag.name}\``);
    }
  });

  for (const tag of tags.filter(({ close }) => !close)) {
    const allowed = ALLOWED[tag.name];
    if (allowed === undefined) {
      issues.push(`\`<${tag.name}>\`: element not in allowlist`);
      continue;
    }
    for (const [, name, value] of tag.attrs.matchAll(/\s+([^\s=]+)="([^"]*)"/g)) {
      if (!Object.hasOwn(allowed, name)) {
        issues.push(`\`<${tag.name} ${name}>\`: attribute not in allowlist`);
      } else if (!allowed[name].test(value)) {
        issues.push(`\`<${tag.name} ${name}>\`: value ${JSON.stringify(value)} not allowed`);
      }
    }
  }
  if (first?.name === 'svg' && !/\sxmlns="/.test(first.attrs)) {
    issues.push('`<svg>` needs `xmlns`');
  }
  return issues;
}

const imgFiles = readdirSync(IMG_DIR).filter((file) => !file.startsWith('.'));

// ---- Tests ----

describe('img/', () => {
  it('holds only SVGs', () => {
    assert.ok(imgFiles.length > 0, 'img/ is empty.');
    for (const file of imgFiles) {
      assert.match(file, /^[a-z0-9-]+\.svg$/, `img/${file} is not a plain-named .svg.`);
    }
  });

  for (const file of imgFiles) {
    it(`${file} passes the img/ SVG allowlist`, () => {
      assert.deepEqual(findImgSvgIssues(readFileSync(join(IMG_DIR, file), 'utf8')), []);
    });
  }
});

describe('img/ SVG allowlist', () => {
  const ok = `<svg xmlns="${SVG_NS}" viewBox="0 0 7 7" shape-rendering="crispEdges"><path d="M0 0h1v1h-1z"/></svg>`;

  it('accepts a minimal mark', () => {
    assert.deepEqual(findImgSvgIssues(ok), []);
  });

  const REJECTED = {
    'script element': ok.replace('<path', '<script>alert(1)</script><path'),
    'other element': ok.replace('<path', '<rect width="1" height="1"/><path'),
    'nested svg': ok.replace('<path', `<svg xmlns="${SVG_NS}"></svg><path`),
    'event handler': ok.replace('<path d=', '<path onload="alert(1)" d='),
    'style attribute': ok.replace('<path d=', '<path style="fill:red" d='),
    'href': ok.replace('<path d=', '<path href="#x" d='),
    'fill attribute': ok.replace('<path d=', '<path fill="url(#x)" d='),
    'character reference': ok.replace('M0 0h1', 'M0 0&#104;1'),
    'comment': ok.replace('<path', '<!-- x --><path'),
    'text content': ok.replace('</svg>', 'hi</svg>'),
    'unquoted attribute': ok.replace('d="M0 0h1v1h-1z"', 'd=M0'),
    'single-quoted attribute': ok.replace('d="M0 0h1v1h-1z"', "d='M0 0'"),
    'other namespace': ok.replace(SVG_NS, 'http://www.w3.org/1999/xhtml'),
    'missing xmlns': ok.replace(`xmlns="${SVG_NS}" `, ''),
    'path data with letters beyond commands': ok.replace('M0 0h1v1h-1z', 'M0 0 url(x)'),
    'unclosed path': ok.replace('/>', '>'),
    'text after svg': `${ok}<script>alert(1)</script>`
  };

  for (const [name, source] of Object.entries(REJECTED)) {
    it(`rejects ${name}`, () => {
      assert.notDeepEqual(findImgSvgIssues(source), []);
    });
  }
});
