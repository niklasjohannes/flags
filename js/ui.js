// Small DOM helpers shared by every view.
//
// DOM safety (docs/CONVENTIONS.md): nodes are built with `createElement`,
// attributes and text nodes only. Nothing here parses HTML, and `el` refuses
// inline event handlers and `style` attributes so the app stays CSP-ready.
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

const TAG_PATTERN = /^[a-z][a-z0-9-]*$/;
const FORBIDDEN_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed']);
const FORBIDDEN_ATTRIBUTES = new Set(['style', 'srcdoc']);
const FLAG_CODE_PATTERN = /^[a-z]{2}$/;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build an element.
 *
 * @param {string} tag Lowercase tag name (`script`, `style`, `iframe`,
 *   `object` and `embed` are refused).
 * @param {Object<string, string | number | boolean | null | undefined>}
 *   [attrs={}] Attributes. `true` sets an empty (boolean) attribute;
 *   `false`, `null` and `undefined` skip it. `on*` and `style` are refused:
 *   use `addEventListener` and CSS classes.
 * @param {Array<Node | string | number | null | undefined | false>}
 *   [children=[]] Child nodes. Strings and numbers become text nodes;
 *   `null`, `undefined` and `false` are skipped.
 * @returns {HTMLElement} The new element.
 */
export function el(tag, attrs = {}, children = []) {
  if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) {
    throw new TypeError('`tag` must be a lowercase tag name.');
  }
  if (FORBIDDEN_TAGS.has(tag)) {
    throw new RangeError(`\`tag\` must not be \`${tag}\`.`);
  }
  if (!isPlainObject(attrs)) {
    throw new TypeError('`attrs` must be an object.');
  }
  if (!Array.isArray(children)) {
    throw new TypeError('`children` must be an array.');
  }
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    const lowerName = name.toLowerCase();
    if (lowerName.startsWith('on') || FORBIDDEN_ATTRIBUTES.has(lowerName)) {
      throw new RangeError(`\`attrs.${name}\` is not allowed: use \`addEventListener\` or a CSS class.`);
    }
    if (value === false || value === null || value === undefined) {
      continue;
    }
    node.setAttribute(name, value === true ? '' : String(value));
  }
  children.forEach((child, i) => {
    if (child === null || child === undefined || child === false) {
      return;
    }
    if (typeof child === 'string' || typeof child === 'number') {
      node.append(document.createTextNode(String(child)));
    } else if (child instanceof Node) {
      node.append(child);
    } else {
      throw new TypeError(`\`children[${i}]\` must be a Node, string or number.`);
    }
  });
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
 * @returns {HTMLFieldSetElement} The group.
 */
export function createChoiceGroup({ name, legend, choices, selected, onChange, signal } = {}) {
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
  const group = el('fieldset', { class: 'choice-group' }, [
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
