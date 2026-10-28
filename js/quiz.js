// Quiz engine: multiple-choice distractor picking and the typing-mode
// autosuggest filter.
//
// Pure module: no DOM, no `localStorage`, no `fetch`, no `Math.random`. The
// caller passes in the `countries` array from `data/countries.json` and an
// `rng` (`() => number` in `[0, 1)`); inputs are never mutated.
//
// Multiple choice (`pickDistractors`, `buildChoices`): 1 correct option plus
// `DISTRACTOR_COUNT` wrong ones. A distractor is never related to the target
// by `parentCode`, in either direction:
//   - the target itself;
//   - the target's parent (Puerto Rico never gets United States);
//   - the target's siblings, i.e. other entries sharing its parent (Puerto
//     Rico never gets Guam);
//   - the target's own dependents, i.e. entries whose parent is the target
//     (United States never gets Puerto Rico).
// Distractors are drawn uniformly from the target's region. Fallback: if the
// region has fewer than `DISTRACTOR_COUNT` valid candidates left after the
// exclusions, all of them are used and the rest are drawn uniformly from the
// other regions, with the same exclusions. Only if the whole dataset cannot
// supply enough does it throw.
//
// Typing mode (`filterSuggestions`): narrows the country list as the user
// types. It never grades text: the user answers by picking a suggestion
// (PLAN #7). Matching is against `name` and `aliases` after `normalizeText`,
// in tiers from best to worst (see `MATCH_TIERS`). Each country appears once,
// under its best match.

// ---- Tunables ----

/** Wrong options per multiple-choice question (4 options in total). */
export const DISTRACTOR_COUNT = 3;

/** Default number of autosuggest rows. */
export const DEFAULT_SUGGESTION_LIMIT = 8;

/**
 * Match tiers of `filterSuggestions`, best first. With `query` and `term`
 * both normalized:
 *   - `exact`: `term` equals `query`;
 *   - `prefix`: `term` starts with `query`;
 *   - `word-prefix`: a later word of `term` starts with `query`;
 *   - `substring`: `query` appears anywhere in `term`;
 *   - `subsequence`: the letters of `query` appear in order from the start of
 *     one of `term`'s words (`grmny` -> Germany);
 *   - `typo`: a prefix of `term` from the start of one of its words is within
 *     `getTypoThreshold(query)` edits (insert, delete, substitute or swap two
 *     neighbours) of `query` (`brazl` -> Brazil).
 * Spaces are ignored when comparing, so `ivorycoast` and `ivory coast` match
 * alike.
 */
export const MATCH_TIERS = Object.freeze([
  'exact',
  'prefix',
  'word-prefix',
  'substring',
  'subsequence',
  'typo'
]);

/** Shortest query (spaces excluded) that gets one typo tolerated. */
export const TYPO_MIN_LENGTH = 4;

/** Shortest query (spaces excluded) that gets two typos tolerated. */
export const TYPO_TWO_EDIT_LENGTH = 8;

const CODE_PATTERN = /^[A-Za-z0-9-]{1,16}$/;
const COMBINING_MARKS = /\p{M}+/gu;
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;

// ---- Validation helpers ----

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertCode(value, name) {
  if (typeof value !== 'string' || !CODE_PATTERN.test(value)) {
    throw new TypeError(`\`${name}\` must be a country code string of 1-16 letters, digits or hyphens.`);
  }
}

function assertCountryList(countries) {
  if (!Array.isArray(countries)) {
    throw new TypeError('`countries` must be an array of country objects.');
  }
  countries.forEach((country, i) => {
    if (!isPlainObject(country)) {
      throw new TypeError(`\`countries[${i}]\` must be an object.`);
    }
    assertCode(country.code, `countries[${i}].code`);
  });
}

function assertRegionFields(countries) {
  countries.forEach((country, i) => {
    if (typeof country.region !== 'string') {
      throw new TypeError(`\`countries[${i}].region\` must be a string.`);
    }
    if (country.parentCode !== undefined && country.parentCode !== null) {
      assertCode(country.parentCode, `countries[${i}].parentCode`);
    }
  });
}

function assertNameFields(countries) {
  countries.forEach((country, i) => {
    if (typeof country.name !== 'string') {
      throw new TypeError(`\`countries[${i}].name\` must be a string.`);
    }
    const isAliasesValid = country.aliases === undefined ||
      (Array.isArray(country.aliases) && country.aliases.every((alias) => typeof alias === 'string'));
    if (!isAliasesValid) {
      throw new TypeError(`\`countries[${i}].aliases\` must be an array of strings.`);
    }
  });
}

function assertRng(rng) {
  if (typeof rng !== 'function') {
    throw new TypeError('`rng` must be a function returning a number in [0, 1).');
  }
}

function draw(rng) {
  const value = rng();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError('`rng` must return a number in [0, 1).');
  }
  return value;
}

// ---- Random helpers ----

// Uniform sample of `count` items without replacement (partial
// Fisher-Yates on a copy).
function sampleUniform(items, count, rng) {
  const pool = [...items];
  const size = Math.min(count, pool.length);
  for (let i = 0; i < size; i += 1) {
    const j = i + Math.floor(draw(rng) * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, size);
}

function shuffle(items, rng) {
  return sampleUniform(items, items.length, rng);
}

// ---- Multiple choice ----

function parentOf(country) {
  return country.parentCode === undefined ? null : country.parentCode;
}

// First entry per code wins, so duplicate codes are counted once.
function dedupeByCode(countries) {
  const byCode = new Map();
  for (const country of countries) {
    if (!byCode.has(country.code)) {
      byCode.set(country.code, country);
    }
  }
  return [...byCode.values()];
}

function isRelated(candidate, target) {
  const targetParent = parentOf(target);
  const candidateParent = parentOf(candidate);
  return candidate.code === target.code ||
    candidate.code === targetParent ||
    (targetParent !== null && candidateParent === targetParent) ||
    candidateParent === target.code;
}

/**
 * Pick the wrong options for a multiple-choice question.
 *
 * Excludes the target, its parent, its siblings and its dependents (see the
 * module header), then draws uniformly from the target's region. If the
 * region has fewer than `DISTRACTOR_COUNT` valid candidates, all of them are
 * used and the rest are drawn uniformly from the other regions, with the same
 * exclusions. Duplicate codes in `countries` are counted once.
 *
 * @param {object} options
 * @param {string} options.code The target (correct answer) code.
 * @param {{ code: string, region: string, parentCode?: string | null }[]} options.countries
 *   All flags (the `countries` array of `data/countries.json`).
 * @param {() => number} options.rng Random source returning `[0, 1)`.
 * @returns {string[]} `DISTRACTOR_COUNT` distinct codes, in random order.
 * @throws {RangeError} If `code` is not in `countries`, or the whole dataset
 *   has fewer than `DISTRACTOR_COUNT` valid candidates.
 */
export function pickDistractors({ code, countries, rng } = {}) {
  assertCode(code, 'code');
  assertCountryList(countries);
  assertRegionFields(countries);
  assertRng(rng);

  const unique = dedupeByCode(countries);
  const target = unique.find((country) => country.code === code);
  if (target === undefined) {
    throw new RangeError(`\`code\` \`${code}\` is not in \`countries\`.`);
  }

  const candidates = unique.filter((country) => !isRelated(country, target));
  const sameRegion = candidates
    .filter((country) => country.region === target.region)
    .map((country) => country.code);
  const otherRegions = candidates
    .filter((country) => country.region !== target.region)
    .map((country) => country.code);

  if (sameRegion.length + otherRegions.length < DISTRACTOR_COUNT) {
    throw new RangeError(
      `\`countries\` has only ${sameRegion.length + otherRegions.length} valid distractors for \`${code}\`, ` +
      `need ${DISTRACTOR_COUNT}.`
    );
  }

  const picked = sampleUniform(sameRegion, DISTRACTOR_COUNT, rng);
  picked.push(...sampleUniform(otherRegions, DISTRACTOR_COUNT - picked.length, rng));
  return shuffle(picked, rng);
}

/**
 * Build the options of a multiple-choice question: the target plus
 * `pickDistractors`' wrong options, shuffled.
 *
 * @param {object} options
 * @param {string} options.code The target (correct answer) code.
 * @param {{ code: string, region: string, parentCode?: string | null }[]} options.countries
 *   All flags.
 * @param {() => number} options.rng Random source returning `[0, 1)`.
 * @returns {string[]} `DISTRACTOR_COUNT + 1` distinct codes in random order,
 *   exactly one of which is `code`.
 * @throws {RangeError} As `pickDistractors`.
 */
export function buildChoices({ code, countries, rng } = {}) {
  const distractors = pickDistractors({ code, countries, rng });
  return shuffle([code, ...distractors], rng);
}

// ---- Typing-mode autosuggest ----

/**
 * Normalize text for matching: strip diacritics (NFD, then drop combining
 * marks), lowercase, turn every run of punctuation or whitespace into one
 * space, and trim. `"Côte d'Ivoire"` and `"cote  d ivoire"` both become
 * `"cote d ivoire"`.
 *
 * @param {string} text Any text.
 * @returns {string} Normalized text (empty if `text` has no letters or
 *   digits).
 */
export function normalizeText(text) {
  if (typeof text !== 'string') {
    throw new TypeError('`text` must be a string.');
  }
  return text
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(NON_ALPHANUMERIC, ' ')
    .trim();
}

/**
 * How many typos `filterSuggestions` tolerates for a query: none below
 * `TYPO_MIN_LENGTH` letters (short queries would match almost anything), one
 * up to `TYPO_TWO_EDIT_LENGTH - 1`, two from there on.
 *
 * @param {string} query Raw query text.
 * @returns {number} Maximum edit distance, 0-2.
 */
export function getTypoThreshold(query) {
  if (typeof query !== 'string') {
    throw new TypeError('`query` must be a string.');
  }
  const length = normalizeText(query).replaceAll(' ', '').length;
  if (length >= TYPO_TWO_EDIT_LENGTH) {
    return 2;
  }
  return length >= TYPO_MIN_LENGTH ? 1 : 0;
}

// `term` split into the space-free suffixes that start at each word, e.g.
// `"new zealand"` -> `["newzealand", "zealand"]`.
function wordSuffixes(term) {
  const words = term.split(' ');
  return words.map((_, i) => words.slice(i).join(''));
}

// Gaps in the leftmost in-order match of `query`'s letters in `text`, or -1
// if there is none. `text[0]` must match `query[0]`.
function subsequenceGaps(query, text) {
  if (text[0] !== query[0]) {
    return -1;
  }
  let position = 0;
  for (const char of query) {
    position = text.indexOf(char, position);
    if (position === -1) {
      return -1;
    }
    position += 1;
  }
  return position - query.length;
}

// Smallest Damerau-Levenshtein (optimal string alignment) distance between
// `query` and any prefix of `text`, or `Infinity` once it is sure to exceed
// `maxDistance`.
function prefixEditDistance(query, text, maxDistance) {
  const width = text.length + 1;
  let previous2 = null;
  let previous = Array.from({ length: width }, (_, j) => j);
  for (let i = 1; i <= query.length; i += 1) {
    const current = new Array(width);
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j < width; j += 1) {
      const cost = query[i - 1] === text[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      const isSwap = i > 1 && j > 1 &&
        query[i - 1] === text[j - 2] &&
        query[i - 2] === text[j - 1];
      if (isSwap) {
        value = Math.min(value, previous2[j - 2] + 1);
      }
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > maxDistance) {
      return Infinity;
    }
    previous2 = previous;
    previous = current;
  }
  return Math.min(...previous);
}

// Best match of a normalized query against one normalized term, as
// `{ tier, score }` (lower is better for both), or `null`.
function matchTerm(query, compactQuery, term, maxDistance) {
  const compactTerm = term.replaceAll(' ', '');
  if (term === query || compactTerm === compactQuery) {
    return { tier: 0, score: 0 };
  }
  if (term.startsWith(query) || compactTerm.startsWith(compactQuery)) {
    return { tier: 1, score: 0 };
  }
  const wordIndex = ` ${term}`.indexOf(` ${query}`);
  if (wordIndex > 0) {
    return { tier: 2, score: wordIndex };
  }
  const index = term.indexOf(query);
  if (index !== -1) {
    return { tier: 3, score: index };
  }
  const compactIndex = compactTerm.indexOf(compactQuery);
  if (compactIndex !== -1) {
    return { tier: 3, score: compactIndex };
  }

  const suffixes = wordSuffixes(term);
  let gaps = Infinity;
  for (const suffix of suffixes) {
    const found = subsequenceGaps(compactQuery, suffix);
    if (found !== -1) {
      gaps = Math.min(gaps, found);
    }
  }
  if (gaps !== Infinity) {
    return { tier: 4, score: gaps };
  }

  if (maxDistance === 0) {
    return null;
  }
  let distance = Infinity;
  for (const suffix of suffixes) {
    distance = Math.min(distance, prefixEditDistance(compactQuery, suffix, maxDistance));
  }
  return distance <= maxDistance ? { tier: 5, score: distance } : null;
}

function compareMatches(a, b) {
  return a.tier - b.tier ||
    a.score - b.score ||
    a.termLength - b.termLength ||
    (a.sortName < b.sortName ? -1 : a.sortName > b.sortName ? 1 : 0) ||
    (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
}

/**
 * Filter and rank countries for the typing-mode autosuggest list.
 *
 * Both `query` and each country's `name` and `aliases` go through
 * `normalizeText`, then are compared in the tiers of `MATCH_TIERS`. Within a
 * tier, closer matches come first (earlier position, fewer gaps or fewer
 * edits), then shorter matched terms, then names alphabetically. Each country
 * appears at most once, under its best match; on a tie, `name` wins over an
 * alias. Duplicate codes in `countries` are counted once.
 *
 * @param {string} query What the user has typed so far.
 * @param {{ code: string, name: string, aliases?: string[] }[]} countries
 *   All flags.
 * @param {object} [options]
 * @param {number} [options.limit=DEFAULT_SUGGESTION_LIMIT] Maximum number of
 *   suggestions.
 * @returns {{ code: string, name: string, matched: string }[]} Suggestions,
 *   best first; `matched` is the `name` or alias that hit, as written in the
 *   data. Empty if `query` has no letters or digits.
 */
export function filterSuggestions(query, countries, { limit = DEFAULT_SUGGESTION_LIMIT } = {}) {
  if (typeof query !== 'string') {
    throw new TypeError('`query` must be a string.');
  }
  assertCountryList(countries);
  assertNameFields(countries);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('`limit` must be a positive integer.');
  }

  const normalizedQuery = normalizeText(query);
  if (normalizedQuery === '') {
    return [];
  }
  const compactQuery = normalizedQuery.replaceAll(' ', '');
  const maxDistance = getTypoThreshold(query);

  const matches = [];
  for (const country of dedupeByCode(countries)) {
    let best = null;
    for (const raw of [country.name, ...(country.aliases ?? [])]) {
      const term = normalizeText(raw);
      if (term === '') {
        continue;
      }
      const match = matchTerm(normalizedQuery, compactQuery, term, maxDistance);
      if (match === null) {
        continue;
      }
      const candidate = {
        ...match,
        termLength: term.length,
        sortName: normalizeText(country.name),
        code: country.code,
        name: country.name,
        matched: raw
      };
      if (best === null || compareMatches(candidate, best) < 0) {
        best = candidate;
      }
    }
    if (best !== null) {
      matches.push(best);
    }
  }

  return matches
    .sort(compareMatches)
    .slice(0, limit)
    .map(({ code, name, matched }) => ({ code, name, matched }));
}
