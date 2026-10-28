// Practice view: STUB from spec #4, to be replaced by spec #5 (issue-5-practice-flow).
// Receives `params: { region, mode }` from home. See the view contract in
// js/app.js.

import { MODE_LABELS, el, formatRegion } from '../ui.js';

let controller = null;

/**
 * Render the practice view.
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
    el('h1', {}, ['Practice']),
    el('p', { class: 'status' }, [`${formatRegion(params.region)} · ${MODE_LABELS[params.mode]}`]),
    backButton
  );
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
