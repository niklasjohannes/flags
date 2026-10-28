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
//
// Cleanup pattern (see the stubs): create an `AbortController` in `mount`,
// pass its `signal` to every `addEventListener` and to `renderQuestion`, and
// call `abort()` in `unmount`. Timers must be cleared the same way, or a
// timer started in one round fires after the user has left the view:
//
//   const timer = setTimeout(advance, 600);
//   signal.addEventListener('abort', () => clearTimeout(timer));
//
// `context` is frozen:
//
//   countries  The `countries` array of `data/countries.json` (frozen).
//   navigate   `(name, params?) => void`: unmount this view and mount view
//              `name` ('home' | 'practice' | 'test' | 'results') with
//              `params`. Called during another view's `mount` or `unmount`,
//              it is deferred (microtask) until that transition finishes.
//   params     What the caller passed to `navigate` (frozen; `{}` if none).
//              Home sends practice and test `{ region, mode }`: `region` is
//              one of `REGIONS` (js/srs.js) or `null` for All; `mode` is one
//              of `QUIZ_MODES` (js/storage.js).
//
// If `mount` throws, the view shows an error with a Reload button.
//
// ---- Shared question UI (js/question.js) ----
//
//   const question = renderQuestion(container, {
//     code, mode, countries, rng, signal, onAnswer
//   });
//
// Renders the flag plus 4 multiple-choice buttons ('mc') or a text input
// with tap-to-answer suggestions ('typing'; Enter never submits). Calls
// `onAnswer(chosenCode)` exactly once, then locks. It shows no right/wrong
// feedback itself. The returned handle has `reveal()` (marks `.is-correct` /
// `.is-wrong`, shows the name, sets the flag's `alt` to it), `focus()` and
// `chosenCode`. Practice (#5) calls `reveal()`; test mode (#6) never does.
//
// ---- Ownership ----
//
// So spec #5 and #6 can be built in parallel without touching the same
// files:
//
//   js/views/home.js      css/style.css     spec #4 (home, base styles)
//   js/views/practice.js  css/practice.css  spec #5 (practice rounds, incl.
//                                           the round-end summary)
//   js/views/test.js      css/test.css      spec #6 (test pass)
//   js/views/results.js   css/test.css      spec #6 (test results screen)
//
// Shared modules, owned by spec #4 (coordinate changes through the
// orchestrator): `js/question.js` + `css/question.css` (question UI),
// `js/storage.js` (localStorage, `localToday`) and `js/ui.js` (DOM helpers,
// `renderFlag`, labels). Scope view CSS under `.view-<name>`.

import * as home from './views/home.js';
import * as practice from './views/practice.js';
import * as test from './views/test.js';
import * as results from './views/results.js';
import { el } from './ui.js';

const DATA_URL = './data/countries.json';

const VIEWS = Object.freeze({ home, practice, test, results });

let countries = null;
let current = null;
let isTransitioning = false;

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

function showError(container, message, error) {
  console.error(error);
  const reloadButton = el('button', { type: 'button', class: 'button button-primary' }, ['Reload']);
  reloadButton.addEventListener('click', () => location.reload());
  container.replaceChildren(
    el('h1', {}, ['Something went wrong']),
    el('p', { class: 'status' }, [message]),
    reloadButton
  );
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
  // A view navigating from inside its own mount/unmount would interleave two
  // transitions; run it once this one has finished instead.
  if (isTransitioning) {
    queueMicrotask(() => navigate(name, params));
    return;
  }
  isTransitioning = true;
  try {
    transition(name, params);
  } finally {
    isTransitioning = false;
  }
}

function transition(name, params) {
  const previous = current;
  if (previous !== null) {
    try {
      previous.view.unmount();
    } catch (error) {
      console.error(error);
    }
    previous.container.replaceChildren();
    previous.container.hidden = true;
  }
  const container = getContainer(name);
  current = { view: VIEWS[name], container };
  container.hidden = false;
  window.scrollTo(0, 0);
  try {
    VIEWS[name].mount(container, Object.freeze({
      countries,
      navigate,
      params: Object.freeze({ ...params })
    }));
  } catch (error) {
    showError(container, 'This screen failed to load. Reload to start again.', error);
  }
  // Move focus into the new view (not on first load), so keyboard and screen
  // reader users are not left on a button that no longer exists.
  if (previous !== null && !container.contains(document.activeElement)) {
    container.focus({ preventScroll: true });
  }
}

async function start() {
  try {
    countries = await loadCountries();
  } catch (error) {
    showError(getContainer('home'), 'Could not load the flag data. Check your connection and reload.', error);
    return;
  }
  navigate('home');
}

start();
