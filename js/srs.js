// Spaced-repetition engine: an SM-2-style scheduler simplified to binary
// (correct / incorrect) answers.
//
// Pure module: no DOM, no `localStorage`, no clock, no `Math.random`. Every
// function takes state in and returns new values out; inputs are never
// mutated. The caller injects `today` (a local `YYYY-MM-DD` string computed
// from the device clock) and `rng` (`() => number` in `[0, 1)`).
//
// Per-flag state, persisted by the caller as a map keyed by country code:
//
//   { code, repetitions, easeFactor, intervalDays, dueDate, lapses }
//
// A never-seen flag has no entry in the map (or a fresh entry from
// `createCardState`, whose `dueDate` is `null`). Any answer gives it a date.
//
// Intended practice-session flow (spec #5):
//   1. `pickRound(...)` returns the codes for a round.
//   2. On the FIRST answer to a code in the session, persist
//      `updateCardState(state, correct, today)`.
//   3. On a miss, `requeueLapse(upcoming, code)` puts the code back into the
//      upcoming queue a few questions later. A re-ask is short-term
//      reinforcement only: its answer must NOT call `updateCardState` again,
//      and should not count towards the round score. The first answer in a
//      session is the one that counts.

// ---- Tunables ----

/** Questions per practice round (spec #5). */
export const ROUND_SIZE = 10;

/** Ease factor of a never-seen flag; SM-2's starting value. */
export const INITIAL_EASE_FACTOR = 2.5;

/**
 * Ease factor floor; SM-2's floor. Keeps a struggling flag's intervals short
 * even after a lucky streak.
 */
export const MIN_EASE_FACTOR = 1.3;

/**
 * Ease factor cap. SM-2 has none because a "perfect" grade is rare; with
 * binary answers every correct one nudges ease up, so without a cap ease
 * would climb forever.
 */
export const MAX_EASE_FACTOR = 3.0;

/**
 * Ease increase on a correct answer. Sits between SM-2's +0.0 (grade 4) and
 * +0.1 (grade 5): a correct multiple-choice answer can be a 1-in-4 guess.
 */
export const EASE_STEP_UP = 0.05;

/** Ease decrease on an incorrect answer. Close to SM-2's grade-2 penalty. */
export const EASE_STEP_DOWN = 0.2;

/** Interval after the first correct answer in a streak (SM-2). */
export const FIRST_INTERVAL_DAYS = 1;

/** Interval after the second correct answer in a streak (SM-2). */
export const SECOND_INTERVAL_DAYS = 6;

/** Interval after an incorrect answer: the flag is due again tomorrow. */
export const LAPSE_INTERVAL_DAYS = 1;

/** Interval cap, so even a mastered flag comes back at least once a year. */
export const MAX_INTERVAL_DAYS = 365;

/**
 * How many other questions are asked before a missed flag is re-asked within
 * the same session.
 */
export const REQUEUE_GAP = 3;

/**
 * Maximum number of never-seen flags that compete with due flags in a round.
 * More are only added when nothing else in scope can fill the round.
 */
export const NEW_FLAG_LIMIT = 3;

/** Weight added per day overdue, up to `OVERDUE_DAYS_CAP` days. */
export const OVERDUE_WEIGHT_PER_DAY = 0.25;

/**
 * Days overdue beyond which the overdue weight stops growing (so a flag 300
 * days overdue does not drown out everything else).
 */
export const OVERDUE_DAYS_CAP = 28;

/** Weight added at the ease floor, scaled linearly down to 0 at the cap. */
export const EASE_WEIGHT = 2;

/** Weight added per lapse, up to `LAPSES_CAP` lapses. */
export const LAPSE_WEIGHT = 0.5;

/** Lapses beyond which the lapse weight stops growing. */
export const LAPSES_CAP = 6;

/** Pick weight of a never-seen flag in the trickle. */
export const NEW_FLAG_WEIGHT = 1;

/** The closed continent taxonomy used by `region` filters (spec #1). */
export const REGIONS = Object.freeze([
  'africa',
  'asia',
  'europe',
  'north-america',
  'south-america',
  'oceania'
]);

/** Latest date the engine ever computes; later due dates are clamped to it. */
export const MAX_DATE = '9999-12-31';

const MS_PER_DAY = 86_400_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const CODE_PATTERN = /^[A-Za-z0-9-]{1,16}$/;

// ---- Date helpers (day-granular, DST-safe via UTC) ----

function parseDate(value) {
  const match = typeof value === 'string' ? DATE_PATTERN.exec(value) : null;
  if (match === null) {
    return null;
  }
  const [, year, month, day] = match.map(Number);
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  const isRealDate = date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  return isRealDate ? ms : null;
}

function formatDate(ms) {
  const date = new Date(ms);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Clamped to `MAX_DATE`, so a computed date always stays a valid
// four-digit-year date string.
function addDays(date, days) {
  return formatDate(Math.min(parseDate(date) + days * MS_PER_DAY, parseDate(MAX_DATE)));
}

function diffDays(later, earlier) {
  return Math.round((parseDate(later) - parseDate(earlier)) / MS_PER_DAY);
}

// ---- Validation helpers ----

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function assertDate(value, name) {
  if (parseDate(value) === null) {
    throw new TypeError(`\`${name}\` must be a real calendar date string in \`YYYY-MM-DD\` format.`);
  }
}

function assertCode(value, name) {
  if (typeof value !== 'string' || !CODE_PATTERN.test(value)) {
    throw new TypeError(`\`${name}\` must be a country code string of 1-16 letters, digits or hyphens.`);
  }
}

function assertCardState(state, name) {
  if (!isPlainObject(state)) {
    throw new TypeError(`\`${name}\` must be a card state object.`);
  }
  assertCode(state.code, `${name}.code`);
  for (const field of ['repetitions', 'intervalDays', 'lapses']) {
    if (!isNonNegativeInteger(state[field])) {
      throw new TypeError(`\`${name}.${field}\` must be a non-negative integer.`);
    }
  }
  const isEaseValid = Number.isFinite(state.easeFactor) &&
    state.easeFactor >= MIN_EASE_FACTOR &&
    state.easeFactor <= MAX_EASE_FACTOR;
  if (!isEaseValid) {
    throw new RangeError(`\`${name}.easeFactor\` must be a number between ${MIN_EASE_FACTOR} and ${MAX_EASE_FACTOR}.`);
  }
  if (state.dueDate !== null) {
    assertDate(state.dueDate, `${name}.dueDate`);
  }
}

function assertStates(states) {
  if (!isPlainObject(states)) {
    throw new TypeError('`states` must be an object mapping country codes to card states.');
  }
}

function assertCountries(countries) {
  if (!Array.isArray(countries)) {
    throw new TypeError('`countries` must be an array of `{ code, region }` objects.');
  }
  countries.forEach((country, i) => {
    if (!isPlainObject(country)) {
      throw new TypeError(`\`countries[${i}]\` must be an object.`);
    }
    assertCode(country.code, `countries[${i}].code`);
    if (typeof country.region !== 'string') {
      throw new TypeError(`\`countries[${i}].region\` must be a string.`);
    }
  });
}

function assertRegion(region) {
  if (region !== undefined && region !== null && !REGIONS.includes(region)) {
    throw new RangeError(`\`region\` must be one of ${REGIONS.join(', ')}, or omitted for all regions.`);
  }
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

function roundEase(value) {
  return Math.round(value * 100) / 100;
}

// ---- Card state ----

/**
 * Create the state of a never-seen flag.
 *
 * @param {string} code Country code.
 * @returns {{ code: string, repetitions: number, easeFactor: number, intervalDays: number, dueDate: null, lapses: number }}
 *   Fresh state with `dueDate: null`.
 */
export function createCardState(code) {
  assertCode(code, 'code');
  return {
    code,
    repetitions: 0,
    easeFactor: INITIAL_EASE_FACTOR,
    intervalDays: 0,
    dueDate: null,
    lapses: 0
  };
}

/**
 * Tell a never-seen flag apart from one that has been answered at least once.
 *
 * @param {object | null | undefined} state Card state, or nothing if the flag
 *   has no entry in the state map.
 * @returns {boolean} `true` if the flag has never been answered.
 */
export function isNewCard(state) {
  if (state === undefined || state === null) {
    return true;
  }
  assertCardState(state, 'state');
  return state.dueDate === null;
}

/**
 * Apply one answer to a flag's state.
 *
 * Correct: `repetitions + 1`, interval 1 -> 6 -> `round(interval * easeFactor)`
 * (capped at `MAX_INTERVAL_DAYS`), ease up by `EASE_STEP_UP` (capped).
 * Incorrect: `repetitions` back to 0, interval 1 day, ease down by
 * `EASE_STEP_DOWN` (floored), `lapses + 1`. Either way `dueDate` becomes
 * `today + intervalDays`.
 *
 * Call this only for the first answer to a flag in a session (see the module
 * header).
 *
 * @param {object} state Current card state (use `createCardState` for a
 *   never-seen flag).
 * @param {boolean} correct Whether the answer was correct.
 * @param {string} today Local date, `YYYY-MM-DD`.
 * @returns {object} New card state; `state` is not modified.
 */
export function updateCardState(state, correct, today) {
  assertCardState(state, 'state');
  if (typeof correct !== 'boolean') {
    throw new TypeError('`correct` must be a boolean.');
  }
  assertDate(today, 'today');

  if (!correct) {
    return {
      code: state.code,
      repetitions: 0,
      easeFactor: roundEase(Math.max(MIN_EASE_FACTOR, state.easeFactor - EASE_STEP_DOWN)),
      intervalDays: LAPSE_INTERVAL_DAYS,
      dueDate: addDays(today, LAPSE_INTERVAL_DAYS),
      lapses: state.lapses + 1
    };
  }

  const repetitions = state.repetitions + 1;
  let intervalDays;
  if (repetitions === 1) {
    intervalDays = FIRST_INTERVAL_DAYS;
  } else if (repetitions === 2) {
    intervalDays = SECOND_INTERVAL_DAYS;
  } else {
    // Grow by at least a day, so a repaired state with a short interval
    // (e.g. `intervalDays: 1` at `repetitions: 3`) cannot stall.
    const previous = Math.max(state.intervalDays, 1);
    intervalDays = Math.max(Math.round(previous * state.easeFactor), previous + 1);
  }
  intervalDays = Math.min(intervalDays, MAX_INTERVAL_DAYS);

  return {
    code: state.code,
    repetitions,
    easeFactor: roundEase(Math.min(MAX_EASE_FACTOR, state.easeFactor + EASE_STEP_UP)),
    intervalDays,
    dueDate: addDays(today, intervalDays),
    lapses: state.lapses
  };
}

// ---- Within-session re-queue ----

/**
 * Put a missed flag back into the session queue a few questions later.
 *
 * Any existing occurrence of `code` in `queue` is removed first, so the queue
 * never holds the same flag twice. The re-ask is short-term reinforcement
 * only: the caller must not persist its answer (see the module header).
 *
 * @param {string[]} queue Upcoming codes, in order, NOT including the
 *   question that was just answered.
 * @param {string} code The missed flag's code.
 * @param {number} [gap=REQUEUE_GAP] How many other questions to ask before
 *   the re-ask. If fewer remain, the code goes to the end of the queue.
 * @returns {string[]} New queue; `queue` is not modified.
 */
export function requeueLapse(queue, code, gap = REQUEUE_GAP) {
  if (!Array.isArray(queue) || !queue.every((item) => typeof item === 'string')) {
    throw new TypeError('`queue` must be an array of country code strings.');
  }
  assertCode(code, 'code');
  if (!Number.isInteger(gap) || gap < 1) {
    throw new RangeError('`gap` must be a positive integer.');
  }
  const rest = queue.filter((item) => item !== code);
  const position = Math.min(gap, rest.length);
  return [...rest.slice(0, position), code, ...rest.slice(position)];
}

// ---- Scheduling ----

function difficultyWeight(state) {
  const easeShare = (MAX_EASE_FACTOR - state.easeFactor) / (MAX_EASE_FACTOR - MIN_EASE_FACTOR);
  return 1 + EASE_WEIGHT * easeShare + LAPSE_WEIGHT * Math.min(state.lapses, LAPSES_CAP);
}

function dueWeight(state, today) {
  const daysOverdue = Math.min(diffDays(today, state.dueDate), OVERDUE_DAYS_CAP);
  return (1 + OVERDUE_WEIGHT_PER_DAY * daysOverdue) * difficultyWeight(state);
}

function notYetDueWeight(state, today) {
  // Always > 0, so mastered flags can still fill a round; closer-to-due and
  // harder flags are favoured.
  return difficultyWeight(state) / (1 + diffDays(state.dueDate, today));
}

// Weighted sampling without replacement. `items` is `[{ code, weight }]`
// with every weight > 0.
function sampleWeighted(items, count, rng) {
  const pool = [...items];
  const picked = [];
  while (picked.length < count && pool.length > 0) {
    const total = pool.reduce((sum, item) => sum + item.weight, 0);
    let target = draw(rng) * total;
    let index = pool.length - 1;
    for (let i = 0; i < pool.length; i += 1) {
      target -= pool[i].weight;
      if (target < 0) {
        index = i;
        break;
      }
    }
    picked.push(pool[index].code);
    pool.splice(index, 1);
  }
  return picked;
}

function shuffle(items, rng) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(draw(rng) * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Split the flags in scope into never-seen, due and not-yet-due, validating
// each state entry it reads.
function classifyScope(states, countries, today, region) {
  const seen = new Set();
  const groups = { fresh: [], due: [], notYetDue: [] };
  for (const country of countries) {
    const inScope = region === undefined || region === null || country.region === region;
    if (!inScope || seen.has(country.code)) {
      continue;
    }
    seen.add(country.code);
    const state = Object.hasOwn(states, country.code) ? states[country.code] : undefined;
    const isNew = isNewCard(state);
    if (state !== undefined && state !== null && state.code !== country.code) {
      throw new TypeError(`\`states.${country.code}.code\` must match its key, got \`${state.code}\`.`);
    }
    if (isNew) {
      groups.fresh.push(country.code);
      continue;
    }
    const entry = { code: country.code, state };
    if (state.dueDate <= today) {
      groups.due.push(entry);
    } else {
      groups.notYetDue.push(entry);
    }
  }
  return groups;
}

/**
 * Pick the flags for one practice round.
 *
 * Candidates, in priority tiers:
 *   1. every due flag in scope (`dueDate <= today`), weighted by days overdue
 *      and difficulty (low ease, many lapses), plus up to `NEW_FLAG_LIMIT`
 *      randomly chosen never-seen flags at `NEW_FLAG_WEIGHT`;
 *   2. if tier 1 cannot fill the round, seen flags that are not yet due,
 *      with a small non-zero weight favouring harder and closer-to-due flags;
 *   3. if that still cannot fill it, further never-seen flags at random.
 * Each tier is a weighted random draw without replacement; the final round is
 * shuffled so the tiers are interleaved.
 *
 * Codes in `states` but not in `countries` are ignored; duplicate codes in
 * `countries` are counted once.
 *
 * @param {object} options
 * @param {Object<string, object>} options.states Card states keyed by code
 *   (sanitize untrusted data with `sanitizeStates` first).
 * @param {{ code: string, region: string }[]} options.countries All flags.
 * @param {string} options.today Local date, `YYYY-MM-DD`.
 * @param {string} [options.region] One of `REGIONS`; omit for all regions.
 * @param {() => number} options.rng Random source returning `[0, 1)`.
 * @param {number} [options.n=ROUND_SIZE] Round size.
 * @returns {string[]} Up to `n` distinct codes; fewer only if the scope has
 *   fewer than `n` flags.
 */
export function pickRound({ states, countries, today, region, rng, n = ROUND_SIZE } = {}) {
  assertStates(states);
  assertCountries(countries);
  assertDate(today, 'today');
  assertRegion(region);
  assertRng(rng);
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError('`n` must be a positive integer.');
  }

  const { fresh, due, notYetDue } = classifyScope(states, countries, today, region);

  const shuffledFresh = shuffle(fresh, rng);
  const trickle = shuffledFresh.slice(0, NEW_FLAG_LIMIT);
  const overflow = shuffledFresh.slice(NEW_FLAG_LIMIT);

  const tierOne = [
    ...due.map(({ code, state }) => ({ code, weight: dueWeight(state, today) })),
    ...trickle.map((code) => ({ code, weight: NEW_FLAG_WEIGHT }))
  ];
  const picked = sampleWeighted(tierOne, n, rng);

  const tierTwo = notYetDue.map(({ code, state }) => ({
    code,
    weight: notYetDueWeight(state, today)
  }));
  picked.push(...sampleWeighted(tierTwo, n - picked.length, rng));

  picked.push(...overflow.slice(0, n - picked.length));

  return shuffle(picked, rng);
}

/**
 * Count the flags waiting in a scope, for the home screen (spec #4).
 *
 * @param {object} options
 * @param {Object<string, object>} options.states Card states keyed by code.
 * @param {{ code: string, region: string }[]} options.countries All flags.
 * @param {string} options.today Local date, `YYYY-MM-DD`.
 * @param {string} [options.region] One of `REGIONS`; omit for all regions.
 * @returns {{ due: number, new: number }} `due`: seen flags with
 *   `dueDate <= today`. `new`: all never-seen flags in scope (not capped by
 *   `NEW_FLAG_LIMIT`).
 */
export function countDue({ states, countries, today, region } = {}) {
  assertStates(states);
  assertCountries(countries);
  assertDate(today, 'today');
  assertRegion(region);
  const { fresh, due } = classifyScope(states, countries, today, region);
  return { due: due.length, new: fresh.length };
}

// ---- Untrusted input ----

function sanitizeInteger(value, fallback, min) {
  return Number.isFinite(value) ? Math.max(min, Math.floor(value)) : fallback;
}

/**
 * Clean a parsed state map from untrusted storage (`localStorage`, a JSON
 * import) so it is safe to pass to the other functions.
 *
 * An entry is dropped if it is not an object, its key is not a valid code,
 * its `code` disagrees with its key, or its `dueDate` is neither `null` nor a
 * real `YYYY-MM-DD` date. Otherwise it is repaired: a missing `code` is taken
 * from the key, non-numeric fields fall back to fresh-state defaults, numbers
 * are floored to integers / clamped into range, a `null` `dueDate` resets the
 * entry to a fresh state, and unknown fields are dropped. When `today` is
 * given, a `dueDate` more than `MAX_INTERVAL_DAYS` ahead (which no answer can
 * produce) is pulled back to `today + MAX_INTERVAL_DAYS`, so a corrupt date
 * cannot park a flag forever.
 *
 * @param {unknown} raw Parsed JSON (any value).
 * @param {string} [today] Local date, `YYYY-MM-DD`; enables the far-future
 *   `dueDate` repair.
 * @returns {Object<string, object>} New, valid state map (empty if `raw` is
 *   not an object).
 */
export function sanitizeStates(raw, today) {
  if (today !== undefined) {
    assertDate(today, 'today');
  }
  const latestDueDate = today === undefined ? MAX_DATE : addDays(today, MAX_INTERVAL_DAYS);
  const result = {};
  if (!isPlainObject(raw)) {
    return result;
  }
  for (const [key, entry] of Object.entries(raw)) {
    if (!CODE_PATTERN.test(key) || !isPlainObject(entry)) {
      continue;
    }
    if (entry.code !== undefined && entry.code !== key) {
      continue;
    }
    if (entry.dueDate === null) {
      result[key] = createCardState(key);
      continue;
    }
    if (parseDate(entry.dueDate) === null) {
      continue;
    }
    const easeFactor = Number.isFinite(entry.easeFactor)
      ? roundEase(Math.min(MAX_EASE_FACTOR, Math.max(MIN_EASE_FACTOR, entry.easeFactor)))
      : INITIAL_EASE_FACTOR;
    result[key] = {
      code: key,
      repetitions: sanitizeInteger(entry.repetitions, 0, 0),
      easeFactor,
      intervalDays: Math.min(MAX_INTERVAL_DAYS, sanitizeInteger(entry.intervalDays, 1, 1)),
      dueDate: entry.dueDate > latestDueDate ? latestDueDate : entry.dueDate,
      lapses: sanitizeInteger(entry.lapses, 0, 0)
    };
  }
  return result;
}
