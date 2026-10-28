// Test-mode pass (spec #6, PLAN decision 4): every flag in a scope exactly
// once, in random order, answered blind, then scored. Pure: no DOM, no
// storage, no clock; the caller injects `rng`. Test mode never touches SRS
// card state, so nothing here reads or writes it.
//
// A pass is a frozen `{ region, codes, answers }`:
//   region   One of `REGIONS`, or `null` for All.
//   codes    The flags to ask, in asking order.
//   answers  The code chosen for each asked flag so far (`answers[i]` is the
//            answer to `codes[i]`). The pass is complete when both have the
//            same length.

import { REGIONS } from './srs.js';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

function assertCountries(countries) {
  if (!Array.isArray(countries)) {
    throw new TypeError('`countries` must be an array.');
  }
  countries.forEach((country, i) => {
    if (!isPlainObject(country) || !isNonEmptyString(country.code) || !isNonEmptyString(country.name)) {
      throw new TypeError(`\`countries[${i}]\` must be an object with a \`code\` and a \`name\`.`);
    }
  });
}

function assertRegion(region) {
  if (region !== null && !REGIONS.includes(region)) {
    throw new RangeError(`\`region\` must be one of ${REGIONS.join(', ')}, or \`null\`.`);
  }
}

function assertPass(pass) {
  const isPass = isPlainObject(pass) &&
    Array.isArray(pass.codes) &&
    Array.isArray(pass.answers) &&
    pass.answers.length <= pass.codes.length &&
    pass.codes.every(isNonEmptyString) &&
    pass.answers.every(isNonEmptyString);
  if (!isPass) {
    throw new TypeError('`pass` must be a test pass from `createTestPass`.');
  }
  assertRegion(pass.region);
}

function freezePass(region, codes, answers) {
  return Object.freeze({
    region,
    codes: Object.freeze(codes),
    answers: Object.freeze(answers)
  });
}

/**
 * Codes of the flags in a scope, in data order.
 *
 * @param {object} options
 * @param {object[]} options.countries The `countries` array of
 *   `data/countries.json`.
 * @param {string | null} options.region One of `REGIONS`, or `null` for All.
 * @returns {string[]} Country codes.
 */
export function getScopeCodes({ countries, region } = {}) {
  assertCountries(countries);
  assertRegion(region);
  return countries
    .filter((country) => region === null || country.region === region)
    .map((country) => country.code);
}

/**
 * Start a test pass: every flag in the scope once, shuffled.
 *
 * @param {object} options
 * @param {object[]} options.countries The `countries` array of
 *   `data/countries.json`.
 * @param {string | null} options.region One of `REGIONS`, or `null` for All.
 * @param {() => number} options.rng Random source returning `[0, 1)` (e.g.
 *   `Math.random`).
 * @returns {{ region: string | null, codes: string[], answers: string[] }}
 *   The pass (frozen), with no answers yet.
 */
export function createTestPass({ countries, region, rng } = {}) {
  const codes = getScopeCodes({ countries, region });
  if (typeof rng !== 'function') {
    throw new TypeError('`rng` must be a function returning a number in [0, 1).');
  }
  if (codes.length === 0) {
    throw new RangeError('`region` must contain at least one flag.');
  }
  // Fisher-Yates.
  for (let i = codes.length - 1; i > 0; i -= 1) {
    const r = rng();
    if (typeof r !== 'number' || !(r >= 0 && r < 1)) {
      throw new RangeError('`rng` must return a number in [0, 1).');
    }
    const j = Math.floor(r * (i + 1));
    [codes[i], codes[j]] = [codes[j], codes[i]];
  }
  return freezePass(region, codes, []);
}

/**
 * Whether every flag of a pass has been answered.
 *
 * @param {{ codes: string[], answers: string[] }} pass From `createTestPass`.
 * @returns {boolean}
 */
export function isPassComplete(pass) {
  assertPass(pass);
  return pass.answers.length === pass.codes.length;
}

/**
 * Record the answer to the pass's current flag (`codes[answers.length]`).
 *
 * @param {{ region: string | null, codes: string[], answers: string[] }} pass
 *   From `createTestPass` or a previous `recordAnswer`; not complete.
 * @param {string} chosenCode The code the user picked.
 * @returns {{ region: string | null, codes: string[], answers: string[] }}
 *   A new pass (frozen); `pass` is unchanged.
 */
export function recordAnswer(pass, chosenCode) {
  assertPass(pass);
  if (!isNonEmptyString(chosenCode)) {
    throw new TypeError('`chosenCode` must be a non-empty string.');
  }
  if (pass.answers.length === pass.codes.length) {
    throw new RangeError('`pass` is already complete.');
  }
  return freezePass(pass.region, [...pass.codes], [...pass.answers, chosenCode]);
}

/**
 * Score a complete pass.
 *
 * @param {{ codes: string[], answers: string[] }} pass A complete pass.
 * @param {object[]} countries The `countries` array of `data/countries.json`,
 *   for the names.
 * @returns {{
 *   total: number,
 *   correct: number,
 *   percent: number,
 *   missed: { code: string, name: string, chosenCode: string, chosenName: string }[]
 * }} The score (frozen). `percent` is rounded down, so 100 means a perfect
 *   pass. `missed` is in asking order.
 */
export function scorePass(pass, countries) {
  assertPass(pass);
  assertCountries(countries);
  if (pass.answers.length !== pass.codes.length) {
    throw new RangeError('`pass` must be complete.');
  }
  const names = new Map(countries.map((country) => [country.code, country.name]));
  const getName = (code) => {
    if (!names.has(code)) {
      throw new RangeError(`\`pass\` has code \`${code}\`, which is not in \`countries\`.`);
    }
    return names.get(code);
  };
  const missed = [];
  pass.codes.forEach((code, i) => {
    const chosenCode = pass.answers[i];
    const name = getName(code);
    const chosenName = getName(chosenCode);
    if (chosenCode !== code) {
      missed.push(Object.freeze({ code, name, chosenCode, chosenName }));
    }
  });
  const total = pass.codes.length;
  const correct = total - missed.length;
  return Object.freeze({
    total,
    correct,
    percent: total === 0 ? 0 : Math.floor((correct * 100) / total),
    missed: Object.freeze(missed)
  });
}

/**
 * Format a score for display.
 *
 * @param {{ correct: number, total: number, percent: number }} score From
 *   `scorePass`.
 * @returns {string} e.g. `'182/195 · 93%'`.
 */
export function formatScore(score) {
  const isScore = isPlainObject(score) &&
    [score.correct, score.total, score.percent].every(Number.isInteger) &&
    score.correct >= 0 && score.correct <= score.total;
  if (!isScore) {
    throw new TypeError('`score` must be a score from `scorePass`.');
  }
  return `${score.correct}/${score.total} · ${score.percent}%`;
}
