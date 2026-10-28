import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatScore } from '../js/test-pass.js';
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
import {
  FIRST_INTERVAL_DAYS,
  REQUEUE_GAP,
  createCardState,
  pickRound,
  updateCardState
} from '../js/srs.js';

// ---- Helpers ----

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { countries } = JSON.parse(readFileSync(join(REPO_ROOT, 'data', 'countries.json'), 'utf8'));

const TODAY = '2026-10-28';
const EARLIER = '2026-10-20';

// Mulberry32: small, fast, deterministic PRNG returning [0, 1).
function createRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// A flag answered correctly once on `EARLIER`: due `EARLIER + 1`, i.e. due
// (overdue) by `TODAY`.
function dueState(code) {
  return updateCardState(createCardState(code), true, EARLIER);
}

// A flag answered correctly once today: due tomorrow, i.e. not yet due.
function notYetDueState(code) {
  return updateCardState(createCardState(code), true, TODAY);
}
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
    assert.deepEqual(getScore(round), { correct: 0, total: 10, percent: 0 });
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

  it('does not re-queue a missed re-ask', () => {
    let round = answer(createRound(['fr', 'de', 'it']), false);
    round = answer(round, true);
    round = answer(round, true);
    assert.equal(getCurrentCode(round), 'fr');
    assert.equal(isReask(round), true);
    round = answer(round, false);
    assert.equal(isRoundComplete(round), true);
  });

  it('re-asks the last flag right away, once, when it is missed', () => {
    let round = createRound(['fr', 'de']);
    round = answer(round, true);
    round = answer(round, false);
    assert.deepEqual(round.queue, ['de']);
    assert.equal(isReask(round), true);
    round = answer(round, false);
    assert.equal(isRoundComplete(round), true);
    assert.deepEqual(getScore(round), { correct: 1, total: 2, percent: 50 });
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
    assert.deepEqual(getScore(round), { correct: 10, total: 10, percent: 100 });
  });

  it('asks every flag at least once, plus one re-ask per miss', () => {
    // Re-asks are always missed here too; still only one each.
    const missed = new Set(['fr', 'it', 'pl']);
    const { asked, round } = playRound(CODES, (code) => !missed.has(code));
    assert.equal(asked.length, CODES.length + missed.size);
    assert.deepEqual(new Set(asked), new Set(CODES));
    for (const code of missed) {
      assert.equal(asked.filter((item) => item === code).length, 2);
    }
  });

  it('scores first answers only, even when re-asks are correct', () => {
    const missed = new Set(['fr', 'it', 'pl']);
    const { round } = playRound(CODES, (code, reask) => reask || !missed.has(code));
    assert.deepEqual(getScore(round), { correct: 7, total: 10, percent: 70 });
  });

  it('scores 0 when every first answer is wrong, even if every re-ask is right', () => {
    const { round } = playRound(CODES, (code, reask) => reask);
    assert.deepEqual(getScore(round), { correct: 0, total: 10, percent: 0 });
  });

  it('rounds the percent down, and formats like test results', () => {
    const { round } = playRound(['fr', 'de', 'it'], (code, reask) => reask || code !== 'it');
    const score = getScore(round);
    assert.deepEqual(score, { correct: 2, total: 3, percent: 66 });
    assert.equal(formatScore(score), '2/3 · 66%');
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
    const result = recordAnswer({ states: {}, code: 'fr', correct: true, today: TODAY });
    assert.equal(result.changed, true);
    assert.deepEqual(result.states.fr, updateCardState(createCardState('fr'), true, TODAY));
    assert.equal(result.states.fr.repetitions, 1);
    assert.deepEqual([...result.persistedCodes], ['fr']);
  });

  it('records a miss on a never-seen flag as a lapse', () => {
    const { states } = recordAnswer({ states: {}, code: 'fr', correct: false, today: TODAY });
    assert.equal(states.fr.lapses, 1);
    assert.equal(states.fr.repetitions, 0);
  });

  it('updates a due flag and keeps the others', () => {
    const fr = dueState('fr');
    const de = dueState('de');
    const { states, changed } = recordAnswer({ states: { fr, de }, code: 'fr', correct: true, today: TODAY });
    assert.equal(changed, true);
    assert.deepEqual(states.fr, updateCardState(fr, true, TODAY));
    assert.equal(states.fr.repetitions, 2);
    assert.equal(states.de, de);
  });

  it('applies a miss on a due flag', () => {
    const fr = dueState('fr');
    const { states } = recordAnswer({ states: { fr }, code: 'fr', correct: false, today: TODAY });
    assert.equal(states.fr.repetitions, 0);
    assert.equal(states.fr.lapses, fr.lapses + 1);
  });

  it('treats a flag due exactly today as due', () => {
    const fr = updateCardState(createCardState('fr'), true, '2026-10-27');
    assert.equal(fr.dueDate, TODAY);
    const { changed } = recordAnswer({ states: { fr }, code: 'fr', correct: true, today: TODAY });
    assert.equal(changed, true);
  });

  it('leaves an early (not yet due) flag unchanged on a correct answer', () => {
    const before = { fr: notYetDueState('fr') };
    const persistedCodes = new Set();
    const result = recordAnswer({ states: before, code: 'fr', correct: true, today: TODAY, persistedCodes });
    assert.equal(result.changed, false);
    assert.equal(result.states, before);
    assert.equal(result.persistedCodes, persistedCodes);
    assert.equal(persistedCodes.size, 0);
  });

  it('still lapses an early (not yet due) flag on a miss', () => {
    const fr = notYetDueState('fr');
    const result = recordAnswer({ states: { fr }, code: 'fr', correct: false, today: TODAY });
    assert.equal(result.changed, true);
    assert.deepEqual(result.states.fr, updateCardState(fr, false, TODAY));
    assert.equal(result.states.fr.lapses, fr.lapses + 1);
  });

  it('never changes a code twice in one visit', () => {
    const first = recordAnswer({ states: { fr: dueState('fr') }, code: 'fr', correct: false, today: TODAY });
    const second = recordAnswer({
      states: first.states,
      code: 'fr',
      correct: false,
      today: TODAY,
      persistedCodes: first.persistedCodes
    });
    assert.equal(second.changed, false);
    assert.equal(second.states, first.states);
    assert.equal(second.states.fr.lapses, 1);
  });

  it('persists the same code once across two rounds of one visit', () => {
    let states = {};
    let persistedCodes = new Set();
    let saves = 0;
    for (let i = 0; i < 2; i += 1) {
      let round = createRound(['fr', 'de']);
      while (!isRoundComplete(round)) {
        const result = answerCurrent(round, true);
        if (result.isFirstAnswer) {
          const recorded = recordAnswer({ states, code: result.code, correct: true, today: TODAY, persistedCodes });
          ({ states, persistedCodes } = recorded);
          saves += recorded.changed ? 1 : 0;
        }
        round = result.round;
      }
      assert.deepEqual(getScore(round), { correct: 2, total: 2, percent: 100 });
    }
    assert.equal(saves, 2);
    assert.equal(states.fr.repetitions, 1);
  });

  it('does not modify its inputs', () => {
    const states = { fr: dueState('fr') };
    const snapshot = structuredClone(states);
    const persistedCodes = new Set(['de']);
    recordAnswer({ states, code: 'fr', correct: true, today: TODAY, persistedCodes });
    assert.deepEqual(states, snapshot);
    assert.deepEqual([...persistedCodes], ['de']);
  });

  it('rejects bad arguments', () => {
    assert.throws(() => recordAnswer(), TypeError);
    assert.throws(() => recordAnswer({ states: null, code: 'fr', correct: true, today: TODAY }), TypeError);
    assert.throws(() => recordAnswer({ states: [], code: 'fr', correct: true, today: TODAY }), TypeError);
    assert.throws(() => recordAnswer({ states: {}, code: 'fr', correct: 'yes', today: TODAY }), TypeError);
    assert.throws(() => recordAnswer({ states: {}, code: 'fr', correct: true, today: '28/10/2026' }));
    assert.throws(
      () => recordAnswer({ states: {}, code: 'fr', correct: true, today: TODAY, persistedCodes: ['de'] }),
      TypeError
    );
    // Validated even when the code would be skipped.
    assert.throws(
      () => recordAnswer({ states: {}, code: 'fr', correct: 'yes', today: TODAY, persistedCodes: new Set(['fr']) }),
      TypeError
    );
  });
});

// ---- Several rounds in one sitting ----

describe('several all-correct rounds on one day', () => {
  // Play `rounds` all-correct rounds over South America (13 flags, so
  // `pickRound` soon refills rounds with flags answered minutes ago).
  // `newVisitEachRound` models Done then Start instead of Keep going.
  function playSitting({ rounds, newVisitEachRound, seed }) {
    const rng = createRng(seed);
    let states = {};
    let persistedCodes = new Set();
    for (let i = 0; i < rounds; i += 1) {
      if (newVisitEachRound) {
        persistedCodes = new Set();
      }
      let round = createRound(pickRound({ states, countries, today: TODAY, region: 'south-america', rng }));
      assert.equal(round.total, 10);
      while (!isRoundComplete(round)) {
        const result = answerCurrent(round, true);
        if (result.isFirstAnswer) {
          ({ states, persistedCodes } = recordAnswer({
            states,
            code: result.code,
            correct: true,
            today: TODAY,
            persistedCodes
          }));
        }
        round = result.round;
      }
    }
    return states;
  }

  for (const newVisitEachRound of [false, true]) {
    const label = newVisitEachRound ? 'Done then Start' : 'Keep going';
    it(`never grows an interval past the first step (${label})`, () => {
      for (let seed = 1; seed <= 20; seed += 1) {
        const states = playSitting({ rounds: 4, newVisitEachRound, seed });
        for (const state of Object.values(states)) {
          assert.equal(state.repetitions, 1, `seed ${seed}: ${state.code}`);
          assert.ok(state.intervalDays <= FIRST_INTERVAL_DAYS, `seed ${seed}: ${state.code} at ${state.intervalDays} days`);
        }
      }
    });
  }
});

describe('Keep going on a fresh profile (GitHub #32)', () => {
  it('shows 40 distinct flags in 4 all-correct rounds over All', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const rng = createRng(seed);
      let states = {};
      let persistedCodes = new Set();
      const shown = new Set();
      for (let i = 0; i < 4; i += 1) {
        let round = createRound(pickRound({ states, countries, today: TODAY, rng }));
        while (!isRoundComplete(round)) {
          shown.add(getCurrentCode(round));
          const result = answerCurrent(round, true);
          ({ states, persistedCodes } = recordAnswer({
            states,
            code: result.code,
            correct: true,
            today: TODAY,
            persistedCodes
          }));
          round = result.round;
        }
      }
      assert.equal(shown.size, 40, `seed ${seed}`);
    }
  });
});
