// Test view: STUB from spec #4, to be replaced by spec #6 (issue-6-test-mode).
// Receives `params: { region, mode }` from home. See the view contract in
// js/app.js.

import { MODE_LABELS, el, formatRegion } from '../ui.js';

let controller = null;

/**
 * Render the test view.
 *
 * @param {HTMLElement} container The view's section.
 * @param {{ navigate: Function, params: object }} context See `js/app.js`.
 * @returns {void}
 */
export function mount(container, context) {
  controller = new AbortController();
  const { navigate, params } = context;

  const backButton = el('button', { type: 'button', class: 'button button-secondary' }, ['Back']);
  backButton.addEventListener('click', () => navigate('home'), { signal: controller.signal });

  container.replaceChildren(
    el('h1', {}, ['Test']),
    el('p', { class: 'status' }, [`${formatRegion(params.region)} · ${MODE_LABELS[params.mode]}`]),
    backButton
  );
}

/**
 * Clean up the test view.
 *
 * @returns {void}
 */
export function unmount() {
  controller?.abort();
  controller = null;
}
