import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  answerCurrent,
  createRound,
  getCurrentCode,
  getProgress,
  getScore,
  isReask,
  isRoundComplete,
  recordAnswer
} from '../js/practice-round.js';
import { REQUEUE_GAP, createCardState, updateCardState } from '../js/srs.js';

// ---- Helpers ----

const TODAY = '2026-10-28';
const CODES = ['fr', 'de', 'it', 'es', 'pt', 'nl', 'be', 'at', 'ch', 'pl'];

// Answer the current question, returning only the next round.
function answer(round, correct) {
  return answerCurrent(round, correct).round;
}

// Play a whole round, answering each code with `isCorrect(code, isReask)`.
// Returns every code asked, in order, and the final round.
function playRound(codes, isCorrect) {
  let round = createRound(codes);
  const asked = [];
  while (!isRoundComplete(round)) {
    const code = getCurrentCode(round);
    asked.push(code);
    round = answer(round, isCorrect(code, isReask(round)));
  }
  return { asked, round };
}

// ---- createRound ----

describe('createRound', () => {
  it('starts on the first code with nothing answered', () => {
    const round = createRound(CODES);
    assert.equal(getCurrentCode(round), 'fr');
    assert.equal(isReask(round), false);
    assert.equal(isRoundComplete(round), false);
    assert.deepEqual(getProgress(round), { position: 1, total: 10 });
    assert.deepEqual(getScore(round), { correct: 0, total: 10 });
  });

  it('does not keep a reference to the input array', () => {
    const codes = [...CODES];
    const round = createRound(codes);
    codes[0] = 'gb';
    assert.equal(getCurrentCode(round), 'fr');
  });

  it('returns a frozen round', () => {
    const round = createRound(CODES);
    assert.ok(Object.isFrozen(round));
    assert.ok(Object.isFrozen(round.queue));
    assert.ok(Object.isFrozen(round.results));
  });

  it('gives an already complete round for no codes', () => {
    const round = createRound([]);
    assert.equal(isRoundComplete(round), true);
    assert.equal(getCurrentCode(round), null);
    assert.deepEqual(getProgress(round), { position: 0, total: 0 });
  });

  it('rejects non-arrays, non-string codes and duplicates', () => {
    assert.throws(() => createRound('fr'), TypeError);
    assert.throws(() => createRound(['fr', 3]), TypeError);
    assert.throws(() => createRound(['fr', '']), TypeError);
    assert.throws(() => createRound(['fr', 'fr']), RangeError);
  });
});

// ---- answerCurrent ----

describe('answerCurrent', () => {
  it('moves to the next code on a correct answer', () => {
    const result = answerCurrent(createRound(CODES), true);
    assert.equal(result.code, 'fr');
    assert.equal(result.isFirstAnswer, true);
    assert.equal(getCurrentCode(result.round), 'de');
    assert.deepEqual(result.round.results, { fr: true });
  });

  it('re-queues a miss REQUEUE_GAP questions later', () => {
    const round = answer(createRound(CODES), false);
    assert.equal(round.queue.length, CODES.length);
    assert.equal(round.queue[REQUEUE_GAP], 'fr');
    assert.deepEqual(round.queue.slice(0, REQUEUE_GAP), CODES.slice(1, 1 + REQUEUE_GAP));
  });

  it('marks the re-ask as not a first answer and keeps the first result', () => {
    let round = answer(createRound(CODES), false);
    for (let i = 0; i < REQUEUE_GAP; i += 1) {
      round = answer(round, true);
    }
    assert.equal(getCurrentCode(round), 'fr');
    assert.equal(isReask(round), true);
    const result = answerCurrent(round, true);
    assert.equal(result.isFirstAnswer, false);
    assert.equal(result.round.results.fr, false);
  });

  it('re-queues a missed re-ask again', () => {
    let round = answer(createRound(['fr', 'de']), false);
    round = answer(round, true);
    assert.equal(getCurrentCode(round), 'fr');
    round = answer(round, false);
    assert.deepEqual(round.queue, ['fr']);
    round = answer(round, true);
    assert.equal(isRoundComplete(round), true);
  });

  it('does not modify the round it was given', () => {
    const round = createRound(CODES);
    answerCurrent(round, false);
    assert.deepEqual(round.queue, CODES);
    assert.deepEqual(round.results, {});
  });

  it('rejects a non-boolean answer, a complete round and a non-round', () => {
    assert.throws(() => answerCurrent(createRound(CODES), 'yes'), TypeError);
    assert.throws(() => answerCurrent(createRound([]), true), RangeError);
    assert.throws(() => answerCurrent({}, true), TypeError);
    assert.throws(() => answerCurrent(null, true), TypeError);
  });
});

// ---- Whole rounds ----

describe('a full round', () => {
  it('asks each flag once when every answer is correct', () => {
    const { asked, round } = playRound(CODES, () => true);
    assert.deepEqual(asked, CODES);
    assert.deepEqual(getScore(round), { correct: 10, total: 10 });
  });

  it('asks every flag at least once, plus one re-ask per miss', () => {
    const missed = new Set(['fr', 'it', 'pl']);
    const { asked, round } = playRound(CODES, (code, reask) => reask || !missed.has(code));
    assert.equal(asked.length, CODES.length + missed.size);
    assert.deepEqual(new Set(asked), new Set(CODES));
    for (const code of missed) {
      assert.equal(asked.filter((item) => item === code).length, 2);
    }
  });

  it('scores first answers only, even when re-asks are correct', () => {
    const missed = new Set(['fr', 'it', 'pl']);
    const { round } = playRound(CODES, (code, reask) => reask || !missed.has(code));
    assert.deepEqual(getScore(round), { correct: 7, total: 10 });
  });

  it('scores 0 when every first answer is wrong, even if every re-ask is right', () => {
    const { round } = playRound(CODES, (code, reask) => reask);
    assert.deepEqual(getScore(round), { correct: 0, total: 10 });
  });

  it('reports one first answer per flag', () => {
    const firsts = [];
    let round = createRound(CODES);
    while (!isRoundComplete(round)) {
      const correct = isReask(round) || getCurrentCode(round) !== 'de';
      const result = answerCurrent(round, correct);
      if (result.isFirstAnswer) {
        firsts.push(result.code);
      }
      round = result.round;
    }
    assert.deepEqual(firsts, CODES);
  });
});

// ---- getProgress ----

describe('getProgress', () => {
  it('advances by one per new flag', () => {
    let round = createRound(CODES);
    for (let i = 1; i <= CODES.length; i += 1) {
      assert.deepEqual(getProgress(round), { position: i, total: 10 });
      round = answer(round, true);
    }
    assert.deepEqual(getProgress(round), { position: 10, total: 10 });
  });

  it('does not advance on a re-ask', () => {
    let round = answer(createRound(['fr', 'de']), false);
    assert.deepEqual(getProgress(round), { position: 2, total: 2 });
    round = answer(round, true);
    // Re-ask of `fr`: both flags answered once, still 2 / 2.
    assert.equal(isReask(round), true);
    assert.deepEqual(getProgress(round), { position: 2, total: 2 });
  });
});

// ---- recordAnswer ----

describe('recordAnswer', () => {
  it('creates state for a never-seen flag', () => {
    const states = recordAnswer({}, 'fr', true, TODAY);
    assert.deepEqual(states.fr, updateCardState(createCardState('fr'), true, TODAY));
    assert.equal(states.fr.repetitions, 1);
  });

  it('updates an existing state and keeps the others', () => {
    const seen = updateCardState(createCardState('fr'), true, '2026-10-20');
    const other = updateCardState(createCardState('de'), false, '2026-10-20');
    const states = recordAnswer({ fr: seen, de: other }, 'fr', false, TODAY);
    assert.equal(states.fr.repetitions, 0);
    assert.equal(states.fr.lapses, seen.lapses + 1);
    assert.equal(states.de, other);
  });

  it('does not modify the given states', () => {
    const states = {};
    recordAnswer(states, 'fr', true, TODAY);
    assert.deepEqual(states, {});
  });

  it('rejects bad arguments', () => {
    assert.throws(() => recordAnswer(null, 'fr', true, TODAY), TypeError);
    assert.throws(() => recordAnswer([], 'fr', true, TODAY), TypeError);
    assert.throws(() => recordAnswer({}, 'fr', 'yes', TODAY), TypeError);
    assert.throws(() => recordAnswer({}, 'fr', true, '28/10/2026'));
  });
});
