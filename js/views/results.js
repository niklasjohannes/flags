// Results view (spec #6, PLAN decision 4): the score of a finished test pass
// and the flags that were missed. Retake starts the same scope again with a
// fresh shuffle; Done goes home. Like the test view, it never touches SRS
// state.
//
// `params`: `{ mode, pass }` from the test view, `pass` complete (see
// js/test-pass.js). See the view contract in js/app.js.

import { formatScore, scorePass } from '../test-pass.js';
import { MODE_LABELS, el, formatRegion, renderFlag } from '../ui.js';

let controller = null;

function renderMiss(miss) {
  // Post-test, so the flag's `alt` may name the country.
  const flag = renderFlag(el('img', {
    class: 'results-flag',
    width: 64,
    height: 48,
    loading: 'lazy',
    decoding: 'async'
  }), miss.code, { revealedName: miss.name });
  return el('li', { class: 'results-miss' }, [
    flag,
    el('div', { class: 'results-miss-text' }, [
      el('strong', { class: 'results-miss-name' }, [miss.name]),
      el('span', { class: 'results-miss-answer' }, [`You answered ${miss.chosenName}`])
    ])
  ]);
}

/**
 * Render the results view.
 *
 * @param {HTMLElement} container The view's section.
 * @param {{ countries: object[], navigate: Function, params: object }} context
 *   See `js/app.js`. `params.pass` is a complete pass from the test view and
 *   `params.mode` its quiz mode.
 * @returns {void}
 */
export function mount(container, context) {
  const { countries, navigate, params } = context;
  const { mode, pass } = params;
  if (!Object.hasOwn(MODE_LABELS, mode)) {
    throw new RangeError(`\`params.mode\` must be one of ${Object.keys(MODE_LABELS).join(', ')}.`);
  }
  // Throws on a missing or incomplete pass; the router then shows its error.
  const score = scorePass(pass, countries);
  controller = new AbortController();
  const { signal } = controller;

  const retakeButton = el('button', { type: 'button', class: 'button button-primary' }, ['Retake']);
  const doneButton = el('button', { type: 'button', class: 'button button-secondary' }, ['Done']);
  retakeButton.addEventListener('click', () => {
    navigate('test', { region: pass.region, mode, autostart: true });
  }, { signal });
  doneButton.addEventListener('click', () => navigate('home'), { signal });

  const missedSection = score.missed.length === 0
    ? el('p', { class: 'results-none' }, ['No misses.'])
    : el('section', { class: 'results-missed', 'aria-labelledby': 'results-missed-title' }, [
      el('h2', { id: 'results-missed-title', class: 'results-missed-title' }, [`Missed (${score.missed.length})`]),
      el('ul', { class: 'results-list' }, score.missed.map(renderMiss))
    ]);

  container.replaceChildren(
    el('h1', {}, ['Results']),
    el('p', { class: 'results-scope' }, [`${formatRegion(pass.region)} · ${MODE_LABELS[mode]}`]),
    el('p', { class: 'results-score' }, [formatScore(score)]),
    missedSection,
    el('div', { class: 'results-actions' }, [retakeButton, doneButton])
  );
}

/**
 * Clean up the results view.
 *
 * @returns {void}
 */
export function unmount() {
  controller?.abort();
  controller = null;
}
