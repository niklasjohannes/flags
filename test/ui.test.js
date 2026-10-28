import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MODE_LABELS, REGION_LABELS, el, formatRegion } from '../js/ui.js';
import { REGIONS } from '../js/srs.js';
import { QUIZ_MODES } from '../js/storage.js';

// `el` validates everything before touching the DOM, so rejections need no
// DOM at all. The accepting cases use this minimal stand-in for `document`.
class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.attributes = new Map();
    this.children = [];
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  append(child) {
    this.children.push(child);
  }
}

const fakeDocument = {
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (text) => ({ text })
};

// ---- el: rejections (no DOM needed) ----

describe('el rejects', () => {
  it('tags that are not on the allowlist', () => {
    for (const tag of ['script', 'style', 'iframe', 'object', 'embed', 'a', 'svg', 'form', 'SCRIPT', 'p ']) {
      assert.throws(() => el(tag), RangeError, tag);
    }
    assert.throws(() => el(42), TypeError);
  });

  it('inline event handlers and style attributes', () => {
    for (const name of ['onclick', 'onError', 'ONLOAD', 'style', 'srcdoc']) {
      assert.throws(() => el('div', { [name]: 'x' }), RangeError, name);
    }
  });

  it('URLs that are not relative paths or fragments', () => {
    const unsafe = [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      '\u0001javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'data:image/svg+xml,<svg/>',
      'https://example.com/x.svg',
      '//example.com/x.svg',
      '/flags/fr.svg',
      '\\\\example.com/x.svg'
    ];
    for (const name of ['href', 'src', 'action', 'formaction', 'SRC']) {
      for (const value of unsafe) {
        assert.throws(() => el('img', { [name]: value }), RangeError, `${name}=${JSON.stringify(value)}`);
      }
    }
  });

  it('malformed attrs and children', () => {
    assert.throws(() => el('div', null), TypeError);
    assert.throws(() => el('div', []), TypeError);
    assert.throws(() => el('div', {}, 'text'), TypeError);
    assert.throws(() => el('div', {}, [{}]), TypeError);
  });
});

// ---- el: accepted input (fake document) ----

describe('el builds', () => {
  let original;

  before(() => {
    original = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true });
  });

  after(() => {
    if (original === undefined) {
      delete globalThis.document;
    } else {
      Object.defineProperty(globalThis, 'document', original);
    }
  });

  it('attributes, with boolean and skipped values', () => {
    const node = el('input', { type: 'radio', checked: true, disabled: false, name: null, value: 3 });
    assert.equal(node.tag, 'input');
    assert.deepEqual([...node.attributes], [['type', 'radio'], ['checked', ''], ['value', '3']]);
  });

  it('relative and fragment URLs', () => {
    for (const value of ['flags/fr.svg', './flags/fr.svg', '../x', '#main', 'a/b:c']) {
      assert.equal(el('img', { src: value }).attributes.get('src'), value);
    }
  });

  it('text nodes from strings and numbers, skipping empty children', () => {
    const node = el('p', {}, ['<b>x</b>', 7, null, undefined, false]);
    assert.deepEqual(node.children, [{ text: '<b>x</b>' }, { text: '7' }]);
  });
});

// ---- Labels ----

describe('labels', () => {
  it('cover every region and mode', () => {
    assert.deepEqual(Object.keys(REGION_LABELS).sort(), [...REGIONS].sort());
    assert.deepEqual(Object.keys(MODE_LABELS).sort(), [...QUIZ_MODES].sort());
  });

  it('formatRegion maps null to All and rejects unknown regions', () => {
    assert.equal(formatRegion(null), 'All');
    assert.equal(formatRegion('north-america'), 'North America');
    assert.throws(() => formatRegion('antarctica'), RangeError);
    assert.throws(() => formatRegion(undefined), RangeError);
  });
});
