// Results view: STUB from spec #4, to be replaced by spec #6
// (issue-6-test-mode). Shows a finished test pass; its `params` are whatever
// the test view passes to `navigate('results', ...)`. See the view contract
// in js/app.js.

import { el } from '../ui.js';

let controller = null;

/**
 * Render the results view.
 *
 * @param {HTMLElement} container The view's section.
 * @param {{ navigate: Function, params: object }} context See `js/app.js`.
 * @returns {void}
 */
export function mount(container, context) {
  controller = new AbortController();
  const { navigate } = context;

  const backButton = el('button', { type: 'button', class: 'button button-secondary' }, ['Back']);
  backButton.addEventListener('click', () => navigate('home'), { signal: controller.signal });

  container.replaceChildren(
    el('h1', {}, ['Results']),
    el('p', { class: 'status' }, ['Not built yet.']),
    backButton
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
