// Practice view (spec #5; PLAN decisions 3, 5, 6): rounds of `ROUND_SIZE`
// flags from the SRS scheduler, scoped to the region picked on home, then a
// round-end summary with Keep going / Done.
//
// Receives `params: { region, mode }` from home. See the view contract in
// js/app.js. Round logic (what is asked next, which answer counts, the score)
// is in js/practice-round.js; this file only renders it and persists answers.
//
// Feedback is hybrid (PLAN decision 5): a correct answer is revealed and
// auto-advances after `CORRECT_ADVANCE_MS`; a miss is revealed (showing the
// correct name) and waits for a Next tap.
//
// The first answer to each flag is saved immediately, so leaving mid-round
// keeps progress; that is also why Exit needs no confirmation. Re-asks of a
// missed flag are never saved or scored. What gets saved follows the
// early-review and once-per-visit rules in js/practice-round.js; a visit
// lasts from mount to unmount, so it spans Keep going.

import {
  answerCurrent,
  createRound,
  getCurrentCode,
  getProgress,
  getScore,
  isReask,
  isRoundComplete,
  recordAnswer
} from '../practice-round.js';
import { renderQuestion } from '../question.js';
import { ROUND_SIZE, pickRound } from '../srs.js';
import { loadStates, localToday, saveStates } from '../storage.js';
import { el } from '../ui.js';

/** Delay (ms) between revealing a correct answer and the next question. */
export const CORRECT_ADVANCE_MS = 700;

/**
 * Clicks on a new question are ignored for this long (ms), so a double press
 * of Enter or a double tap on Next cannot answer the next question.
 */
export const ANSWER_GUARD_MS = 300;

let controller = null;

/**
 * Render the practice view and start a round.
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
  const { region, mode } = params;

  // At most one auto-advance is pending at a time.
  let advanceTimer = null;
  const clearAdvance = () => {
    clearTimeout(advanceTimer);
    advanceTimer = null;
  };
  signal.addEventListener('abort', clearAdvance);

  const exitButton = el('button', { type: 'button', class: 'practice-exit' }, ['Exit']);
  exitButton.addEventListener('click', () => navigate('home'), { signal });
  const progress = el('p', { class: 'practice-progress' });
  const header = el('div', { class: 'practice-header' }, [exitButton, progress]);

  const questionArea = el('div', { class: 'practice-question' });
  const feedback = el('p', { class: 'practice-feedback', 'aria-live': 'polite' });
  const nextButton = el('button', { type: 'button', class: 'button button-primary practice-next', hidden: true }, ['Next']);

  let round = null;
  let question = null;
  let persistedCodes = new Set();

  // Swallow clicks (including Enter / Space activations) on the question
  // just after it appears, before they reach its buttons.
  let guardUntil = 0;
  questionArea.addEventListener('click', (event) => {
    if (performance.now() < guardUntil) {
      event.stopPropagation();
      event.preventDefault();
    }
  }, { capture: true, signal });

  function showSummary() {
    const { correct, total } = getScore(round);
    const keepGoingButton = el('button', { type: 'button', class: 'button button-primary', 'data-action': 'keep-going' }, ['Keep going']);
    const doneButton = el('button', { type: 'button', class: 'button button-secondary', 'data-action': 'done' }, ['Done']);
    keepGoingButton.addEventListener('click', startRound, { signal });
    doneButton.addEventListener('click', () => navigate('home'), { signal });
    container.replaceChildren(el('div', { class: 'practice-summary' }, [
      el('h1', { class: 'practice-score' }, [`${correct}/${total} correct`]),
      el('div', { class: 'practice-actions' }, [keepGoingButton, doneButton])
    ]));
    keepGoingButton.focus({ preventScroll: true });
  }

  function showQuestion() {
    if (isRoundComplete(round)) {
      showSummary();
      return;
    }
    const code = getCurrentCode(round);
    const { position, total } = getProgress(round);
    progress.textContent = isReask(round) ? `${position} / ${total} · again` : `${position} / ${total}`;
    feedback.textContent = '';
    feedback.classList.remove('is-correct-feedback', 'is-wrong-feedback');
    nextButton.hidden = true;
    question = renderQuestion(questionArea, {
      code,
      mode,
      countries,
      rng: Math.random,
      signal,
      onAnswer: (chosenCode) => handleAnswer(chosenCode === code)
    });
    guardUntil = performance.now() + ANSWER_GUARD_MS;
    question.focus();
  }

  function handleAnswer(correct) {
    const result = answerCurrent(round, correct);
    round = result.round;
    if (result.isFirstAnswer) {
      // Load fresh before writing, so the save never rolls back state written
      // elsewhere since this round started.
      const today = localToday();
      const recorded = recordAnswer({
        states: loadStates(today),
        code: result.code,
        correct,
        today,
        persistedCodes
      });
      persistedCodes = recorded.persistedCodes;
      if (recorded.changed) {
        saveStates(recorded.states);
      }
    }
    question.reveal();
    if (correct) {
      feedback.textContent = 'Correct';
      feedback.classList.add('is-correct-feedback');
      advanceTimer = setTimeout(() => {
        advanceTimer = null;
        showQuestion();
      }, CORRECT_ADVANCE_MS);
    } else {
      feedback.textContent = 'Not quite';
      feedback.classList.add('is-wrong-feedback');
      nextButton.hidden = false;
      nextButton.focus({ preventScroll: true });
    }
  }

  nextButton.addEventListener('click', showQuestion, { signal });

  function startRound() {
    clearAdvance();
    const today = localToday();
    const codes = pickRound({
      states: loadStates(today),
      countries,
      today,
      region,
      rng: Math.random,
      n: ROUND_SIZE
    });
    round = createRound(codes);
    if (isRoundComplete(round)) {
      // Only possible if the region has no flags at all.
      const doneButton = el('button', { type: 'button', class: 'button button-secondary' }, ['Done']);
      doneButton.addEventListener('click', () => navigate('home'), { signal });
      container.replaceChildren(el('p', { class: 'status' }, ['No flags to practise here.']), doneButton);
      return;
    }
    container.replaceChildren(header, questionArea, feedback, nextButton);
    showQuestion();
  }

  startRound();
}

/**
 * Clean up the practice view: cancels a pending auto-advance.
 *
 * @returns {void}
 */
export function unmount() {
  controller?.abort();
  controller = null;
}
