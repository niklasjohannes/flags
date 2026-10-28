// When the page reloads after a service-worker update (js/update-reload.js,
// GitHub #29), and the rule that makes a resume a fresh open
// (js/resume.js, GitHub #33). Both are pure, so no DOM is needed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RESUME_RESET_MS, isStaleResume } from '../js/resume.js';
import { RELOAD_EVENTS, createReloadState, decideReload } from '../js/update-reload.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ON_HOME = Object.freeze({ isOnHome: true, hasOpenDialog: false });
const HOME_WITH_SHEET = Object.freeze({ isOnHome: true, hasOpenDialog: true });
const IN_ROUND = Object.freeze({ isOnHome: false, hasOpenDialog: false });
const IN_TEST_WITH_SHEET = Object.freeze({ isOnHome: false, hasOpenDialog: true });

// Feed `[event, view]` pairs in order; returns the final state and which
// steps reloaded.
function run(hadController, steps) {
  let state = createReloadState(hadController);
  const reloads = [];
  steps.forEach(([event, view], index) => {
    const decision = decideReload(state, event, view);
    state = decision.state;
    if (decision.reload) {
      reloads.push(index);
    }
  });
  return { state, reloads };
}

describe('decideReload', () => {
  it('ignores the first controllerchange on a page that had no worker', () => {
    const { state, reloads } = run(false, [['controllerchange', ON_HOME]]);
    assert.deepEqual(reloads, []);
    assert.equal(state.isPending, false);
    assert.equal(state.hadController, true);
    // ...and nothing it does later is a reload either.
    assert.deepEqual(run(false, [
      ['controllerchange', ON_HOME],
      ['dialogclose', ON_HOME],
      ['navigatehome', IN_ROUND]
    ]).reloads, []);
  });

  it('reloads on a later controllerchange at once, only on home with no sheet open', () => {
    assert.deepEqual(run(false, [['controllerchange', ON_HOME], ['controllerchange', ON_HOME]]).reloads, [1]);
    assert.deepEqual(run(true, [['controllerchange', ON_HOME]]).reloads, [0]);
    for (const view of [HOME_WITH_SHEET, IN_ROUND, IN_TEST_WITH_SHEET]) {
      const { state, reloads } = run(true, [['controllerchange', view]]);
      assert.deepEqual(reloads, [], JSON.stringify(view));
      assert.equal(state.isPending, true);
    }
  });

  it('defers a reload blocked by a sheet on home until the sheet closes', () => {
    const { reloads } = run(true, [
      ['controllerchange', HOME_WITH_SHEET],
      // A second sheet closing while one is still open is not enough.
      ['dialogclose', HOME_WITH_SHEET],
      ['dialogclose', ON_HOME]
    ]);
    assert.deepEqual(reloads, [2]);
  });

  it('defers a reload during a round or test until the next navigation to home', () => {
    const { state, reloads } = run(true, [
      ['controllerchange', IN_ROUND],
      // The test's exit sheet closing does not reload mid-test.
      ['dialogclose', IN_ROUND],
      ['navigatehome', IN_ROUND]
    ]);
    assert.deepEqual(reloads, [2]);
    assert.equal(state.isReloading, true);
  });

  it('reloads at most once', () => {
    const { state, reloads } = run(true, [
      ['controllerchange', ON_HOME],
      ['controllerchange', ON_HOME],
      ['dialogclose', ON_HOME],
      ['navigatehome', ON_HOME]
    ]);
    assert.deepEqual(reloads, [0]);
    // `navigate` skips the transition while a reload is under way.
    assert.equal(state.isReloading, true);
  });

  it('never reloads on dialog close or navigation without an update', () => {
    assert.deepEqual(run(true, [['dialogclose', ON_HOME], ['navigatehome', IN_ROUND]]).reloads, []);
  });

  it('does not mutate the state it is given', () => {
    const state = createReloadState(true);
    const { state: next } = decideReload(state, 'controllerchange', IN_ROUND);
    assert.deepEqual(state, { hadController: true, isPending: false, isReloading: false });
    assert.ok(Object.isFrozen(next));
  });

  it('rejects bad input', () => {
    const state = createReloadState(true);
    assert.throws(() => createReloadState('yes'), TypeError);
    assert.throws(() => decideReload({}, 'controllerchange', ON_HOME), TypeError);
    assert.throws(() => decideReload(state, 'reload', ON_HOME), RangeError);
    assert.throws(() => decideReload(state, 'navigatehome'), TypeError);
    assert.throws(() => decideReload(state, 'dialogclose', { isOnHome: 'yes', hasOpenDialog: false }), TypeError);
    assert.deepEqual(RELOAD_EVENTS, ['controllerchange', 'dialogclose', 'navigatehome']);
  });

  it('is what js/app.js uses for every reload decision', () => {
    // Intent guard: the router must not grow a second, untested path.
    const app = readFileSync(join(REPO_ROOT, 'js', 'app.js'), 'utf8');
    for (const event of RELOAD_EVENTS) {
      assert.match(app, new RegExp(`applyReloadEvent\\('${event}'\\)`));
    }
    assert.equal(app.match(/location\.reload\(\)/g)?.length, 2, 'the update reload and the error screen\'s button');
  });
});

describe('isStaleResume', () => {
  const base = { hiddenAt: 1_000_000, shownOn: '2026-10-28', resumedOn: '2026-10-28' };

  it('keeps a short trip away on the same date', () => {
    assert.equal(isStaleResume({ ...base, resumedAt: base.hiddenAt + RESUME_RESET_MS - 1 }), false);
  });

  it(`is stale after ${RESUME_RESET_MS / 60_000} minutes away`, () => {
    assert.equal(isStaleResume({ ...base, resumedAt: base.hiddenAt + RESUME_RESET_MS }), true);
  });

  it('is stale on a new local date, however short the trip', () => {
    assert.equal(isStaleResume({ ...base, resumedAt: base.hiddenAt + 1_000, resumedOn: '2026-10-29' }), true);
  });

  it('rejects bad input', () => {
    assert.throws(() => isStaleResume(), TypeError);
    assert.throws(() => isStaleResume({ ...base, resumedAt: Number.NaN }), TypeError);
    assert.throws(() => isStaleResume({ ...base, resumedAt: 1, shownOn: '28/10/2026' }), TypeError);
  });
});
