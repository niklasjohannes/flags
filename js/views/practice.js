// Practice view (spec #5; PLAN decisions 3, 5, 6; endless mode: GitHub #40):
// an endless stream of flags from the SRS scheduler, scoped to the region
// picked on home, drawn in `BATCH_SIZE` batches with no visible boundary
// between them.
//
// Receives `params: { region, mode }` from home. See the view contract in
// js/app.js. Batch logic (what is asked next, which answer counts, the
// batch's own score) is in js/practice-round.js; this file only renders it,
// persists answers, and tracks the session-wide counter.
//
// Feedback is hybrid (PLAN decision 5): a correct answer is revealed and
// auto-advances after `CORRECT_ADVANCE_MS`; a miss is revealed (showing the
// correct name) and waits for a Next tap.
//
// The first answer to each flag is saved immediately, so leaving mid-session
// keeps progress; that is also why Exit needs no confirmation. Re-asks of a
// missed flag are never saved or scored. What gets saved follows the
// early-review and once-per-visit rules in js/practice-round.js; a visit
// lasts from mount to unmount, so it spans every batch drawn in it.

import {
  answerCurrent,
  createRound,
  getCurrentCode,
  isRoundComplete,
  recordAnswer
} from '../practice-round.js';
import { guardQuestionArea, renderQuestion } from '../question.js';
import { BATCH_SIZE, pickRound } from '../srs.js';
import { loadStates, localToday, saveStates } from '../storage.js';
import { el } from '../ui.js';

/** Delay (ms) between revealing a correct answer and the next question. */
export const CORRECT_ADVANCE_MS = 700;

// Clicks on a new question are ignored for this long (ms), so a double press
// of Enter or a double tap on Next cannot answer the next question.
export { ANSWER_GUARD_MS } from '../question.js';

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

  const exitButton = el('button', { type: 'button', class: 'button-quiet practice-exit' }, ['Exit']);
  exitButton.addEventListener('click', () => navigate('home'), { signal });
  const progress = el('p', { class: 'view-counter practice-progress' });
  const header = el('div', { class: 'view-bar practice-header' }, [exitButton, progress]);

  const questionArea = el('div', { class: 'practice-question' });
  const feedback = el('p', { class: 'practice-feedback', 'aria-live': 'polite' });
  const nextButton = el('button', { type: 'button', class: 'button button-primary practice-next', hidden: true }, ['Next']);
  const actions = el('div', { class: 'view-actions practice-next-area' }, [nextButton]);

  let round = null;
  let question = null;
  let persistedCodes = new Set();

  // Session-wide counter (GitHub #40): first answers only, across every
  // batch drawn in this visit. Reset only when a new visit mounts.
  let sessionCorrect = 0;
  let sessionAnswered = 0;

  function updateCounter() {
    const percent = sessionAnswered === 0 ? 0 : Math.floor((sessionCorrect * 100) / sessionAnswered);
    progress.textContent = `${sessionCorrect}/${sessionAnswered} (${percent}%)`;
  }

  function drawBatch() {
    const today = localToday();
    const codes = pickRound({
      states: loadStates(today),
      countries,
      today,
      region,
      rng: Math.random,
      n: BATCH_SIZE
    });
    return createRound(codes);
  }

  // Swallow clicks on the question just after it appears, and a held Enter
  // on Next repeating onto its first option.
  const guard = guardQuestionArea(questionArea, { signal });

  function showQuestion() {
    if (isRoundComplete(round)) {
      // The region has at least one flag (checked in startRound), so this
      // batch is never empty: draw the next one and continue silently.
      round = drawBatch();
    }
    const code = getCurrentCode(round);
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
    guard.arm();
    question.focus();
  }

  function handleAnswer(correct) {
    const result = answerCurrent(round, correct);
    round = result.round;
    if (result.isFirstAnswer) {
      sessionAnswered += 1;
      if (correct) {
        sessionCorrect += 1;
      }
      updateCounter();
      // Load fresh before writing, so the save never rolls back state written
      // elsewhere since this batch started.
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
      // Focus Next. In typing mode that also closes the iOS keyboard, so the
      // revealed name and Next are in view; tapping Next reopens it (focus
      // from inside a tap is allowed). Correct answers keep the keyboard up.
      nextButton.focus({ preventScroll: true });
      if (document.activeElement instanceof HTMLInputElement) {
        document.activeElement.blur();
      }
    }
  }

  nextButton.addEventListener('click', showQuestion, { signal });

  function startRound() {
    clearAdvance();
    round = drawBatch();
    if (isRoundComplete(round)) {
      // Only possible if the region has no flags at all.
      const doneButton = el('button', { type: 'button', class: 'button button-secondary' }, ['Done']);
      doneButton.addEventListener('click', () => navigate('home'), { signal });
      container.replaceChildren(
        el('p', { class: 'status' }, ['No flags to practise here.']),
        el('div', { class: 'view-actions' }, [doneButton])
      );
      return;
    }
    updateCounter();
    // The verdict sits above the question, so a miss reads "✕ Not quite",
    // then the marked answers (and the name, in typing mode) below it.
    container.replaceChildren(header, feedback, questionArea, actions);
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
