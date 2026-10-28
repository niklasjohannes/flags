import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REGIONS } from '../js/srs.js';
import {
  createTestPass,
  formatScore,
  getScopeCodes,
  isPassComplete,
  recordAnswer,
  scorePass
} from '../js/test-pass.js';

// ---- Helpers ----

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { countries } = JSON.parse(readFileSync(join(REPO_ROOT, 'data', 'countries.json'), 'utf8'));

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

const SMALL = Object.freeze([
  { code: 'fr', name: 'France', region: 'europe' },
  { code: 'de', name: 'Germany', region: 'europe' },
  { code: 'it', name: 'Italy', region: 'europe' },
  { code: 'br', name: 'Brazil', region: 'south-america' }
]);

// Answer every flag of `pass`, correctly unless its code is in `wrong`
// (code -> chosen code).
function answerAll(pass, wrong = {}) {
  let current = pass;
  for (const code of pass.codes) {
    current = recordAnswer(current, wrong[code] ?? code);
  }
  return current;
}

// ---- getScopeCodes ----

describe('getScopeCodes', () => {
  it('returns every flag for All', () => {
    assert.deepEqual(getScopeCodes({ countries, region: null }), countries.map((country) => country.code));
  });

  it('returns only the region\'s flags, in data order', () => {
    for (const region of REGIONS) {
      const expected = countries.filter((country) => country.region === region).map((country) => country.code);
      assert.ok(expected.length > 0, region);
      assert.deepEqual(getScopeCodes({ countries, region }), expected, region);
    }
  });

  it('partitions All across the regions', () => {
    const total = REGIONS.reduce((sum, region) => sum + getScopeCodes({ countries, region }).length, 0);
    assert.equal(total, countries.length);
  });

  it('rejects bad arguments', () => {
    assert.throws(() => getScopeCodes(), TypeError);
    assert.throws(() => getScopeCodes({ countries: 'x', region: null }), TypeError);
    assert.throws(() => getScopeCodes({ countries: [{ code: 'fr' }], region: null }), /`countries\[0\]`/);
    assert.throws(() => getScopeCodes({ countries, region: 'atlantis' }), RangeError);
    assert.throws(() => getScopeCodes({ countries, region: undefined }), RangeError);
  });
});

// ---- createTestPass ----

describe('createTestPass', () => {
  it('asks every flag in scope exactly once', () => {
    for (const region of [null, ...REGIONS]) {
      const pass = createTestPass({ countries, region, rng: createRng(1) });
      const scope = getScopeCodes({ countries, region });
      assert.equal(pass.codes.length, scope.length, String(region));
      assert.deepEqual([...pass.codes].sort(), [...scope].sort(), String(region));
      assert.equal(pass.region, region);
      assert.deepEqual(pass.answers, []);
    }
  });

  it('shuffles with the injected rng: same seed, same order', () => {
    const a = createTestPass({ countries, region: null, rng: createRng(7) });
    const b = createTestPass({ countries, region: null, rng: createRng(7) });
    const c = createTestPass({ countries, region: null, rng: createRng(8) });
    assert.deepEqual(a.codes, b.codes);
    assert.notDeepEqual(a.codes, c.codes);
    assert.notDeepEqual(a.codes, getScopeCodes({ countries, region: null }));
  });

  it('puts every flag at every position about equally often', () => {
    const runs = 8_000;
    const size = SMALL.length;
    // counts[position][code], and how often each full order came up.
    const counts = Array.from({ length: size }, () => new Map(SMALL.map((country) => [country.code, 0])));
    const orders = new Map();
    for (let seed = 1; seed <= runs; seed += 1) {
      const { codes } = createTestPass({ countries: SMALL, region: null, rng: createRng(seed) });
      codes.forEach((code, position) => counts[position].set(code, counts[position].get(code) + 1));
      orders.set(codes.join(','), (orders.get(codes.join(',')) ?? 0) + 1);
    }
    // Expected share 1/4 per cell, sd ~0.005 over 8,000 runs.
    counts.forEach((byCode, position) => {
      for (const [code, count] of byCode) {
        assert.ok(Math.abs(count / runs - 1 / size) < 0.02, `${code} at ${position}: ${count}`);
      }
    });
    // All 4! = 24 orders, each about 1/24 of the runs (sd ~18).
    assert.equal(orders.size, 24);
    for (const [order, count] of orders) {
      assert.ok(Math.abs(count - runs / 24) < 100, `${order}: ${count}`);
    }
  });

  it('keeps an rng of all zeros and of just-under-one in range', () => {
    for (const value of [0, 1 - Number.EPSILON]) {
      const pass = createTestPass({ countries: SMALL, region: null, rng: () => value });
      assert.deepEqual([...pass.codes].sort(), ['br', 'de', 'fr', 'it']);
    }
  });

  it('returns a frozen pass and leaves `countries` alone', () => {
    const before = JSON.stringify(SMALL);
    const pass = createTestPass({ countries: SMALL, region: 'europe', rng: createRng(3) });
    assert.ok(Object.isFrozen(pass));
    assert.ok(Object.isFrozen(pass.codes));
    assert.ok(Object.isFrozen(pass.answers));
    assert.equal(JSON.stringify(SMALL), before);
  });

  it('rejects bad arguments', () => {
    assert.throws(() => createTestPass({ countries, region: null }), TypeError);
    assert.throws(() => createTestPass({ countries, region: null, rng: () => 1 }), RangeError);
    assert.throws(() => createTestPass({ countries, region: null, rng: () => -0.1 }), RangeError);
    assert.throws(() => createTestPass({ countries, region: null, rng: () => NaN }), RangeError);
    assert.throws(() => createTestPass({ countries: SMALL, region: 'asia', rng: createRng(1) }), /at least one flag/);
    assert.throws(() => createTestPass({ countries, region: 'atlantis', rng: createRng(1) }), RangeError);
  });
});

// ---- recordAnswer / isPassComplete ----

describe('recordAnswer', () => {
  it('records answers in asking order without changing the old pass', () => {
    const pass = createTestPass({ countries: SMALL, region: null, rng: createRng(5) });
    const once = recordAnswer(pass, 'fr');
    const twice = recordAnswer(once, 'xx');
    assert.deepEqual(pass.answers, []);
    assert.deepEqual(once.answers, ['fr']);
    assert.deepEqual(twice.answers, ['fr', 'xx']);
    assert.deepEqual(twice.codes, pass.codes);
    assert.equal(twice.region, null);
    assert.ok(Object.isFrozen(twice) && Object.isFrozen(twice.answers));
  });

  it('completes after one answer per flag, then refuses more', () => {
    const pass = createTestPass({ countries: SMALL, region: null, rng: createRng(5) });
    let current = pass;
    for (let i = 0; i < pass.codes.length; i += 1) {
      assert.equal(isPassComplete(current), false);
      current = recordAnswer(current, pass.codes[i]);
    }
    assert.equal(isPassComplete(current), true);
    assert.throws(() => recordAnswer(current, 'fr'), /already complete/);
  });

  it('rejects bad arguments', () => {
    const pass = createTestPass({ countries: SMALL, region: null, rng: createRng(5) });
    assert.throws(() => recordAnswer(pass, ''), TypeError);
    assert.throws(() => recordAnswer(pass, null), TypeError);
    assert.throws(() => recordAnswer({}, 'fr'), TypeError);
    assert.throws(() => recordAnswer({ ...pass, region: 'atlantis' }, 'fr'), RangeError);
    assert.throws(() => recordAnswer({ ...pass, answers: ['fr', 'de', 'it', 'br', 'fr'] }, 'fr'), TypeError);
    assert.throws(() => isPassComplete(null), TypeError);
  });
});

// ---- scorePass / formatScore ----

describe('scorePass', () => {
  it('scores a perfect pass', () => {
    const pass = answerAll(createTestPass({ countries, region: 'south-america', rng: createRng(9) }));
    const score = scorePass(pass, countries);
    assert.equal(score.total, 13);
    assert.equal(score.correct, 13);
    assert.equal(score.percent, 100);
    assert.deepEqual(score.missed, []);
  });

  it('lists exactly the missed flags, in asking order, with both names', () => {
    const pass = createTestPass({ countries: SMALL, region: null, rng: createRng(11) });
    const [first, , third] = pass.codes;
    const otherThan = (code) => pass.codes.find((other) => other !== code);
    const done = answerAll(pass, { [first]: otherThan(first), [third]: otherThan(third) });
    const score = scorePass(done, SMALL);
    const name = (code) => SMALL.find((country) => country.code === code).name;
    assert.equal(score.total, 4);
    assert.equal(score.correct, 2);
    assert.equal(score.percent, 50);
    assert.deepEqual(score.missed.map((miss) => miss.code), [first, third]);
    for (const miss of score.missed) {
      assert.equal(miss.name, name(miss.code));
      assert.equal(miss.chosenName, name(miss.chosenCode));
      assert.notEqual(miss.chosenCode, miss.code);
    }
    assert.ok(Object.isFrozen(score) && Object.isFrozen(score.missed) && Object.isFrozen(score.missed[0]));
  });

  it('rounds the percentage down, so only a perfect pass shows 100%', () => {
    const pass = createTestPass({ countries, region: null, rng: createRng(2) });
    const almost = scorePass(answerAll(pass, { [pass.codes[0]]: pass.codes[1] }), countries);
    assert.equal(almost.total, countries.length);
    assert.equal(almost.correct, countries.length - 1);
    assert.equal(almost.percent, Math.floor(((countries.length - 1) * 100) / countries.length));
    assert.ok(almost.percent < 100);
  });

  it('rejects incomplete passes and unknown codes', () => {
    const pass = createTestPass({ countries: SMALL, region: null, rng: createRng(1) });
    assert.throws(() => scorePass(pass, SMALL), /must be complete/);
    assert.throws(() => scorePass(answerAll(pass, { [pass.codes[0]]: 'zz' }), SMALL), /`zz`/);
    assert.throws(() => scorePass(answerAll(pass), 'x'), TypeError);
  });
});

describe('formatScore', () => {
  it('formats as correct/total · percent', () => {
    assert.equal(formatScore({ correct: 182, total: 195, percent: 93 }), '182/195 · 93%');
    const score = scorePass(answerAll(createTestPass({ countries: SMALL, region: null, rng: createRng(1) })), SMALL);
    assert.equal(formatScore(score), '4/4 · 100%');
  });

  it('rejects anything that is not a score', () => {
    assert.throws(() => formatScore(), TypeError);
    assert.throws(() => formatScore({ correct: 5, total: 4, percent: 100 }), TypeError);
    assert.throws(() => formatScore({ correct: '1', total: 4, percent: 25 }), TypeError);
  });
});
