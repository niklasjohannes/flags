// One flag question, shared by practice (spec #5) and test mode (spec #6).
// Owned by spec #4; coordinate changes through the orchestrator, since both
// flows depend on it.
//
// Shows the flag (generic `alt`) and, by mode:
//   - 'mc': the options from `buildChoices` as buttons;
//   - 'typing': a text input with a live `filterSuggestions` list. The user
//     answers ONLY by tapping a suggestion row (PLAN decision 7): there is no
//     form, and Enter never submits.
// The first answer calls `onAnswer(chosenCode)` exactly once and locks the
// question. It shows no right/wrong feedback by itself: the caller decides.
// Practice calls `reveal()` for feedback; test mode never does.

import { buildChoices, filterSuggestions } from './quiz.js';
import { QUIZ_MODES } from './storage.js';
import { el, renderFlag } from './ui.js';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Render a question into `container`, replacing its contents.
 *
 * @param {HTMLElement} container Where to render.
 * @param {object} options
 * @param {string} options.code The flag to ask about (the correct answer).
 * @param {string} options.mode One of `QUIZ_MODES` (`'mc'` or `'typing'`).
 * @param {object[]} options.countries The `countries` array of
 *   `data/countries.json` (`context.countries`).
 * @param {() => number} options.rng Random source returning `[0, 1)`, for
 *   the multiple-choice options (e.g. `Math.random`).
 * @param {(chosenCode: string) => void} options.onAnswer Called once, with
 *   the code the user picked.
 * @param {AbortSignal} [options.signal] Removes the question's listeners when
 *   aborted (pass the view's unmount signal).
 * @returns {{ reveal: () => void, focus: () => void, chosenCode: string | null }}
 *   Handle (frozen). `reveal()` shows the answer: marks the correct option
 *   (`.is-correct`) and a wrong pick (`.is-wrong`), shows the correct name in
 *   typing mode, sets the flag's `alt` to the name and locks the question.
 *   `focus()` focuses the first option or the text input. `chosenCode` is
 *   the answer given so far (`null` before it).
 */
export function renderQuestion(container, options) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('`container` must be an element.');
  }
  if (!isPlainObject(options)) {
    throw new TypeError('`options` must be an object.');
  }
  const { code, mode, countries, rng, onAnswer, signal } = options;
  if (!Array.isArray(countries)) {
    throw new TypeError('`countries` must be an array.');
  }
  const target = countries.find((country) => country.code === code);
  if (target === undefined) {
    throw new RangeError('`code` must be the code of one of `countries`.');
  }
  if (!QUIZ_MODES.includes(mode)) {
    throw new RangeError(`\`mode\` must be one of ${QUIZ_MODES.join(', ')}.`);
  }
  if (typeof rng !== 'function') {
    throw new TypeError('`rng` must be a function returning a number in [0, 1).');
  }
  if (typeof onAnswer !== 'function') {
    throw new TypeError('`onAnswer` must be a function.');
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('`signal` must be an `AbortSignal`, or omitted.');
  }

  const names = new Map(countries.map((country) => [country.code, country.name]));
  let chosenCode = null;
  let isLocked = false;

  const flag = renderFlag(el('img', {
    class: 'question-flag',
    width: 640,
    height: 480,
    decoding: 'async',
    draggable: 'false'
  }), code);

  // Option buttons currently on screen, keyed by code.
  const buttons = new Map();
  const createOption = (optionCode, className) => {
    const button = el('button', { type: 'button', class: className, 'data-code': optionCode }, [
      names.get(optionCode)
    ]);
    button.addEventListener('click', () => answer(optionCode), { signal });
    buttons.set(optionCode, button);
    return button;
  };

  let input = null;
  let answerLine = null;
  let body;
  if (mode === 'mc') {
    const choices = buildChoices({ code, countries, rng });
    body = el('div', { class: 'question-options' }, choices.map(
      (choice) => createOption(choice, 'question-option')
    ));
  } else {
    input = el('input', {
      class: 'question-input',
      type: 'text',
      'aria-label': 'Country name',
      placeholder: 'Type a country…',
      autocomplete: 'off',
      autocorrect: 'off',
      autocapitalize: 'none',
      spellcheck: 'false',
      enterkeyhint: 'done'
    });
    const list = el('ul', { class: 'question-suggestions', 'aria-label': 'Suggestions' });
    // Empty until `reveal()`; a live region, so the name is announced. It stays
    // in the layout (not `hidden`) so screen readers track it from the start.
    answerLine = el('p', { class: 'question-answer', 'aria-live': 'polite' });
    input.addEventListener('input', () => {
      if (isLocked) {
        return;
      }
      buttons.clear();
      list.replaceChildren(...filterSuggestions(input.value, countries).map(
        (suggestion) => el('li', {}, [createOption(suggestion.code, 'question-suggestion')])
      ));
    }, { signal });
    // No raw-text answers: Enter does nothing. Except while an IME is
    // composing (Japanese, Chinese, ...), where Enter commits the composition;
    // Safari reports that as `keyCode` 229 rather than `isComposing`.
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
      }
    }, { signal });
    body = el('div', { class: 'question-typing' }, [input, list, answerLine]);
  }

  function lock() {
    isLocked = true;
    for (const button of buttons.values()) {
      button.disabled = true;
    }
    if (input !== null) {
      input.disabled = true;
    }
  }

  function answer(optionCode) {
    if (isLocked) {
      return;
    }
    chosenCode = optionCode;
    lock();
    buttons.get(optionCode)?.classList.add('is-chosen');
    onAnswer(optionCode);
  }

  function markOption(optionCode, className, hiddenText) {
    const button = buttons.get(optionCode);
    if (button === undefined || button.classList.contains(className)) {
      return;
    }
    button.classList.add(className);
    button.append(el('span', { class: 'visually-hidden' }, [hiddenText]));
  }

  function reveal() {
    lock();
    renderFlag(flag, code, { revealedName: target.name });
    // Classes for the look, hidden text for screen readers.
    markOption(code, 'is-correct', ' (correct answer)');
    if (chosenCode !== null && chosenCode !== code) {
      markOption(chosenCode, 'is-wrong', ' (your answer)');
    }
    if (answerLine !== null) {
      answerLine.textContent = target.name;
    }
  }

  function focus() {
    const first = input ?? buttons.values().next().value;
    first?.focus({ preventScroll: true });
  }

  container.replaceChildren(el('div', { class: 'question', 'data-mode': mode }, [
    el('div', { class: 'question-flag-frame' }, [flag]),
    body
  ]));

  return Object.freeze({
    reveal,
    focus,
    get chosenCode() {
      return chosenCode;
    }
  });
}
