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
//
// Typing mode and the iOS keyboard: rendering the next typing question into
// the same container keeps the same input element (cleared), and locking
// makes it `readonly`, never `disabled`. So an input that has focus keeps it
// from one question to the next, and the keyboard stays up even when the
// next question comes from a timer (where iOS ignores `focus()`). Tapping a
// suggestion does not move focus off the input either.

import { buildChoices, filterSuggestions } from './quiz.js';
import { QUIZ_MODES } from './storage.js';
import { el, renderFlag } from './ui.js';

// What each container showed last: the question's controller and, in typing
// mode, the parts kept for the next question.
const previousByContainer = new WeakMap();

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
 *   (`.is-correct`), a wrong pick (`.is-wrong`) and the question itself
 *   (`.is-answered-correct` / `.is-answered-wrong`), shows the correct name
 *   in typing mode (dropping the unmarked suggestions), sets the flag's
 *   `alt` to the name and locks the question. `focus()` focuses the first
 *   option or the text input.
 *   `chosenCode` is the answer given so far (`null` before it). Once another
 *   question is rendered into `container`, the old handle does nothing.
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

  // Abort the question this container showed before, so its handle goes
  // inert and its listeners (on the reused input, too) are removed.
  previousByContainer.get(container)?.controller.abort();
  const controller = new AbortController();
  if (signal !== undefined) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', () => controller.abort(), { signal: controller.signal });
    }
  }
  const ownSignal = controller.signal;

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
    button.addEventListener('click', () => answer(optionCode), { signal: ownSignal });
    if (className === 'question-suggestion') {
      // Keep focus (and the iOS keyboard) in the input; `click` still fires.
      button.addEventListener('mousedown', (event) => event.preventDefault(), { signal: ownSignal });
    }
    buttons.set(optionCode, button);
    return button;
  };

  // Typing mode keeps the previous question's root and input when it is still
  // in `container`: replacing a focused input would close the iOS keyboard,
  // and a timer-driven `focus()` (practice's auto-advance) cannot reopen it.
  const previousTyping = previousByContainer.get(container)?.typing ?? null;
  const reusable = mode === 'typing' && previousTyping !== null &&
    previousTyping.root.parentNode === container;

  let root;
  let frame;
  let typing = null;
  if (reusable) {
    typing = previousTyping;
    ({ root, frame } = typing);
    root.classList.remove('is-answered-correct', 'is-answered-wrong');
    typing.input.value = '';
    typing.input.readOnly = false;
    typing.list.replaceChildren();
    typing.answerLine.textContent = '';
    frame.replaceChildren(flag);
  } else {
    frame = el('div', { class: 'question-flag-frame' }, [flag]);
    let body;
    if (mode === 'mc') {
      const choices = buildChoices({ code, countries, rng });
      body = el('div', { class: 'question-options' }, choices.map(
        (choice) => createOption(choice, 'question-option')
      ));
    } else {
      const input = el('input', {
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
      // Empty until `reveal()`; a live region, so the name is announced. It
      // stays in the layout (not `hidden`) so screen readers track it from the
      // start.
      const answerLine = el('p', { class: 'question-answer', 'aria-live': 'polite' });
      body = el('div', { class: 'question-typing' }, [input, list, answerLine]);
      typing = { input, list, answerLine };
    }
    root = el('div', { class: 'question', 'data-mode': mode }, [frame, body]);
    if (typing !== null) {
      typing = Object.assign(typing, { root, frame });
    }
    container.replaceChildren(root);
  }
  previousByContainer.set(container, { controller, typing });

  const input = typing?.input ?? null;
  const answerLine = typing?.answerLine ?? null;
  if (typing !== null) {
    const { list } = typing;
    input.addEventListener('input', () => {
      if (isLocked) {
        return;
      }
      buttons.clear();
      list.replaceChildren(...filterSuggestions(input.value, countries).map(
        (suggestion) => el('li', {}, [createOption(suggestion.code, 'question-suggestion')])
      ));
    }, { signal: ownSignal });
    // No raw-text answers: Enter does nothing. Except while an IME is
    // composing (Japanese, Chinese, ...), where Enter commits the composition;
    // Safari reports that as `keyCode` 229 rather than `isComposing`.
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
      }
    }, { signal: ownSignal });
  }

  function lock() {
    isLocked = true;
    for (const button of buttons.values()) {
      button.disabled = true;
    }
    // `readonly`, not `disabled`: a disabled input loses focus, and with it
    // the iOS keyboard.
    if (input !== null) {
      input.readOnly = true;
    }
  }

  function answer(optionCode) {
    if (isLocked || ownSignal.aborted) {
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
    // A handle of a question that has been replaced does nothing.
    if (ownSignal.aborted) {
      return;
    }
    lock();
    renderFlag(flag, code, { revealedName: target.name });
    root.classList.add(chosenCode === code ? 'is-answered-correct' : 'is-answered-wrong');
    // Classes for the look, hidden text for screen readers.
    markOption(code, 'is-correct', ' (correct answer)');
    if (chosenCode !== null && chosenCode !== code) {
      markOption(chosenCode, 'is-wrong', ' (your answer)');
    }
    if (typing !== null) {
      // Keep only the marked rows, so the correct name sits right under the
      // input instead of below a screenful of other suggestions.
      for (const [optionCode, button] of buttons) {
        if (optionCode !== code && optionCode !== chosenCode) {
          button.closest('li')?.remove();
        }
      }
      answerLine.textContent = target.name;
    }
  }

  function focus() {
    if (ownSignal.aborted) {
      return;
    }
    const first = input ?? buttons.values().next().value;
    first?.focus({ preventScroll: true });
  }

  return Object.freeze({
    reveal,
    focus,
    get chosenCode() {
      return chosenCode;
    }
  });
}
