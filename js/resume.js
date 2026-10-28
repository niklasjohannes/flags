// Time away from the app, tracked for the whole page load (GitHub #33).
//
// PLAN decision 2: the continent filter resets to "All" on every open. iOS
// resumes an installed app from the background without reloading, so home
// treats a return after `RESUME_RESET_MS`, or on a new local date, as a fresh
// open. The app can be hidden on any screen (mid-round, mid-test, results),
// so the background time is recorded here, from app start, and home applies
// the rule both on a resume while it is showing and on its next mount.
//
// `isStaleResume` is the pure rule; the rest is the page-load tracker that
// js/app.js starts with `watchResume()` and js/views/home.js reads with
// `takeStaleResume(today)`.

import { localToday } from './storage.js';

/**
 * Time away from the app (ms) after which coming back to home counts as a
 * fresh open. A change of local date always does.
 */
export const RESUME_RESET_MS = 30 * 60_000;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether coming back to the app counts as a fresh open.
 *
 * @param {object} options
 * @param {number} options.hiddenAt When the app was hidden (ms since epoch).
 * @param {number} options.resumedAt When it became visible again (ms).
 * @param {string} options.shownOn Local date (`YYYY-MM-DD`) home was last
 *   shown on.
 * @param {string} options.resumedOn Local date (`YYYY-MM-DD`) of the resume.
 * @returns {boolean} `true` if the user was away for at least
 *   `RESUME_RESET_MS`, or the local date is no longer the one home was shown
 *   on.
 */
export function isStaleResume({ hiddenAt, resumedAt, shownOn, resumedOn } = {}) {
  if (!Number.isFinite(hiddenAt) || !Number.isFinite(resumedAt)) {
    throw new TypeError('`hiddenAt` and `resumedAt` must be finite numbers.');
  }
  for (const [name, value] of [['shownOn', shownOn], ['resumedOn', resumedOn]]) {
    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
      throw new TypeError(`\`${name}\` must be a \`YYYY-MM-DD\` date string.`);
    }
  }
  return resumedOn !== shownOn || resumedAt - hiddenAt >= RESUME_RESET_MS;
}

// Page-load state: when the app went to the background (null while
// visible), the date home was last shown on (null before its first mount),
// and whether a stale resume happened since then.
let hiddenAt = null;
let shownOn = null;
let hasStaleResume = false;
let isWatching = false;

function noteHidden() {
  hiddenAt ??= Date.now();
}

function noteVisible() {
  if (hiddenAt === null) {
    return;
  }
  if (shownOn !== null && isStaleResume({ hiddenAt, resumedAt: Date.now(), shownOn, resumedOn: localToday() })) {
    hasStaleResume = true;
  }
  hiddenAt = null;
}

/**
 * Start recording time in the background, whatever screen is showing. Call
 * once at app start, before the first view mounts, so these listeners run
 * before any view's own. Later calls do nothing.
 *
 * @returns {void}
 */
export function watchResume() {
  if (isWatching) {
    return;
  }
  isWatching = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      noteHidden();
    } else {
      noteVisible();
    }
  });
  window.addEventListener('pagehide', noteHidden);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      noteVisible();
    }
  });
}

/**
 * Whether the app came back from a stale resume (see `isStaleResume`) since
 * the last call, i.e. since home was last shown. Clears the flag and records
 * `today` as the date home is shown on.
 *
 * @param {string} today Local date, `YYYY-MM-DD`, home is being shown on.
 * @returns {boolean}
 */
export function takeStaleResume(today) {
  if (typeof today !== 'string' || !DATE_PATTERN.test(today)) {
    throw new TypeError('`today` must be a `YYYY-MM-DD` date string.');
  }
  const wasStale = hasStaleResume;
  hasStaleResume = false;
  shownOn = today;
  return wasStale;
}
