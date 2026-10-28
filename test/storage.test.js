import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MODE,
  MODE_STORAGE_KEY,
  SRS_STORAGE_KEY,
  loadMode,
  loadStates,
  localToday,
  saveMode,
  saveStates
} from '../js/storage.js';
import { createCardState, updateCardState } from '../js/srs.js';

// ---- Helpers ----

const TODAY = '2026-10-28';

// Minimal in-memory stand-in for `localStorage`.
class FakeStorage {
  constructor(entries = {}) {
    this.items = new Map(Object.entries(entries));
  }

  getItem(key) {
    return this.items.has(key) ? this.items.get(key) : null;
  }

  setItem(key, value) {
    this.items.set(key, String(value));
  }
}

// Every access throws, like blocked storage or a full quota.
class ThrowingStorage {
  getItem() {
    throw new Error('SecurityError: storage is blocked');
  }

  setItem() {
    throw new Error('QuotaExceededError: storage is full');
  }
}

function makeStates() {
  return {
    fr: updateCardState(createCardState('fr'), true, TODAY),
    de: updateCardState(createCardState('de'), false, TODAY)
  };
}

// ---- localToday ----

describe('localToday', () => {
  it('formats the local calendar date as YYYY-MM-DD', () => {
    assert.equal(localToday(new Date(2026, 9, 28, 12, 0)), '2026-10-28');
  });

  it('zero-pads single-digit months and days', () => {
    assert.equal(localToday(new Date(2026, 0, 5)), '2026-01-05');
  });

  it('uses local time, not UTC, at the edges of the day', () => {
    assert.equal(localToday(new Date(2026, 2, 1, 0, 0, 0)), '2026-03-01');
    assert.equal(localToday(new Date(2026, 1, 28, 23, 59, 59)), '2026-02-28');
  });

  it('defaults to the current date', () => {
    assert.match(localToday(), /^\d{4}-\d{2}-\d{2}$/);
  });

  it('rejects anything that is not a valid Date', () => {
    assert.throws(() => localToday('2026-10-28'), TypeError);
    assert.throws(() => localToday(new Date('not a date')), TypeError);
  });
});

// ---- SRS state ----

describe('loadStates / saveStates', () => {
  it('round-trips card states', () => {
    const storage = new FakeStorage();
    const states = makeStates();
    assert.equal(saveStates(states, storage), true);
    assert.deepEqual(loadStates(TODAY, storage), states);
  });

  it('stores the map as JSON under the versioned key', () => {
    const storage = new FakeStorage();
    const states = makeStates();
    saveStates(states, storage);
    assert.deepEqual(JSON.parse(storage.getItem(SRS_STORAGE_KEY)), states);
  });

  it('gives an empty map when nothing is stored', () => {
    assert.deepEqual(loadStates(TODAY, new FakeStorage()), {});
  });

  it('gives an empty map for corrupt JSON', () => {
    const storage = new FakeStorage({ [SRS_STORAGE_KEY]: '{"fr": {"code": "fr",' });
    assert.deepEqual(loadStates(TODAY, storage), {});
  });

  it('gives an empty map for valid JSON that is not a state map', () => {
    for (const text of ['null', '42', '"text"', '[1, 2]']) {
      const storage = new FakeStorage({ [SRS_STORAGE_KEY]: text });
      assert.deepEqual(loadStates(TODAY, storage), {}, text);
    }
  });

  it('sanitizes what it loads', () => {
    const states = makeStates();
    const storage = new FakeStorage({
      [SRS_STORAGE_KEY]: JSON.stringify({
        ...states,
        xx: { code: 'yy', dueDate: TODAY },
        es: { ...states.fr, code: 'es', dueDate: '9999-01-01', extra: true }
      })
    });
    const loaded = loadStates(TODAY, storage);
    assert.deepEqual(Object.keys(loaded).sort(), ['de', 'es', 'fr']);
    assert.equal(loaded.es.dueDate, '2027-10-28');
    assert.equal('extra' in loaded.es, false);
  });

  it('does not crash when storage throws', () => {
    const storage = new ThrowingStorage();
    assert.deepEqual(loadStates(TODAY, storage), {});
    assert.equal(saveStates(makeStates(), storage), false);
  });

  it('treats `null` storage as unavailable', () => {
    assert.deepEqual(loadStates(TODAY, null), {});
    assert.equal(saveStates(makeStates(), null), false);
  });

  it('rejects invalid arguments', () => {
    const storage = new FakeStorage();
    assert.throws(() => loadStates('28/10/2026', storage), TypeError);
    assert.throws(() => saveStates(null, storage), TypeError);
    assert.throws(() => saveStates([], storage), TypeError);
    assert.throws(() => loadStates(TODAY, {}), TypeError);
  });
});

// ---- Mode preference ----

describe('loadMode / saveMode', () => {
  it('round-trips the mode', () => {
    const storage = new FakeStorage();
    assert.equal(saveMode('typing', storage), true);
    assert.equal(storage.getItem(MODE_STORAGE_KEY), 'typing');
    assert.equal(loadMode(storage), 'typing');
  });

  it('falls back to the default when nothing valid is stored', () => {
    assert.equal(loadMode(new FakeStorage()), DEFAULT_MODE);
    assert.equal(loadMode(new FakeStorage({ [MODE_STORAGE_KEY]: 'speed-run' })), DEFAULT_MODE);
  });

  it('does not crash when storage throws', () => {
    assert.equal(loadMode(new ThrowingStorage()), DEFAULT_MODE);
    assert.equal(saveMode('mc', new ThrowingStorage()), false);
  });

  it('rejects an unknown mode', () => {
    assert.throws(() => saveMode('speed-run', new FakeStorage()), RangeError);
  });
});

// ---- Default storage (globalThis.localStorage) ----

describe('default storage', () => {
  let original;

  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  });

  afterEach(() => {
    if (original === undefined) {
      delete globalThis.localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', original);
    }
  });

  it('uses `globalThis.localStorage` when no storage is passed', () => {
    const storage = new FakeStorage();
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
    saveMode('typing');
    assert.equal(storage.getItem(MODE_STORAGE_KEY), 'typing');
    assert.equal(loadMode(), 'typing');
  });

  it('survives `localStorage` being missing', () => {
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
    assert.deepEqual(loadStates(TODAY), {});
    assert.equal(saveStates(makeStates()), false);
    assert.equal(loadMode(), DEFAULT_MODE);
  });

  it('survives reading `localStorage` itself throwing (blocked site data)', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      get() {
        throw new Error('SecurityError: access denied');
      },
      configurable: true
    });
    assert.deepEqual(loadStates(TODAY), {});
    assert.equal(saveStates(makeStates()), false);
    assert.equal(saveMode('mc'), false);
  });
});
