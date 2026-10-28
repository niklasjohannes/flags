import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
  EASE_STEP_DOWN,
  EASE_STEP_UP,
  INITIAL_EASE_FACTOR,
  MAX_DATE,
  MAX_EASE_FACTOR,
  MAX_INTERVAL_DAYS,
  MIN_EASE_FACTOR,
  NEW_FLAG_LIMIT,
  REQUEUE_GAP,
  ROUND_SIZE,
  countDue,
  createCardState,
  isNewCard,
  pickRound,
  requeueLapse,
  sanitizeStates,
  updateCardState
} from '../js/srs.js';

// ---- Helpers ----

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

const TODAY = '2026-03-28';

function makeCountries(prefix, count, region = 'europe') {
  return Array.from({ length: count }, (_, i) => ({ code: `${prefix}${i}`, region }));
}

function makeState(code, overrides = {}) {
  return {
    code,
    repetitions: 3,
    easeFactor: INITIAL_EASE_FACTOR,
    intervalDays: 10,
    dueDate: TODAY,
    lapses: 0,
    ...overrides
  };
}

function toStates(list) {
  return Object.fromEntries(list.map((state) => [state.code, state]));
}

function answerRepeatedly(correct, times, start = createCardState('fr')) {
  const history = [];
  let state = start;
  for (let i = 0; i < times; i += 1) {
    state = updateCardState(state, correct, TODAY);
    history.push(state);
  }
  return history;
}

// Count how often each code is picked across many seeded rounds.
function countPicks(options, rounds = 2_000) {
  const counts = new Map();
  for (let seed = 1; seed <= rounds; seed += 1) {
    for (const code of pickRound({ ...options, rng: createRng(seed) })) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  return counts;
}

function sumCounts(counts, codes) {
  return codes.reduce((sum, code) => sum + (counts.get(code) ?? 0), 0);
}

// ---- Card state ----

describe('createCardState / isNewCard', () => {
  it('creates a never-seen state', () => {
    assert.deepEqual(createCardState('fr'), {
      code: 'fr',
      repetitions: 0,
      easeFactor: INITIAL_EASE_FACTOR,
      intervalDays: 0,
      dueDate: null,
      lapses: 0
    });
  });

  it('tells never-seen apart from seen', () => {
    assert.equal(isNewCard(undefined), true);
    assert.equal(isNewCard(null), true);
    assert.equal(isNewCard(createCardState('fr')), true);
    assert.equal(isNewCard(updateCardState(createCardState('fr'), false, TODAY)), false);
    assert.equal(isNewCard(updateCardState(createCardState('fr'), true, TODAY)), false);
  });

  it('rejects invalid input', () => {
    assert.throws(() => createCardState(''), TypeError);
    assert.throws(() => createCardState(42), TypeError);
    assert.throws(() => isNewCard({ code: 'fr' }), TypeError);
  });
});

// ---- Answer updates ----

describe('updateCardState', () => {
  it('grows the interval 1 -> 6 -> x easeFactor on repeated correct answers', () => {
    const history = answerRepeatedly(true, 5);
    assert.deepEqual(history.map((s) => s.repetitions), [1, 2, 3, 4, 5]);
    assert.equal(history[0].intervalDays, 1);
    assert.equal(history[1].intervalDays, 6);
    for (let i = 2; i < history.length; i += 1) {
      const previous = history[i - 1];
      assert.equal(history[i].intervalDays, Math.round(previous.intervalDays * previous.easeFactor));
    }
    assert.equal(history[0].dueDate, '2026-03-29');
    assert.equal(history[1].dueDate, '2026-04-03');
    assert.equal(history[0].easeFactor, INITIAL_EASE_FACTOR + EASE_STEP_UP);
  });

  it('resets to a 1-day interval on an incorrect answer', () => {
    const [, , , mature] = answerRepeatedly(true, 4);
    const lapsed = updateCardState(mature, false, TODAY);
    assert.equal(lapsed.repetitions, 0);
    assert.equal(lapsed.intervalDays, 1);
    assert.equal(lapsed.dueDate, '2026-03-29');
    assert.equal(lapsed.lapses, mature.lapses + 1);
    assert.equal(lapsed.easeFactor, Math.round((mature.easeFactor - EASE_STEP_DOWN) * 100) / 100);

    // The next correct answer restarts the 1 -> 6 ladder.
    const relearned = updateCardState(lapsed, true, TODAY);
    assert.equal(relearned.repetitions, 1);
    assert.equal(relearned.intervalDays, 1);
  });

  it('never lets ease exceed the cap under a long correct streak', () => {
    const history = answerRepeatedly(true, 100);
    assert.ok(history.every((s) => s.easeFactor <= MAX_EASE_FACTOR));
    assert.equal(history.at(-1).easeFactor, MAX_EASE_FACTOR);
    assert.ok(history.every((s) => s.intervalDays <= MAX_INTERVAL_DAYS));
    assert.equal(history.at(-1).intervalDays, MAX_INTERVAL_DAYS);
  });

  it('never lets ease drop below the floor under a long incorrect streak', () => {
    const history = answerRepeatedly(false, 100);
    assert.ok(history.every((s) => s.easeFactor >= MIN_EASE_FACTOR));
    assert.equal(history.at(-1).easeFactor, MIN_EASE_FACTOR);
    assert.equal(history.at(-1).lapses, 100);
  });

  it('computes due dates on calendar days across DST and month/year ends', () => {
    const state = createCardState('fr');
    // 2026-03-29 is the EU spring-forward date; 2026-11-01 the US fall-back.
    assert.equal(updateCardState(state, false, '2026-03-28').dueDate, '2026-03-29');
    assert.equal(updateCardState(state, false, '2026-10-31').dueDate, '2026-11-01');
    assert.equal(updateCardState(state, false, '2026-12-31').dueDate, '2027-01-01');
    assert.equal(updateCardState(state, false, '2028-02-28').dueDate, '2028-02-29');
    const sixDays = updateCardState({ ...state, repetitions: 1, intervalDays: 1, dueDate: TODAY }, true, '2026-03-27');
    assert.equal(sixDays.dueDate, '2026-04-02');
  });

  it('grows the interval by at least a day even from a short repaired interval', () => {
    const start = makeState('fr', { repetitions: 3, intervalDays: 1, easeFactor: MIN_EASE_FACTOR });
    const intervals = answerRepeatedly(true, 6, start).map((s) => s.intervalDays);
    // round(1 x 1.3) = 1 would stall without the +1 floor; ease also rises 0.05 per answer.
    assert.deepEqual(intervals, [2, 3, 4, 6, 9, 14]);
  });

  it(`clamps computed due dates to ${MAX_DATE}`, () => {
    const lapsed = updateCardState(createCardState('fr'), false, MAX_DATE);
    assert.equal(lapsed.dueDate, MAX_DATE);
    const mature = makeState('fr', { intervalDays: 300, easeFactor: MAX_EASE_FACTOR });
    assert.equal(updateCardState(mature, true, '9999-06-01').dueDate, MAX_DATE);
    // ...and the clamped state is still accepted everywhere.
    assert.doesNotThrow(() => updateCardState(lapsed, true, MAX_DATE));
  });

  it('computes the same due dates under DST-observing local time zones', () => {
    // Local-time day arithmetic (e.g. `new Date(y, m, d)` + 24h) goes wrong on
    // 25-hour fall-back days; run the engine in a child process with `TZ` set.
    const script = `
      import { createCardState, updateCardState } from ${JSON.stringify(new URL('../js/srs.js', import.meta.url).href)};
      const fresh = createCardState('fr');
      const second = { ...fresh, repetitions: 1, intervalDays: 1, dueDate: '2026-01-01' };
      console.log(JSON.stringify([
        updateCardState(fresh, false, '2026-11-01').dueDate,
        updateCardState(fresh, false, '2026-03-08').dueDate,
        updateCardState(second, true, '2026-10-30').dueDate,
        updateCardState(fresh, false, '2026-10-25').dueDate,
        updateCardState(second, true, '2026-03-27').dueDate
      ]));
    `;
    const expected = ['2026-11-02', '2026-03-09', '2026-11-05', '2026-10-26', '2026-04-02'];
    for (const tz of ['America/New_York', 'Europe/London', 'Australia/Lord_Howe']) {
      const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        env: { ...process.env, TZ: tz },
        encoding: 'utf8'
      });
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout), expected, `TZ=${tz}`);
    }
  });

  it('does not mutate its input', () => {
    const state = makeState('fr');
    const snapshot = structuredClone(state);
    updateCardState(state, true, TODAY);
    updateCardState(state, false, TODAY);
    assert.deepEqual(state, snapshot);
  });

  it('rejects invalid input', () => {
    const state = makeState('fr');
    assert.throws(() => updateCardState(null, true, TODAY), TypeError);
    assert.throws(() => updateCardState({ ...state, repetitions: -1 }, true, TODAY), TypeError);
    assert.throws(() => updateCardState({ ...state, easeFactor: 9 }, true, TODAY), RangeError);
    assert.throws(() => updateCardState({ ...state, dueDate: 'tomorrow' }, true, TODAY), TypeError);
    assert.throws(() => updateCardState(state, 1, TODAY), TypeError);
    assert.throws(() => updateCardState(state, true, '2026-02-30'), TypeError);
    assert.throws(() => updateCardState(state, true, '26-03-28'), TypeError);
    assert.throws(() => updateCardState(state, true, new Date()), TypeError);
  });
});

// ---- Re-queue ----

describe('requeueLapse', () => {
  it(`re-inserts the missed code after ${REQUEUE_GAP} other questions by default`, () => {
    assert.deepEqual(requeueLapse(['a', 'b', 'c', 'd', 'e'], 'x'), ['a', 'b', 'c', 'x', 'd', 'e']);
  });

  it('honours a custom gap', () => {
    assert.deepEqual(requeueLapse(['a', 'b', 'c'], 'x', 1), ['a', 'x', 'b', 'c']);
  });

  it('clamps to the end of a short queue', () => {
    assert.deepEqual(requeueLapse(['a'], 'x'), ['a', 'x']);
    assert.deepEqual(requeueLapse([], 'x'), ['x']);
  });

  it('never duplicates a code already in the queue', () => {
    assert.deepEqual(requeueLapse(['x', 'a', 'b', 'c', 'd'], 'x'), ['a', 'b', 'c', 'x', 'd']);
  });

  it('does not mutate its input', () => {
    const queue = ['a', 'b', 'c'];
    requeueLapse(queue, 'x');
    assert.deepEqual(queue, ['a', 'b', 'c']);
  });

  it('rejects invalid input', () => {
    assert.throws(() => requeueLapse('abc', 'x'), TypeError);
    assert.throws(() => requeueLapse([1, 2], 'x'), TypeError);
    assert.throws(() => requeueLapse([], ''), TypeError);
    assert.throws(() => requeueLapse([], 'x', 0), RangeError);
    assert.throws(() => requeueLapse([], 'x', 1.5), RangeError);
  });
});

// ---- Scheduling ----

describe('pickRound', () => {
  it(`returns ${ROUND_SIZE} distinct codes by default`, () => {
    const countries = makeCountries('c', 50);
    const states = toStates(countries.slice(0, 30).map((c) => makeState(c.code)));
    for (let seed = 1; seed <= 200; seed += 1) {
      const round = pickRound({ states, countries, today: TODAY, rng: createRng(seed) });
      assert.equal(round.length, ROUND_SIZE);
      assert.equal(new Set(round).size, ROUND_SIZE);
    }
  });

  it('is deterministic for a given seed', () => {
    const countries = makeCountries('c', 50);
    const options = { states: {}, countries, today: TODAY };
    assert.deepEqual(
      pickRound({ ...options, rng: createRng(7) }),
      pickRound({ ...options, rng: createRng(7) })
    );
  });

  it('returns fewer than n only when the scope is smaller than n', () => {
    const countries = makeCountries('c', 4);
    const states = { c0: makeState('c0', { dueDate: '2026-06-01' }) };
    const round = pickRound({ states, countries, today: TODAY, rng: createRng(1) });
    assert.equal(round.length, 4);
    assert.deepEqual([...round].sort(), ['c0', 'c1', 'c2', 'c3']);
  });

  it('fills a brand-new user\'s round entirely from never-seen flags', () => {
    const countries = makeCountries('c', 200);
    const round = pickRound({ states: {}, countries, today: TODAY, rng: createRng(3) });
    assert.equal(round.length, ROUND_SIZE);
    assert.equal(new Set(round).size, ROUND_SIZE);
  });

  it('counts duplicate countries once and ignores states outside the data', () => {
    const countries = [...makeCountries('c', 3), ...makeCountries('c', 3)];
    const states = { zz: makeState('zz') };
    const round = pickRound({ states, countries, today: TODAY, rng: createRng(1) });
    assert.deepEqual([...round].sort(), ['c0', 'c1', 'c2']);
  });

  it('returns an empty round for an empty scope', () => {
    const countries = makeCountries('eu', 5, 'europe');
    assert.deepEqual(pickRound({ states: {}, countries: [], today: TODAY, rng: createRng(1) }), []);
    assert.deepEqual(pickRound({ states: {}, countries, today: TODAY, region: 'asia', rng: createRng(1) }), []);
  });

  it('rejects a state whose `code` disagrees with its key', () => {
    const countries = [{ code: 'fr', region: 'europe' }, { code: 'de', region: 'europe' }];
    const duplicated = { fr: makeState('de'), de: makeState('de') };
    const foreign = { fr: makeState('jp') };
    for (const fn of [pickRound, countDue]) {
      assert.throws(() => fn({ states: duplicated, countries, today: TODAY, rng: createRng(1) }), TypeError);
      assert.throws(
        () => fn({ states: foreign, countries, today: TODAY, region: 'europe', rng: createRng(1) }),
        TypeError
      );
      assert.throws(
        () => fn({ states: { fr: createCardState('de') }, countries, today: TODAY, rng: createRng(1) }),
        TypeError
      );
    }
  });

  it('scopes to a region', () => {
    const countries = [
      ...makeCountries('eu', 20, 'europe'),
      ...makeCountries('af', 20, 'africa'),
      ...makeCountries('oc', 5, 'oceania')
    ];
    const states = toStates(countries.map((c) => makeState(c.code)));
    for (let seed = 1; seed <= 100; seed += 1) {
      const round = pickRound({ states, countries, today: TODAY, region: 'africa', rng: createRng(seed) });
      assert.equal(round.length, ROUND_SIZE);
      assert.ok(round.every((code) => code.startsWith('af')));
    }
    const oceania = pickRound({ states, countries, today: TODAY, region: 'oceania', rng: createRng(1) });
    assert.deepEqual([...oceania].sort(), ['oc0', 'oc1', 'oc2', 'oc3', 'oc4']);
  });

  it('fills a short round with never-seen flags before not-yet-due ones (GitHub #32)', () => {
    const due = makeCountries('due', 5);
    const later = makeCountries('later', 20);
    const fresh = makeCountries('new', 100);
    const countries = [...due, ...later, ...fresh];
    const states = toStates([
      ...due.map((c) => makeState(c.code)),
      ...later.map((c) => makeState(c.code, { dueDate: '2026-04-10' }))
    ]);
    for (let seed = 1; seed <= 200; seed += 1) {
      const round = pickRound({ states, countries, today: TODAY, rng: createRng(seed) });
      // Tier 1 (5 due + 3 trickle) is smaller than the round, so all of it is
      // picked and the rest comes from further never-seen flags, not from the
      // not-yet-due seen ones.
      assert.equal(round.filter((code) => code.startsWith('due')).length, 5);
      assert.equal(round.filter((code) => code.startsWith('new')).length, ROUND_SIZE - 5);
      assert.equal(round.filter((code) => code.startsWith('later')).length, 0);
    }
  });

  it('falls back to not-yet-due flags only once the scope has no never-seen flags left', () => {
    const due = makeCountries('due', 2);
    const later = makeCountries('later', 20);
    const fresh = makeCountries('new', 4);
    const countries = [...due, ...later, ...fresh];
    const states = toStates([
      ...due.map((c) => makeState(c.code)),
      ...later.map((c) => makeState(c.code, { dueDate: '2026-04-10' }))
    ]);
    for (let seed = 1; seed <= 200; seed += 1) {
      const round = pickRound({ states, countries, today: TODAY, rng: createRng(seed) });
      assert.equal(round.filter((code) => code.startsWith('due')).length, 2);
      assert.equal(round.filter((code) => code.startsWith('new')).length, 4);
      assert.equal(round.filter((code) => code.startsWith('later')).length, ROUND_SIZE - 6);
    }
  });

  it('never exceeds the trickle when many flags are due', () => {
    const due = makeCountries('due', 40);
    const fresh = makeCountries('new', 100);
    const states = toStates(due.map((c) => makeState(c.code)));
    let totalNew = 0;
    for (let seed = 1; seed <= 500; seed += 1) {
      const round = pickRound({ states, countries: [...due, ...fresh], today: TODAY, rng: createRng(seed) });
      const newInRound = round.filter((code) => code.startsWith('new')).length;
      assert.ok(newInRound <= NEW_FLAG_LIMIT);
      totalNew += newInRound;
    }
    // ...but new flags do still get introduced.
    assert.ok(totalNew > 0);
  });

  it('favours overdue flags', () => {
    const overdue = makeCountries('late', 10);
    const onTime = makeCountries('ontime', 10);
    const states = toStates([
      ...overdue.map((c) => makeState(c.code, { dueDate: '2026-03-18' })),
      ...onTime.map((c) => makeState(c.code))
    ]);
    const counts = countPicks({ states, countries: [...overdue, ...onTime], today: TODAY, n: 5 });
    const lateTotal = sumCounts(counts, overdue.map((c) => c.code));
    const onTimeTotal = sumCounts(counts, onTime.map((c) => c.code));
    // 10 days overdue weighs 3.5x a flag due today; without replacement the
    // observed pick ratio is lower but should still be well above 2.
    assert.ok(lateTotal / onTimeTotal > 2, `ratio was ${(lateTotal / onTimeTotal).toFixed(2)}`);
  });

  it('favours low-ease, high-lapse flags', () => {
    const hard = makeCountries('hard', 10);
    const easy = makeCountries('easy', 10);
    const states = toStates([
      ...hard.map((c) => makeState(c.code, { easeFactor: MIN_EASE_FACTOR, lapses: 4 })),
      ...easy.map((c) => makeState(c.code, { easeFactor: MAX_EASE_FACTOR }))
    ]);
    const counts = countPicks({ states, countries: [...hard, ...easy], today: TODAY, n: 5 });
    const hardTotal = sumCounts(counts, hard.map((c) => c.code));
    const easyTotal = sumCounts(counts, easy.map((c) => c.code));
    // Hard flags weigh 5x the easy ones.
    assert.ok(hardTotal / easyTotal > 2.5, `ratio was ${(hardTotal / easyTotal).toFixed(2)}`);
    // Lapses alone also raise the weight.
    const lapsed = makeCountries('lapsed', 10);
    const clean = makeCountries('clean', 10);
    const lapseStates = toStates([
      ...lapsed.map((c) => makeState(c.code, { lapses: 4 })),
      ...clean.map((c) => makeState(c.code))
    ]);
    const lapseCounts = countPicks({ states: lapseStates, countries: [...lapsed, ...clean], today: TODAY, n: 5 });
    assert.ok(
      sumCounts(lapseCounts, lapsed.map((c) => c.code)) > 1.3 * sumCounts(lapseCounts, clean.map((c) => c.code))
    );
  });

  it('still picks mastered, not-yet-due flags to fill a round', () => {
    const due = makeCountries('due', 3);
    const mastered = makeCountries('m', 30);
    const states = toStates([
      ...due.map((c) => makeState(c.code)),
      ...mastered.map((c) => makeState(c.code, {
        easeFactor: MAX_EASE_FACTOR,
        intervalDays: MAX_INTERVAL_DAYS,
        dueDate: '2026-12-01'
      }))
    ]);
    const counts = countPicks({ states, countries: [...due, ...mastered], today: TODAY }, 500);
    // Every mastered flag gets picked at least sometimes: never fully starved.
    assert.ok(mastered.every((c) => (counts.get(c.code) ?? 0) > 0));
    // Due flags fill first: every round contains all of them.
    assert.ok(due.every((c) => counts.get(c.code) === 500));
  });

  it('lets a long-overdue mastered flag compete with a backlog of hard flags', () => {
    const hard = makeCountries('hard', 50);
    const states = toStates([
      ...hard.map((c) => makeState(c.code, { easeFactor: MIN_EASE_FACTOR, lapses: 2 })),
      makeState('master', { easeFactor: MAX_EASE_FACTOR, intervalDays: 200, dueDate: '2026-01-01' })
    ]);
    const countries = [...hard, { code: 'master', region: 'europe' }];
    const counts = countPicks({ states, countries, today: TODAY }, 1_000);
    const hardMean = sumCounts(counts, hard.map((c) => c.code)) / hard.length;
    assert.ok((counts.get('master') ?? 0) > hardMean, 'overdue mastered flag should be picked more than average');
  });

  it('does not mutate its inputs', () => {
    const countries = makeCountries('c', 30);
    const states = toStates(countries.slice(0, 20).map((c, i) => makeState(c.code, {
      dueDate: i % 2 === 0 ? TODAY : '2026-05-01'
    })));
    const statesSnapshot = structuredClone(states);
    const countriesSnapshot = structuredClone(countries);
    pickRound({ states, countries, today: TODAY, rng: createRng(1) });
    countDue({ states, countries, today: TODAY });
    assert.deepEqual(states, statesSnapshot);
    assert.deepEqual(countries, countriesSnapshot);
  });

  it('rejects invalid input', () => {
    const countries = makeCountries('c', 5);
    const base = { states: {}, countries, today: TODAY, rng: createRng(1) };
    assert.throws(() => pickRound(), TypeError);
    assert.throws(() => pickRound({ ...base, states: [] }), TypeError);
    assert.throws(() => pickRound({ ...base, countries: {} }), TypeError);
    assert.throws(() => pickRound({ ...base, countries: [{ code: 'c0' }] }), TypeError);
    assert.throws(() => pickRound({ ...base, today: '2026-13-01' }), TypeError);
    assert.throws(() => pickRound({ ...base, region: 'antarctica' }), RangeError);
    assert.throws(() => pickRound({ ...base, rng: Math.random() }), TypeError);
    assert.throws(() => pickRound({ ...base, rng: () => 1 }), RangeError);
    assert.throws(() => pickRound({ ...base, n: 0 }), RangeError);
    assert.throws(() => pickRound({ ...base, n: 2.5 }), RangeError);
    assert.throws(() => pickRound({ ...base, states: { c0: { code: 'c0' } } }), TypeError);
  });
});

// ---- Due count ----

describe('countDue', () => {
  const countries = [
    ...makeCountries('eu', 6, 'europe'),
    ...makeCountries('as', 4, 'asia')
  ];
  const states = toStates([
    makeState('eu0', { dueDate: '2026-03-01' }),
    makeState('eu1'),
    makeState('eu2', { dueDate: '2026-03-29' }),
    makeState('as0'),
    createCardState('as1')
  ]);

  it('counts due and never-seen flags separately', () => {
    assert.deepEqual(countDue({ states, countries, today: TODAY }), { due: 3, new: 6 });
  });

  it('scopes to a region', () => {
    assert.deepEqual(countDue({ states, countries, today: TODAY, region: 'europe' }), { due: 2, new: 3 });
    assert.deepEqual(countDue({ states, countries, today: TODAY, region: 'asia' }), { due: 1, new: 3 });
    assert.deepEqual(countDue({ states, countries, today: TODAY, region: 'oceania' }), { due: 0, new: 0 });
  });

  it('rejects invalid input', () => {
    assert.throws(() => countDue(), TypeError);
    assert.throws(() => countDue({ states, countries, today: 'today' }), TypeError);
    assert.throws(() => countDue({ states, countries, today: TODAY, region: 'Europe' }), RangeError);
  });
});

// ---- Sanitizer ----

describe('sanitizeStates', () => {
  it('returns an empty map for non-object input', () => {
    for (const raw of [null, undefined, 42, 'x', [], [makeState('fr')]]) {
      assert.deepEqual(sanitizeStates(raw), {});
    }
  });

  it('keeps valid entries unchanged', () => {
    const states = toStates([makeState('fr'), makeState('gb-eng', { lapses: 2 })]);
    assert.deepEqual(sanitizeStates(states), states);
  });

  it('drops malformed entries', () => {
    const raw = {
      fr: makeState('fr'),
      de: 'not an object',
      it: makeState('es'),
      'bad key!': makeState('bad key!'),
      nl: makeState('nl', { dueDate: '2026-02-31' }),
      be: makeState('be', { dueDate: undefined })
    };
    assert.deepEqual(Object.keys(sanitizeStates(raw)), ['fr']);
  });

  it('repairs fixable entries', () => {
    const raw = {
      fr: { dueDate: TODAY, repetitions: 2.7, easeFactor: 9, intervalDays: -4, lapses: 'x', extra: true },
      de: { code: 'de', dueDate: null, repetitions: 5 },
      es: makeState('es', { easeFactor: 0.2, intervalDays: 10_000 })
    };
    assert.deepEqual(sanitizeStates(raw), {
      fr: { code: 'fr', repetitions: 2, easeFactor: MAX_EASE_FACTOR, intervalDays: 1, dueDate: TODAY, lapses: 0 },
      de: createCardState('de'),
      es: makeState('es', { easeFactor: MIN_EASE_FACTOR, intervalDays: MAX_INTERVAL_DAYS })
    });
  });

  it('pulls an implausibly far-future `dueDate` back when `today` is given', () => {
    const raw = { fr: makeState('fr', { dueDate: '9999-01-01' }), de: makeState('de', { dueDate: '2026-04-01' }) };
    assert.equal(sanitizeStates(raw).fr.dueDate, '9999-01-01');
    const repaired = sanitizeStates(raw, TODAY);
    assert.equal(repaired.fr.dueDate, '2027-03-28');
    assert.equal(repaired.de.dueDate, '2026-04-01');
    assert.throws(() => sanitizeStates(raw, 'today'), TypeError);
  });

  it('produces states the other functions accept', () => {
    const raw = JSON.parse('{"fr":{"dueDate":"2026-03-01","easeFactor":"2.5"},"__proto__":{"dueDate":"2026-03-01"}}');
    const states = sanitizeStates(raw);
    assert.deepEqual(Object.keys(states), ['fr']);
    assert.equal(Object.getPrototypeOf(states), Object.prototype);
    const countries = [{ code: 'fr', region: 'europe' }];
    assert.deepEqual(countDue({ states, countries, today: TODAY }), { due: 1, new: 0 });
    assert.doesNotThrow(() => updateCardState(states.fr, true, TODAY));
  });

  it('does not mutate its input', () => {
    const raw = { fr: { dueDate: TODAY, easeFactor: 9 } };
    const snapshot = structuredClone(raw);
    sanitizeStates(raw);
    assert.deepEqual(raw, snapshot);
  });
});
