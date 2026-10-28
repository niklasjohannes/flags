// Small DOM helpers shared by every view.
//
// DOM safety (docs/CONVENTIONS.md): nodes are built with `createElement`,
// attributes and text nodes only. Nothing here parses HTML. `el` only builds
// allowlisted tags, refuses inline event handlers and `style` attributes (so
// the app stays CSP-ready) and only accepts relative URLs.
// Flags are only ever shown through `renderFlag` (an `<img>`), never inlined.

import { REGIONS } from './srs.js';

/** `alt` text of a flag before its answer is revealed. Never the name. */
export const FLAG_HIDDEN_ALT = 'Flag to identify';

/** Label of the "every region" choice. */
export const ALL_REGIONS_LABEL = 'All';

/** Human labels for `REGIONS`. */
export const REGION_LABELS = Object.freeze({
  africa: 'Africa',
  asia: 'Asia',
  europe: 'Europe',
  'north-america': 'North America',
  'south-america': 'South America',
  oceania: 'Oceania'
});

/** Human labels for the quiz modes (`QUIZ_MODES` in `js/storage.js`). */
export const MODE_LABELS = Object.freeze({
  mc: 'Multiple choice',
  typing: 'Typing'
});

// Tags the app builds. Extend deliberately (via the orchestrator); never add
// script-capable ones (`script`, `style`, `iframe`, `object`, `embed`, `a`
// with untrusted URLs, `svg`).
const ALLOWED_TAGS = new Set([
  'button', 'dialog', 'div', 'em', 'fieldset', 'h1', 'h2', 'h3', 'img', 'input',
  'label', 'legend', 'li', 'ol', 'p', 'section', 'small', 'span', 'strong',
  'ul'
]);
// `srcset` is refused outright: the app never uses it, and its URL list is
// harder to vet than a single URL.
const FORBIDDEN_ATTRIBUTES = new Set(['style', 'srcdoc', 'srcset']);
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction']);
const FLAG_CODE_PATTERN = /^[a-z]{2}$/;
const CHOICE_GROUP_VARIANTS = Object.freeze(['chips', 'segmented']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A URL is safe if it is a relative path (`flags/fr.svg`, `./x`) or a
// fragment (`#id`). Rejects any scheme (`javascript:`, `data:`, `https:`),
// root-absolute and protocol-relative paths. Browsers ignore leading control
// characters and spaces and strip tabs/newlines anywhere, so those are
// removed before checking (`" java\tscript:"` is still `javascript:`).
function isSafeUrl(value) {
  const cleaned = value.replace(/^[\u0000-\u0020]+/, '').replace(/[\t\n\r]/g, '');
  if (cleaned.startsWith('#')) {
    return true;
  }
  return !/^[a-z][a-z0-9+.-]*:/i.test(cleaned) && !/^[/\\]/.test(cleaned);
}

/**
 * Build an element.
 *
 * Everything is validated before any node is created.
 *
 * @param {string} tag Tag name from the allowlist (`ALLOWED_TAGS`).
 * @param {Object<string, string | number | boolean | null | undefined>}
 *   [attrs={}] Attributes. `true` sets an empty (boolean) attribute;
 *   `false`, `null` and `undefined` skip it. `on*` and `style` are refused:
 *   use `addEventListener` and CSS classes; `srcdoc` and `srcset` are refused
 *   too. `href`, `src`, `action` and
 *   `formaction` must be relative paths or `#fragment`s.
 * @param {Array<Node | string | number | null | undefined | false>}
 *   [children=[]] Child nodes. Strings and numbers become text nodes;
 *   `null`, `undefined` and `false` are skipped.
 * @returns {HTMLElement} The new element.
 */
export function el(tag, attrs = {}, children = []) {
  if (typeof tag !== 'string') {
    throw new TypeError('`tag` must be a string.');
  }
  if (!ALLOWED_TAGS.has(tag)) {
    throw new RangeError(`\`tag\` \`${tag}\` is not on the allowlist.`);
  }
  if (!isPlainObject(attrs)) {
    throw new TypeError('`attrs` must be an object.');
  }
  if (!Array.isArray(children)) {
    throw new TypeError('`children` must be an array.');
  }
  const attributes = [];
  for (const [name, value] of Object.entries(attrs)) {
    const lowerName = name.toLowerCase();
    if (lowerName.startsWith('on') || FORBIDDEN_ATTRIBUTES.has(lowerName)) {
      throw new RangeError(`\`attrs.${name}\` is not allowed: use \`addEventListener\` or a CSS class.`);
    }
    if (value === false || value === null || value === undefined) {
      continue;
    }
    const text = value === true ? '' : String(value);
    if (URL_ATTRIBUTES.has(lowerName) && !isSafeUrl(text)) {
      throw new RangeError(`\`attrs.${name}\` must be a relative path or a \`#fragment\`.`);
    }
    attributes.push([name, text]);
  }
  children.forEach((child, i) => {
    const isValid = child === null || child === undefined || child === false ||
      typeof child === 'string' || typeof child === 'number' ||
      (typeof Node !== 'undefined' && child instanceof Node);
    if (!isValid) {
      throw new TypeError(`\`children[${i}]\` must be a Node, string or number.`);
    }
  });

  const node = document.createElement(tag);
  for (const [name, text] of attributes) {
    node.setAttribute(name, text);
  }
  for (const child of children) {
    if (typeof child === 'string' || typeof child === 'number') {
      node.append(document.createTextNode(String(child)));
    } else if (child !== null && child !== undefined && child !== false) {
      node.append(child);
    }
  }
  return node;
}

/**
 * Point a flag `<img>` at `flags/<code>.svg`.
 *
 * Until the answer is revealed its `alt` is `FLAG_HIDDEN_ALT`, so assistive
 * tech and long-press tooltips never spoil the answer.
 *
 * @param {HTMLImageElement} img The image to update.
 * @param {string} code Lowercase two-letter country code.
 * @param {object} [options]
 * @param {string} [options.revealedName] The country name, once revealed;
 *   omit while the flag is still a question.
 * @returns {HTMLImageElement} `img`.
 */
export function renderFlag(img, code, { revealedName } = {}) {
  if (!(img instanceof HTMLImageElement)) {
    throw new TypeError('`img` must be an `<img>` element.');
  }
  if (typeof code !== 'string' || !FLAG_CODE_PATTERN.test(code)) {
    throw new TypeError('`code` must be a lowercase two-letter country code.');
  }
  if (revealedName !== undefined && (typeof revealedName !== 'string' || revealedName === '')) {
    throw new TypeError('`revealedName` must be a non-empty string, or omitted.');
  }
  img.setAttribute('src', `flags/${code}.svg`);
  img.setAttribute('alt', revealedName ?? FLAG_HIDDEN_ALT);
  return img;
}

/**
 * Human label of a region filter.
 *
 * @param {string | null} region One of `REGIONS`, or `null` for all regions.
 * @returns {string} e.g. `'North America'`, or `ALL_REGIONS_LABEL`.
 */
export function formatRegion(region) {
  if (region === null) {
    return ALL_REGIONS_LABEL;
  }
  if (!REGIONS.includes(region)) {
    throw new RangeError(`\`region\` must be one of ${REGIONS.join(', ')}, or \`null\`.`);
  }
  return REGION_LABELS[region];
}

/**
 * Build a single-choice group (native radio buttons styled as chips).
 *
 * @param {object} options
 * @param {string} options.name Radio group name; unique on the page.
 * @param {string} options.legend Visible group label.
 * @param {{ value: string, label: string }[]} options.choices Choices, in
 *   display order.
 * @param {string} options.selected Value of the initially checked choice.
 * @param {(value: string) => void} options.onChange Called with the newly
 *   checked value.
 * @param {AbortSignal} [options.signal] Removes the listener when aborted.
 * @param {string} [options.variant='chips'] `'chips'` (wrapping pills) or
 *   `'segmented'` (one row of equal-width segments, for 2-3 short choices).
 * @returns {HTMLFieldSetElement} The group.
 */
export function createChoiceGroup({ name, legend, choices, selected, onChange, signal, variant = 'chips' } = {}) {
  if (typeof name !== 'string' || name === '') {
    throw new TypeError('`name` must be a non-empty string.');
  }
  if (typeof legend !== 'string' || legend === '') {
    throw new TypeError('`legend` must be a non-empty string.');
  }
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new TypeError('`choices` must be a non-empty array.');
  }
  choices.forEach((choice, i) => {
    if (!isPlainObject(choice) || typeof choice.value !== 'string' || typeof choice.label !== 'string') {
      throw new TypeError(`\`choices[${i}]\` must be a \`{ value, label }\` object of strings.`);
    }
  });
  if (!choices.some((choice) => choice.value === selected)) {
    throw new RangeError('`selected` must be the value of one of `choices`.');
  }
  if (typeof onChange !== 'function') {
    throw new TypeError('`onChange` must be a function.');
  }
  if (!CHOICE_GROUP_VARIANTS.includes(variant)) {
    throw new RangeError(`\`variant\` must be one of ${CHOICE_GROUP_VARIANTS.join(', ')}.`);
  }
  const className = variant === 'segmented' ? 'choice-group choice-group-segmented' : 'choice-group';
  const group = el('fieldset', { class: className }, [
    el('legend', { class: 'choice-group-legend' }, [legend]),
    el('div', { class: 'choice-group-options' }, choices.map((choice) => el('label', { class: 'choice' }, [
      el('input', {
        class: 'choice-input',
        type: 'radio',
        name,
        value: choice.value,
        checked: choice.value === selected
      }),
      el('span', { class: 'choice-label' }, [choice.label])
    ])))
  ]);
  group.addEventListener('change', (event) => onChange(event.target.value), { signal });
  return group;
}
