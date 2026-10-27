// Allowlist safety check for vendored flag SVGs. Used by `scripts/build-countries.js`
// (refuses to vendor a failing file) and by `test/countries.test.js`.
//
// A file passes only if it tokenises completely as a single well-formed `<svg>`
// element tree built from the elements and attributes below, with double-quoted
// attribute values and nothing but whitespace between tags. Anything the
// allowlist doesn't name is rejected, rather than trying to enumerate what is
// dangerous. The lists are exactly what flag-icons v7.5.0's 231 kept 4x3 files use;
// widen them deliberately (and re-review) if a future release needs more.

const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'path', 'rect', 'circle', 'ellipse', 'use', 'clipPath',
  'linearGradient', 'radialGradient', 'stop', 'marker'
]);

const ALLOWED_ATTRIBUTES = new Set([
  'xmlns', 'xmlns:xlink', 'xml:space', 'id', 'class', 'viewBox', 'aria-label',
  'x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy',
  'x1', 'x2', 'y1', 'y2', 'd', 'transform', 'overflow', 'opacity', 'color', 'style',
  'fill', 'fill-rule', 'fill-opacity', 'clip-path',
  'stroke', 'stroke-width', 'stroke-linejoin', 'stroke-linecap', 'stroke-miterlimit',
  'stroke-opacity', 'stroke-dashoffset',
  'font-family', 'font-weight', 'font-size', 'letter-spacing', 'word-spacing', 'text-anchor',
  'offset', 'stop-color', 'stop-opacity', 'gradientTransform', 'gradientUnits',
  'markerHeight', 'markerWidth', 'marker-mid',
  'href', 'xlink:href'
]);

const ALLOWED_STYLE_PROPERTIES = new Set([
  '-inkscape-stroke', 'line-height', 'marker', 'text-align', 'text-decoration-line',
  'text-indent', 'text-transform'
]);

// Attributes whose value is pinned to one exact string.
const FIXED_ATTRIBUTE_VALUES = {
  xmlns: 'http://www.w3.org/2000/svg',
  'xmlns:xlink': 'http://www.w3.org/1999/xlink',
  'xml:space': 'preserve'
};

const FRAGMENT_REF = /^#[A-Za-z_][\w.-]*$/;
const URL_CALL = /url\(([^)]*)\)/gi;
const FRAGMENT_URL_ARG = /^#[A-Za-z_][\w.-]*$/;
const STYLE_DECLARATION = /^\s*(-?[a-z][a-z-]*)\s*:\s*([A-Za-z0-9%.-]+)\s*$/;

// Characters that never appear in the allowlisted corpus and would open an
// escape hatch past the tokeniser: entity/character references (`&`),
// processing instructions / doctype / CDATA / comments (`<?`, `<!`),
// CSS escapes (`\`) and CSS at-rules (`@`).
const FORBIDDEN_SEQUENCES = [
  { pattern: /&/, reason: 'contains `&` (entity or character reference)' },
  { pattern: /<\?/, reason: 'contains `<?` (XML declaration or processing instruction)' },
  { pattern: /<!/, reason: 'contains `<!` (DOCTYPE, ENTITY, CDATA or comment)' },
  { pattern: /\\/, reason: 'contains `\\` (CSS escape)' },
  { pattern: /@/, reason: 'contains `@` (CSS at-rule)' }
];

// `<name attrs>`, `</name>` or `<name attrs/>`; every attribute must be
// whitespace-separated and double-quoted, with no `<`, `>` or `"` inside.
const TAG = /<(\/?)([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z][\w:-]*="[^"<>]*")*)\s*(\/?)>/y;
const ATTRIBUTE = /([A-Za-z][\w:-]*)="([^"<>]*)"/g;
const WHITESPACE = /\s+/y;

/**
 * Check one attribute against the allowlist.
 * @param {string} element Element name.
 * @param {string} name Attribute name.
 * @param {string} value Attribute value (raw, without quotes).
 * @returns {string[]} Reasons the attribute is unsafe; empty when it passes.
 */
function checkAttribute(element, name, value) {
  const where = `<${element} ${name}>`;
  if (!ALLOWED_ATTRIBUTES.has(name)) {
    return [`${where}: attribute not in allowlist`];
  }
  if (name in FIXED_ATTRIBUTE_VALUES && value !== FIXED_ATTRIBUTE_VALUES[name]) {
    return [`${where}: value must be \`${FIXED_ATTRIBUTE_VALUES[name]}\``];
  }
  if ((name === 'xmlns' || name === 'xmlns:xlink') && element !== 'svg') {
    return [`${where}: namespace declarations are only allowed on the root`];
  }
  if ((name === 'href' || name === 'xlink:href') && !FRAGMENT_REF.test(value)) {
    return [`${where}: only same-document \`#id\` references are allowed`];
  }
  const issues = [];
  for (const [, argument] of value.matchAll(URL_CALL)) {
    if (!FRAGMENT_URL_ARG.test(argument.trim())) {
      issues.push(`${where}: only \`url(#id)\` is allowed`);
    }
  }
  if (name === 'style') {
    for (const declaration of value.split(';').filter((part) => part.trim() !== '')) {
      const match = STYLE_DECLARATION.exec(declaration);
      if (!match) {
        issues.push(`${where}: style declaration \`${declaration.trim()}\` is not a plain property:value`);
      } else if (!ALLOWED_STYLE_PROPERTIES.has(match[1])) {
        issues.push(`${where}: style property \`${match[1]}\` not in allowlist`);
      }
    }
  }
  return issues;
}

/**
 * List every reason an SVG source string is unsafe to ship.
 * @param {string} svgSource Raw SVG file contents.
 * @returns {string[]} Human-readable reasons; empty when the SVG passes.
 */
export function findSvgSafetyIssues(svgSource) {
  if (typeof svgSource !== 'string') {
    throw new TypeError('`svgSource` must be a string.');
  }

  const issues = FORBIDDEN_SEQUENCES
    .filter(({ pattern }) => pattern.test(svgSource))
    .map(({ reason }) => reason);

  const stack = [];
  let rootSeen = false;
  let index = 0;
  while (index < svgSource.length) {
    WHITESPACE.lastIndex = index;
    if (WHITESPACE.test(svgSource)) {
      index = WHITESPACE.lastIndex;
      continue;
    }
    TAG.lastIndex = index;
    const tag = TAG.exec(svgSource);
    if (!tag) {
      issues.push(`unexpected content at offset ${index}: \`${svgSource.slice(index, index + 30)}\``);
      break;
    }
    index = TAG.lastIndex;
    const [, closing, element, attributes, selfClosing] = tag;

    if (closing) {
      if (attributes.trim() !== '' || selfClosing) {
        issues.push(`malformed closing tag </${element}>`);
      }
      if (stack.pop() !== element) {
        issues.push(`mismatched closing tag </${element}>`);
      }
      continue;
    }

    if (!ALLOWED_ELEMENTS.has(element)) {
      issues.push(`<${element}>: element not in allowlist`);
    }
    if (stack.length === 0) {
      if (rootSeen || element !== 'svg') {
        issues.push(`<${element}>: the document must be a single <svg> root`);
      }
      rootSeen = true;
    }
    for (const [, name, value] of attributes.matchAll(ATTRIBUTE)) {
      issues.push(...checkAttribute(element, name, value));
    }
    if (!selfClosing) {
      stack.push(element);
    }
  }

  if (!rootSeen) {
    issues.push('no <svg> root element');
  }
  if (stack.length > 0) {
    issues.push(`unclosed element(s): ${stack.join(', ')}`);
  }
  return issues;
}

/**
 * Normalise an SVG so that two flags differing only in their flag-icons `id`
 * (`flag-icons-<code>`) and `<code>-` id prefixes compare equal.
 * @param {string} code Lowercase flag code the SVG belongs to.
 * @param {string} svgSource Raw SVG file contents.
 * @returns {string} Normalised SVG source.
 */
export function normaliseSvgIds(code, svgSource) {
  if (typeof code !== 'string' || !/^[a-z]{2}$/.test(code)) {
    throw new TypeError('`code` must be a lowercase two-letter code.');
  }
  if (typeof svgSource !== 'string') {
    throw new TypeError('`svgSource` must be a string.');
  }
  return svgSource
    .replaceAll(`flag-icons-${code}`, 'flag-icons-ID')
    .replace(new RegExp(`\\b${code}-`, 'g'), 'ID-')
    .replace(/\s+/g, ' ')
    .trim();
}
