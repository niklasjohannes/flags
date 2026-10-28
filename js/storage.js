// Persistence: the only module that touches `localStorage`.
//
// Every read and write is wrapped in try/catch. `localStorage` can be
// missing, can throw on access (storage blocked by the browser) and can throw
// on write (quota exceeded, old Safari private mode). A failure degrades to
// "nothing stored" and never crashes the app; only programmer errors (bad
// arguments) throw.
//
// Every function takes an optional `storage` argument: anything with
// `getItem(key)` and `setItem(key, value)`, so tests can inject a fake. Omit
// it to use `globalThis.localStorage`; pass `null` for "no storage".
//
// Keys. Bump the version suffix on an incompatible format change.
//   - `SRS_STORAGE_KEY`: JSON object of SRS card states keyed by country code
//     (shape in `js/srs.js`). Always run through `sanitizeStates` on load.
//   - `MODE_STORAGE_KEY`: the quiz mode, a per-device preference.
// The continent filter is deliberately never stored (PLAN decision 2).

import { sanitizeStates } from './srs.js';

/** `localStorage` key of the SRS card-state map. */
export const SRS_STORAGE_KEY = 'flags.srs.v1';

/** `localStorage` key of the quiz-mode preference. */
export const MODE_STORAGE_KEY = 'flags.mode.v1';

/** Quiz modes: multiple choice and typing (autosuggest). */
export const QUIZ_MODES = Object.freeze(['mc', 'typing']);

/** Mode used when nothing valid is stored. */
export const DEFAULT_MODE = 'mc';

// ---- Helpers ----

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Reading `globalThis.localStorage` itself can throw (SecurityError when the
// browser blocks site data), so the lookup is guarded too.
function getDefaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function resolveStorage(storage) {
  if (storage === undefined) {
    return getDefaultStorage();
  }
  if (storage === null) {
    return null;
  }
  const isStorageLike = typeof storage === 'object' &&
    typeof storage.getItem === 'function' &&
    typeof storage.setItem === 'function';
  if (!isStorageLike) {
    throw new TypeError('`storage` must be an object with `getItem` and `setItem` methods, or `null`.');
  }
  return storage;
}

function readItem(storage, key) {
  if (storage === null) {
    return null;
  }
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeItem(storage, key, value) {
  if (storage === null) {
    return false;
  }
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

// ---- Dates ----

/**
 * Today's date on the device clock, in local time.
 *
 * @param {Date} [now=new Date()] The moment to format.
 * @returns {string} Local calendar date, `YYYY-MM-DD`.
 */
export function localToday(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('`now` must be a valid `Date`.');
  }
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ---- SRS state ----

/**
 * Load the SRS card states.
 *
 * Missing, unreadable or corrupt data gives an empty map (every flag is new).
 *
 * @param {string} today Local date, `YYYY-MM-DD` (see `localToday`); passed
 *   to `sanitizeStates` to repair far-future due dates.
 * @param {Storage | null} [storage] Storage to read; defaults to
 *   `globalThis.localStorage`.
 * @returns {Object<string, object>} Sanitized card states keyed by code.
 */
export function loadStates(today, storage) {
  const target = resolveStorage(storage);
  // Validates `today` before anything is read, so a bad argument still throws.
  sanitizeStates({}, today);
  const text = readItem(target, SRS_STORAGE_KEY);
  if (text === null) {
    return {};
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  return sanitizeStates(raw, today);
}

/**
 * Save the SRS card states, replacing what is stored.
 *
 * @param {Object<string, object>} states Card states keyed by code.
 * @param {Storage | null} [storage] Storage to write; defaults to
 *   `globalThis.localStorage`.
 * @returns {boolean} `true` if saved; `false` if storage is unavailable or
 *   the write failed (e.g. quota exceeded).
 */
export function saveStates(states, storage) {
  if (!isPlainObject(states)) {
    throw new TypeError('`states` must be an object mapping country codes to card states.');
  }
  const target = resolveStorage(storage);
  let text;
  try {
    text = JSON.stringify(states);
  } catch {
    return false;
  }
  return writeItem(target, SRS_STORAGE_KEY, text);
}

// ---- Mode preference ----

/**
 * Load the quiz-mode preference.
 *
 * @param {Storage | null} [storage] Storage to read; defaults to
 *   `globalThis.localStorage`.
 * @returns {string} One of `QUIZ_MODES`; `DEFAULT_MODE` if nothing valid is
 *   stored.
 */
export function loadMode(storage) {
  const value = readItem(resolveStorage(storage), MODE_STORAGE_KEY);
  return QUIZ_MODES.includes(value) ? value : DEFAULT_MODE;
}

/**
 * Save the quiz-mode preference.
 *
 * @param {string} mode One of `QUIZ_MODES`.
 * @param {Storage | null} [storage] Storage to write; defaults to
 *   `globalThis.localStorage`.
 * @returns {boolean} `true` if saved; `false` if storage is unavailable or
 *   the write failed.
 */
export function saveMode(mode, storage) {
  if (!QUIZ_MODES.includes(mode)) {
    throw new RangeError(`\`mode\` must be one of ${QUIZ_MODES.join(', ')}.`);
  }
  return writeItem(resolveStorage(storage), MODE_STORAGE_KEY, mode);
}
