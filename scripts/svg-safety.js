// Static safety checks for vendored flag SVGs. Used by `scripts/build-countries.js`
// (refuses to vendor a failing file) and by `test/countries.test.js`.

const UNSAFE_PATTERNS = [
  { pattern: /<script\b/i, reason: 'contains a <script> element' },
  { pattern: /\son[a-z]+\s*=/i, reason: 'contains an on* event-handler attribute' },
  { pattern: /<foreignObject\b/i, reason: 'contains a <foreignObject> element' },
  { pattern: /\b(?:xlink:)?href\s*=\s*["']\s*(?:https?:|\/\/)/i, reason: 'contains an external href/xlink:href' },
  { pattern: /\b(?:xlink:)?href\s*=\s*["']\s*(?:javascript|data):/i, reason: 'contains a javascript:/data: href' },
  { pattern: /url\(\s*["']?\s*(?:https?:|\/\/|javascript:|data:)/i, reason: 'contains an external or scriptable url()' },
  { pattern: /@import\b/i, reason: 'contains a CSS @import' },
  { pattern: /<!(?:DOCTYPE|ENTITY)\b/i, reason: 'contains a DOCTYPE or ENTITY declaration' }
];

/**
 * List every reason an SVG source string is unsafe to ship.
 * @param {string} svgSource Raw SVG file contents.
 * @returns {string[]} Human-readable reasons; empty when the SVG passes.
 */
export function findSvgSafetyIssues(svgSource) {
  if (typeof svgSource !== 'string') {
    throw new TypeError('`svgSource` must be a string.');
  }
  return UNSAFE_PATTERNS
    .filter(({ pattern }) => pattern.test(svgSource))
    .map(({ reason }) => reason);
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
