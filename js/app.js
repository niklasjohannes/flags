// App entry point: loads the country data once, then shows one view at a
// time (home / practice / test / results). No URL routing: every page load
// starts on home, which is what resets the continent filter to "All".
//
// ---- View contract ----
//
// Each view is a module in `js/views/` exporting:
//
//   mount(container, context)  Render into `container` (the view's own
//                              `<section id="view-<name>">`, empty and
//                              visible). Called on every visit.
//   unmount()                  Undo anything outside the container: timers,
//                              listeners on `window`/`document`, pending work.
//                              The router then empties the container, so
//                              listeners on nodes inside it need no cleanup.
//                              An `AbortController` created in `mount` and
//                              aborted here is the easy way (see the stubs).
//
// `context` is frozen:
//
//   countries  The `countries` array of `data/countries.json` (frozen).
//   navigate   `(name, params?) => void`: unmount this view and mount view
//              `name` ('home' | 'practice' | 'test' | 'results') with
//              `params`.
//   params     What the caller passed to `navigate` (frozen; `{}` if none).
//              Home sends practice and test `{ region, mode }`: `region` is
//              one of `REGIONS` (js/srs.js) or `null` for All; `mode` is one
//              of `QUIZ_MODES` (js/storage.js).
//
// Ownership, so spec #5 and #6 can be built in parallel without touching the
// same files:
//
//   js/views/home.js      css/style.css     spec #4 (home, base styles)
//   js/views/practice.js  css/practice.css  spec #5 (practice rounds, incl.
//                                           the round-end summary)
//   js/views/test.js      css/test.css      spec #6 (test pass)
//   js/views/results.js   css/test.css      spec #6 (test results screen)
//
// Shared modules: `js/storage.js` (localStorage, `localToday`) and `js/ui.js`
// (DOM helpers, `renderFlag`, labels). Scope view CSS under `.view-<name>`.

import * as home from './views/home.js';
import * as practice from './views/practice.js';
import * as test from './views/test.js';
import * as results from './views/results.js';
import { el } from './ui.js';

const DATA_URL = './data/countries.json';

const VIEWS = Object.freeze({ home, practice, test, results });

let countries = null;
let current = null;

function deepFreeze(value) {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

async function loadCountries() {
  const response = await fetch(DATA_URL);
  if (!response.ok) {
    throw new Error(`Fetching ${DATA_URL} failed with HTTP ${response.status}.`);
  }
  const data = await response.json();
  if (typeof data !== 'object' || data === null || !Array.isArray(data.countries) || data.countries.length === 0) {
    throw new Error(`${DATA_URL} has no \`countries\` array.`);
  }
  return deepFreeze(data.countries);
}

function getContainer(name) {
  const container = document.getElementById(`view-${name}`);
  if (container === null) {
    throw new Error(`\`index.html\` has no \`#view-${name}\` section.`);
  }
  return container;
}

/**
 * Show view `name`, unmounting the current one.
 *
 * @param {string} name One of the keys of `VIEWS`.
 * @param {object} [params={}] Passed to the view as `context.params`.
 * @returns {void}
 */
function navigate(name, params = {}) {
  if (!Object.hasOwn(VIEWS, name)) {
    throw new RangeError(`\`name\` must be one of ${Object.keys(VIEWS).join(', ')}.`);
  }
  if (typeof params !== 'object' || params === null) {
    throw new TypeError('`params` must be an object.');
  }
  const previous = current;
  if (previous !== null) {
    try {
      previous.view.unmount();
    } finally {
      previous.container.replaceChildren();
      previous.container.hidden = true;
    }
  }
  const container = getContainer(name);
  current = { view: VIEWS[name], container };
  container.hidden = false;
  window.scrollTo(0, 0);
  VIEWS[name].mount(container, Object.freeze({
    countries,
    navigate,
    params: Object.freeze({ ...params })
  }));
  // Move focus into the new view (not on first load), so keyboard and screen
  // reader users are not left on a button that no longer exists.
  if (previous !== null && !container.contains(document.activeElement)) {
    container.focus({ preventScroll: true });
  }
}

function showLoadError(error) {
  console.error(error);
  getContainer('home').replaceChildren(
    el('h1', {}, ['Flags']),
    el('p', { class: 'status' }, ['Could not load the flag data. Check your connection and reload.'])
  );
}

async function start() {
  try {
    countries = await loadCountries();
  } catch (error) {
    showLoadError(error);
    return;
  }
  navigate('home');
}

start();
