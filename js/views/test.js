// Test view (spec #6, PLAN decision 4): pick a scope, then answer every flag
// in it once, blind. No per-question feedback: the question is never
// revealed, there is no score on screen, only a position counter. The last
// answer goes to the results view. Test mode never reads or writes SRS state,
// and a pass in progress is kept only in memory, so a reload discards it
// (test/test-mode-isolation.test.js guards this).
//
// `params`: `{ region, mode }` from home (see the view contract in
// js/app.js); results' Retake adds `autostart: true` to skip the picker.

import { renderQuestion } from '../question.js';
import { REGIONS } from '../srs.js';
import { createTestPass, getScopeCodes, isPassComplete, recordAnswer } from '../test-pass.js';
import { ALL_REGIONS_LABEL, MODE_LABELS, REGION_LABELS, createChoiceGroup, el } from '../ui.js';

// Radio value of "All"; maps to `region: null` everywhere else.
const ALL_VALUE = 'all';

const EXIT_MESSAGE = 'Leave this test? Your answers so far will not be kept.';

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
    el('div', { class: 'test-actions' }, [startButton, backButton])
  );
}

function startPass(container, { countries, navigate, region, mode, signal }) {
  let pass = createTestPass({ countries, region, rng: Math.random });

  const counter = el('p', { class: 'test-counter' });
  const exitButton = el('button', { type: 'button', class: 'test-exit' }, ['Exit']);
  exitButton.addEventListener('click', () => {
    if (window.confirm(EXIT_MESSAGE)) {
      navigate('home');
    }
  }, { signal });
  const stage = el('div', { class: 'test-question' });

  container.replaceChildren(
    el('div', { class: 'test-bar' }, [counter, exitButton]),
    stage
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
