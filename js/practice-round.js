// Practice round state machine (spec #5): which flag is asked next, which
// answer counts, and the score. Owned by issue-5-practice-flow.
//
// Pure module: no DOM, no `localStorage`, no clock. A round is an immutable
// value; every function returns a new one.
//
//   let round = createRound(pickRound(...));
//   while (!isRoundComplete(round)) {
//     const code = getCurrentCode(round);
//     ...ask, then:
//     const { round: next, isFirstAnswer } = answerCurrent(round, correct);
//     if (isFirstAnswer) saveStates(recordAnswer(states, code, correct, today));
//     round = next;
//   }
//   getScore(round); // { correct, total }
//
// Rules (js/srs.js module header):
//   - The FIRST answer to each flag in the round is the one that counts: it is
//     scored and the caller persists it with `recordAnswer`.
//   - A miss puts the flag back into the queue `REQUEUE_GAP` questions later
//     (`requeueLapse`). A re-ask is reinforcement only: it is never scored and
//     never persisted. A re-ask that is missed again is re-queued again, so a
//     flag keeps coming back until it is answered correctly once.
//   - Progress counts distinct flags, so re-asks do not advance it.

import { createCardState, requeueLapse, updateCardState } from './srs.js';

function assertCodes(codes) {
  if (!Array.isArray(codes) || !codes.every((code) => typeof code === 'string' && code !== '')) {
    throw new TypeError('`codes` must be an array of country code strings.');
  }
  if (new Set(codes).size !== codes.length) {
    throw new RangeError('`codes` must not contain duplicates.');
  }
}

function assertRound(round) {
  const isRound = typeof round === 'object' && round !== null &&
    Number.isInteger(round.total) && Array.isArray(round.queue) &&
    typeof round.results === 'object' && round.results !== null;
  if (!isRound) {
    throw new TypeError('`round` must be a round from `createRound`.');
  }
}

function freezeRound(total, queue, results) {
  return Object.freeze({
    total,
    queue: Object.freeze(queue),
    results: Object.freeze(results)
  });
}

/**
 * Start a round.
 *
 * @param {string[]} codes The round's distinct flags, in asking order (from
 *   `pickRound`). May be empty, giving a round that is already complete.
 * @returns {{ total: number, queue: string[], results: Object<string, boolean> }}
 *   Frozen round. `queue` holds the upcoming codes, the current one first;
 *   `results` maps each flag answered so far to whether its first answer was
 *   correct.
 */
export function createRound(codes) {
  assertCodes(codes);
  return freezeRound(codes.length, [...codes], {});
}

/**
 * The flag being asked now.
 *
 * @param {object} round A round from `createRound`.
 * @returns {string | null} Its code, or `null` once the round is complete.
 */
export function getCurrentCode(round) {
  assertRound(round);
  return round.queue[0] ?? null;
}

/**
 * Whether the current question is a re-ask of a flag already answered (and
 * missed) in this round.
 *
 * @param {object} round A round from `createRound`.
 * @returns {boolean} `false` for a first ask, or once the round is complete.
 */
export function isReask(round) {
  assertRound(round);
  const code = getCurrentCode(round);
  return code !== null && Object.hasOwn(round.results, code);
}

/**
 * Whether every question, re-asks included, has been answered.
 *
 * @param {object} round A round from `createRound`.
 * @returns {boolean}
 */
export function isRoundComplete(round) {
  assertRound(round);
  return round.queue.length === 0;
}

/**
 * Answer the current question.
 *
 * @param {object} round A round from `createRound`; must not be complete.
 * @param {boolean} correct Whether the answer was correct.
 * @returns {{ round: object, code: string, isFirstAnswer: boolean }} The next
 *   round state, the code just answered, and whether this was its first
 *   answer in the round (scored, and to be persisted by the caller).
 */
export function answerCurrent(round, correct) {
  assertRound(round);
  if (typeof correct !== 'boolean') {
    throw new TypeError('`correct` must be a boolean.');
  }
  const code = getCurrentCode(round);
  if (code === null) {
    throw new RangeError('`round` is already complete.');
  }
  const isFirstAnswer = !Object.hasOwn(round.results, code);
  const results = isFirstAnswer ? { ...round.results, [code]: correct } : { ...round.results };
  const rest = round.queue.slice(1);
  const queue = correct ? rest : requeueLapse(rest, code);
  return { round: freezeRound(round.total, queue, results), code, isFirstAnswer };
}

/**
 * Progress through the round's distinct flags.
 *
 * @param {object} round A round from `createRound`.
 * @returns {{ position: number, total: number }} `position` is the 1-based
 *   number of the flag being asked for the first time; during a re-ask (or
 *   once complete) it is the number of flags answered so far, so re-asks never
 *   advance it.
 */
export function getProgress(round) {
  assertRound(round);
  const answered = Object.keys(round.results).length;
  const isFirstAsk = getCurrentCode(round) !== null && !isReask(round);
  return { position: answered + (isFirstAsk ? 1 : 0), total: round.total };
}

/**
 * The round's score: first answers only.
 *
 * @param {object} round A round from `createRound`.
 * @returns {{ correct: number, total: number }}
 */
export function getScore(round) {
  assertRound(round);
  const correct = Object.values(round.results).filter(Boolean).length;
  return { correct, total: round.total };
}

/**
 * Apply a first answer to the persisted card states.
 *
 * @param {Object<string, object>} states Card states keyed by code (from
 *   `loadStates`).
 * @param {string} code The answered flag.
 * @param {boolean} correct Whether the answer was correct.
 * @param {string} today Local date, `YYYY-MM-DD`.
 * @returns {Object<string, object>} New state map; `states` is not modified.
 */
export function recordAnswer(states, code, correct, today) {
  if (typeof states !== 'object' || states === null || Array.isArray(states)) {
    throw new TypeError('`states` must be an object mapping country codes to card states.');
  }
  const current = Object.hasOwn(states, code) ? states[code] : createCardState(code);
  return { ...states, [code]: updateCardState(current, correct, today) };
}
