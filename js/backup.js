// Backup file format (spec #8, SPEC finding 6): the SRS progress as a JSON
// file, so it survives the browser clearing site data. Pure: no DOM, no
// storage, no clock (the caller passes `now` / `today`). The sheet that uses
// it is js/backup-sheet.js.
//
// Format, version 1:
//
//   { "app": "flags", "version": 1, "exportedAt": "<ISO 8601>",
//     "states": { "<code>": <card state, js/srs.js>, ... } }
//
// Import treats the file as untrusted: the envelope is checked, then
// `states` goes through `sanitizeStates`, the same cleaning as anything read
// from `localStorage`, and only entries for the dataset's codes are kept.

import { sanitizeStates } from './srs.js';

/** `app` field of every backup. */
export const BACKUP_APP = 'flags';

/** Current format version; bump on an incompatible change. */
export const BACKUP_VERSION = 1;

/**
 * Largest backup accepted, in characters. A full backup of every flag is
 * about 25 kB; anything this big is not one.
 */
export const MAX_BACKUP_LENGTH = 1_000_000;

/** User-facing reasons a file is refused (`parseBackup`'s `error`). */
export const BACKUP_ERRORS = Object.freeze({
  tooLarge: 'This file is too large to be a Flags backup.',
  notJson: 'This file is not a Flags backup (it is not valid JSON).',
  notBackup: 'This file is not a Flags backup.',
  newerVersion: 'This backup was made by a newer version of Flags. Update the app and try again.',
  noValidEntries: 'This backup is damaged: none of its progress could be read.'
});

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Serialize card states as a backup file.
 *
 * @param {Object<string, object>} states Card states keyed by code (as from
 *   `loadStates`).
 * @param {Date} now Export time, recorded as `exportedAt`.
 * @returns {string} The file's text (pretty-printed JSON, trailing newline).
 */
export function serializeBackup(states, now) {
  if (!isPlainObject(states)) {
    throw new TypeError('`states` must be an object mapping country codes to card states.');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('`now` must be a valid `Date`.');
  }
  const backup = {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    states
  };
  return `${JSON.stringify(backup, null, 2)}\n`;
}

/**
 * Parse and validate a backup file.
 *
 * Never throws for a bad file: it returns `{ ok: false, error }` with a
 * message from `BACKUP_ERRORS` to show the user. Only bad arguments throw.
 *
 * Only entries for `knownCodes` are kept. Any other key (a code removed from
 * the data, an upper-cased `FR`, a typo) counts as dropped, like an
 * unreadable entry: restoring it would report progress that no flag uses.
 *
 * @param {string} text The file's text.
 * @param {string} today Local date, `YYYY-MM-DD`, for `sanitizeStates`.
 * @param {ReadonlySet<string> | string[]} knownCodes The dataset's codes
 *   (`countries.map((country) => country.code)`).
 * @returns {{ ok: true, states: Object<string, object>, count: number,
 *   dropped: number, exportedAt: string | null } | { ok: false, error: string }}
 *   On success: the sanitized states, how many entries they hold, how many
 *   entries of the file were unreadable or not for a known flag and dropped,
 *   and `exportedAt` if it is a valid date string.
 */
export function parseBackup(text, today, knownCodes) {
  if (typeof text !== 'string') {
    throw new TypeError('`text` must be a string.');
  }
  if (typeof today !== 'string' || !DATE_PATTERN.test(today)) {
    throw new TypeError('`today` must be a `YYYY-MM-DD` date string.');
  }
  const isCodeList = (knownCodes instanceof Set || Array.isArray(knownCodes)) &&
    [...knownCodes].every((code) => typeof code === 'string');
  if (!isCodeList) {
    throw new TypeError('`knownCodes` must be a `Set` or an array of country codes.');
  }
  const known = new Set(knownCodes);
  if (text.length > MAX_BACKUP_LENGTH) {
    return { ok: false, error: BACKUP_ERRORS.tooLarge };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: BACKUP_ERRORS.notJson };
  }
  if (!isPlainObject(raw) || raw.app !== BACKUP_APP || !Number.isInteger(raw.version) ||
    raw.version < 1 || !isPlainObject(raw.states)) {
    return { ok: false, error: BACKUP_ERRORS.notBackup };
  }
  if (raw.version > BACKUP_VERSION) {
    return { ok: false, error: BACKUP_ERRORS.newerVersion };
  }
  const states = Object.fromEntries(
    Object.entries(sanitizeStates(raw.states, today)).filter(([code]) => known.has(code))
  );
  const total = Object.keys(raw.states).length;
  const count = Object.keys(states).length;
  // An empty backup is valid (progress that was reset); one whose every
  // entry was unreadable is not.
  if (total > 0 && count === 0) {
    return { ok: false, error: BACKUP_ERRORS.noValidEntries };
  }
  const exportedAt = typeof raw.exportedAt === 'string' && !Number.isNaN(Date.parse(raw.exportedAt))
    ? raw.exportedAt
    : null;
  return { ok: true, states, count, dropped: total - count, exportedAt };
}

/**
 * File name for a backup made on `today`.
 *
 * @param {string} today Local date, `YYYY-MM-DD`.
 * @returns {string} e.g. `'flags-backup-2026-10-28.json'`.
 */
export function getBackupFilename(today) {
  if (typeof today !== 'string' || !DATE_PATTERN.test(today)) {
    throw new TypeError('`today` must be a `YYYY-MM-DD` date string.');
  }
  return `flags-backup-${today}.json`;
}
