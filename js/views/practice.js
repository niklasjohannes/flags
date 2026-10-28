// Practice view: STUB from spec #4, to be replaced by spec #5 (issue-5-practice-flow).
// Receives `params: { region, mode }` from home. See the view contract in
// js/app.js. Shows one demo question so the shared question UI
// (js/question.js) can be checked; it saves nothing.

import { renderQuestion } from '../question.js';
import { MODE_LABELS, el, formatRegion } from '../ui.js';

let controller = null;

/**
 * Render the practice view.
 *
 * @param {HTMLElement} container The view's section.
 * @param {{ countries: object[], navigate: Function, params: object }} context
 *   See `js/app.js`.
 * @returns {void}
 */
export function mount(container, context) {
  controller = new AbortController();
  const { signal } = controller;
  const { countries, navigate, params } = context;

  const backButton = el('button', { type: 'button', class: 'button button-secondary' }, ['Back']);
  backButton.addEventListener('click', () => navigate('home'), { signal });

  const scope = countries.filter((country) => params.region === null || country.region === params.region);
  const code = scope[Math.floor(Math.random() * scope.length)].code;
  const questionArea = el('div', { class: 'practice-question' });
  const status = el('p', { class: 'status' }, ['Demo question: nothing is saved.']);

  container.replaceChildren(
    el('h1', {}, ['Practice']),
    el('p', { class: 'status' }, [`${formatRegion(params.region)} · ${MODE_LABELS[params.mode]}`]),
    questionArea,
    status,
    backButton
  );

  const question = renderQuestion(questionArea, {
    code,
    mode: params.mode,
    countries,
    rng: Math.random,
    signal,
    onAnswer: (chosenCode) => {
      question.reveal();
      status.textContent = chosenCode === code ? 'Correct.' : 'Not quite.';
    }
  });
}

/**
 * Clean up the practice view.
 *
 * @returns {void}
 */
export function unmount() {
  controller?.abort();
  controller = null;
}
