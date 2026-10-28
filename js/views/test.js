// Test view (spec #6, PLAN decision 4): pick a scope, then answer every flag
// in it once, blind. No per-question feedback: the question is never
// revealed, there is no score on screen, only a position counter. The last
// answer goes to the results view. Test mode never reads or writes SRS state,
// and a pass in progress is kept only in memory, so a reload discards it
// (test/test-mode-isolation.test.js guards this).
//
// `params`: `{ region, mode }` from home (see the view contract in
// js/app.js); results' Retake adds `autostart: true` to skip the picker.
//
// Exit asks first, in an in-app sheet (a modal `<dialog>`: focus stays inside
// it, Escape or Cancel closes it), never `window.confirm`: a browser that
// was told to block further dialogs answers `false` forever, and the native
// dialog is titled with the page's origin.

import { renderQuestion } from '../question.js';
import { REGIONS } from '../srs.js';
import { createTestPass, getScopeCodes, isPassComplete, recordAnswer } from '../test-pass.js';
import { ALL_REGIONS_LABEL, MODE_LABELS, REGION_LABELS, createChoiceGroup, el } from '../ui.js';

// Radio value of "All"; maps to `region: null` everywhere else.
const ALL_VALUE = 'all';

const EXIT_TITLE = 'Leave this test?';
const EXIT_MESSAGE = 'Your answers so far will not be kept.';

/**
 * Time (ms) after a question appears during which clicks on it are ignored.
 * The next question's options land where the last tap was, so without it a
 * double tap would answer a flag the user never saw. The window is the same
 * whatever the previous answer was, so it gives nothing away.
 */
export const ANSWER_GUARD_MS = 300;

let controller = null;

/**
 * Render the test view: the scope picker, then the blind pass.
 *
 * @param {HTMLElement} container The view's section.
 * @param {{ countries: object[], navigate: Function, params: object }} context
 *   See `js/app.js`. `params.region` is one of `REGIONS` or `null`;
 *   `params.mode` is a key of `MODE_LABELS`; `params.autostart` skips the
 *   picker.
 * @returns {void}
 */
export function mount(container, context) {
  const { countries, navigate, params } = context;
  const region = params.region ?? null;
  const { mode } = params;
  if (region !== null && !REGIONS.includes(region)) {
    throw new RangeError(`\`params.region\` must be one of ${REGIONS.join(', ')}, or \`null\`.`);
  }
  if (!Object.hasOwn(MODE_LABELS, mode)) {
    throw new RangeError(`\`params.mode\` must be one of ${Object.keys(MODE_LABELS).join(', ')}.`);
  }
  controller = new AbortController();
  const { signal } = controller;

  if (params.autostart === true) {
    startPass(container, { countries, navigate, region, mode, signal });
  } else {
    showPicker(container, { countries, navigate, region, mode, signal });
  }
}

function showPicker(container, { countries, navigate, region, mode, signal }) {
  let selectedRegion = region;
  const withCount = (label, scope) => `${label} (${getScopeCodes({ countries, region: scope }).length})`;
  const scopeGroup = createChoiceGroup({
    name: 'test-scope',
    legend: 'Scope',
    choices: [
      { value: ALL_VALUE, label: withCount(ALL_REGIONS_LABEL, null) },
      ...REGIONS.map((scope) => ({ value: scope, label: withCount(REGION_LABELS[scope], scope) }))
    ],
    selected: selectedRegion ?? ALL_VALUE,
    signal,
    onChange: (value) => {
      selectedRegion = value === ALL_VALUE ? null : value;
    }
  });

  const startButton = el('button', { type: 'button', class: 'button button-primary' }, ['Start test']);
  const backButton = el('button', { type: 'button', class: 'button button-secondary' }, ['Back']);
  startButton.addEventListener('click', () => {
    startPass(container, { countries, navigate, region: selectedRegion, mode, signal });
  }, { signal });
  backButton.addEventListener('click', () => navigate('home'), { signal });

  container.replaceChildren(
    el('h1', {}, ['Test']),
    el('p', { class: 'test-intro' }, ['Every flag in the scope once, in random order. No feedback until the end.']),
    scopeGroup,
    el('p', { class: 'test-mode' }, [
      el('span', { class: 'test-mode-label' }, ['Mode']),
      ' ',
      el('span', {}, [MODE_LABELS[mode]])
    ]),
    el('div', { class: 'view-actions test-actions' }, [startButton, backButton])
  );
}

// The "leave this test?" sheet. `open()` shows it modally; Leave closes it
// and calls `onLeave`; Cancel, Escape or a tap on the backdrop just close it
// and focus again whatever had focus when it opened (usually Exit itself;
// the input, when Exit was tapped on iOS while typing), if still on screen.
function createExitSheet({ onLeave, signal }) {
  const leaveButton = el('button', { type: 'button', class: 'button button-primary', 'data-action': 'leave' }, ['Leave test']);
  const cancelButton = el('button', {
    type: 'button',
    class: 'button button-secondary',
    'data-action': 'cancel',
    autofocus: true
  }, ['Cancel']);
  const dialog = el('dialog', {
    class: 'sheet test-exit-sheet',
    'aria-labelledby': 'test-exit-title',
    'aria-describedby': 'test-exit-text'
  }, [
    el('div', { class: 'sheet-body' }, [
      el('h2', { id: 'test-exit-title', class: 'sheet-title' }, [EXIT_TITLE]),
      el('p', { id: 'test-exit-text', class: 'sheet-text' }, [EXIT_MESSAGE]),
      el('div', { class: 'sheet-actions' }, [leaveButton, cancelButton])
    ])
  ]);

  let returnFocusTo = null;
  // Run from the Cancel / backdrop tap itself: if the input had focus, it is
  // refocused inside the tap, the only place iOS lets `focus()` bring the
  // keyboard back. Escape closes without a tap, so this also runs on `close`
  // (a no-op after a tap, since `returnFocusTo` is cleared).
  const restoreFocus = () => {
    const target = returnFocusTo;
    returnFocusTo = null;
    if (target !== null && target.isConnected) {
      target.focus({ preventScroll: true });
    }
  };
  const close = () => {
    if (dialog.open) {
      dialog.close();
    }
    restoreFocus();
  };
  dialog.addEventListener('close', restoreFocus, { signal });
  cancelButton.addEventListener('click', close, { signal });
  leaveButton.addEventListener('click', () => {
    returnFocusTo = null;
    dialog.close();
    onLeave();
  }, { signal });
  // `.sheet-body` fills the dialog, so a click on the dialog itself is a
  // click on the backdrop.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      close();
    }
  }, { signal });

  const open = () => {
    if (dialog.open) {
      return;
    }
    returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
  };
  return { dialog, open };
}

function startPass(container, { countries, navigate, region, mode, signal }) {
  let pass = createTestPass({ countries, region, rng: Math.random });

  const counter = el('p', { class: 'view-counter test-counter' });
  const exitSheet = createExitSheet({ onLeave: () => navigate('home'), signal });
  const exitButton = el('button', {
    type: 'button',
    class: 'button-quiet test-exit',
    'aria-haspopup': 'dialog'
  }, ['Exit']);
  exitButton.addEventListener('click', exitSheet.open, { signal });
  const stage = el('div', { class: 'test-question' });

  // Both in the capture phase, so they run before the options' own listeners.
  let shownAt = -Infinity;
  stage.addEventListener('click', (event) => {
    if (performance.now() - shownAt < ANSWER_GUARD_MS) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, { capture: true, signal });
  // A held Enter repeats on the newly focused option; only the first press
  // may answer. Typing into the input may still repeat.
  stage.addEventListener('keydown', (event) => {
    if (event.repeat && event.target instanceof HTMLButtonElement) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, { capture: true, signal });

  container.replaceChildren(
    el('div', { class: 'view-bar test-bar' }, [exitButton, counter]),
    stage,
    exitSheet.dialog
  );

  const showQuestion = () => {
    const position = pass.answers.length;
    counter.textContent = `${position + 1} / ${pass.codes.length}`;
    // Advance straight away: never `reveal()`, so nothing shows whether the
    // answer was right.
    const question = renderQuestion(stage, {
      code: pass.codes[position],
      mode,
      countries,
      rng: Math.random,
      signal,
      onAnswer: (chosenCode) => {
        pass = recordAnswer(pass, chosenCode);
        if (isPassComplete(pass)) {
          navigate('results', { mode, pass });
        } else {
          showQuestion();
        }
      }
    });
    shownAt = performance.now();
    // Keeps focus (and the iOS keyboard, in typing mode) in the question.
    question.focus();
  };
  showQuestion();
}

/**
 * Clean up the test view. A pass in progress is dropped.
 *
 * @returns {void}
 */
export function unmount() {
  controller?.abort();
  controller = null;
}
