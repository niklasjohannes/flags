// When the page reloads after a new service worker took over (spec #8). Pure:
// js/app.js feeds it events and does the reload; test/update-reload.test.js
// covers the rules.
//
// `sw.js` calls `skipWaiting()`, so a new deploy takes over an open page at
// once (`controllerchange`). The page's JS is then the old version, so it
// reloads, but only where nothing is lost:
//   - the first `controllerchange` on a page that had no worker (first
//     visit) is not an update: no reload;
//   - after an update, reload at once only on home with no sheet
//     (`<dialog>`) open;
//   - otherwise wait: retry when a sheet closes, and reload instead of the
//     next navigation to home (so a round or test is never interrupted);
//   - reload at most once.

/** Events `decideReload` understands. */
export const RELOAD_EVENTS = Object.freeze(['controllerchange', 'dialogclose', 'navigatehome']);

/**
 * Initial state.
 *
 * @param {boolean} hadController Whether the page was already controlled by
 *   a service worker when it loaded (`navigator.serviceWorker.controller`).
 * @returns {{ hadController: boolean, isPending: boolean, isReloading: boolean }}
 *   Frozen.
 */
export function createReloadState(hadController) {
  if (typeof hadController !== 'boolean') {
    throw new TypeError('`hadController` must be a boolean.');
  }
  return Object.freeze({ hadController, isPending: false, isReloading: false });
}

/**
 * Apply one event.
 *
 * @param {{ hadController: boolean, isPending: boolean, isReloading: boolean }}
 *   state From `createReloadState` or a previous call.
 * @param {string} event One of `RELOAD_EVENTS`: a new worker took over, a
 *   `<dialog>` closed, or something is about to navigate to home.
 * @param {{ isOnHome: boolean, hasOpenDialog: boolean }} view What is on
 *   screen now. Ignored for `'navigatehome'`.
 * @returns {{ state: object, reload: boolean }} The next state (frozen), and
 *   whether to reload now. `reload` is `true` at most once per state chain.
 *   After `'navigatehome'`, skip the navigation if `state.isReloading`.
 */
export function decideReload(state, event, view) {
  if (typeof state !== 'object' || state === null ||
    !['hadController', 'isPending', 'isReloading'].every((key) => typeof state[key] === 'boolean')) {
    throw new TypeError('`state` must come from `createReloadState` or `decideReload`.');
  }
  if (!RELOAD_EVENTS.includes(event)) {
    throw new RangeError(`\`event\` must be one of ${RELOAD_EVENTS.join(', ')}.`);
  }
  if (typeof view !== 'object' || view === null ||
    typeof view.isOnHome !== 'boolean' || typeof view.hasOpenDialog !== 'boolean') {
    throw new TypeError('`view` must be `{ isOnHome: boolean, hasOpenDialog: boolean }`.');
  }

  let next = state;
  if (event === 'controllerchange') {
    next = state.hadController
      ? { ...state, isPending: true }
      : { ...state, hadController: true };
  }
  const isSafe = event === 'navigatehome' || (view.isOnHome && !view.hasOpenDialog);
  const reload = next.isPending && !next.isReloading && isSafe;
  if (reload) {
    next = { ...next, isReloading: true };
  }
  return { state: Object.freeze({ ...next }), reload };
}
