import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKUP_APP,
  BACKUP_ERRORS,
  BACKUP_VERSION,
  MAX_BACKUP_LENGTH,
  getBackupFilename,
  parseBackup,
  serializeBackup
} from '../js/backup.js';
import { createCardState, sanitizeStates } from '../js/srs.js';

const TODAY = '2026-10-28';
// Stands in for the dataset's codes (`countries.map((country) => country.code)`).
const KNOWN_CODES = new Set(['fr', 'jp', 'de', 'it', 'es']);
const NOW = new Date('2026-10-28T09:30:00.000Z');

const STATES = Object.freeze({
  fr: { code: 'fr', repetitions: 3, easeFactor: 2.6, intervalDays: 15, dueDate: '2026-11-10', lapses: 1 },
  jp: { code: 'jp', repetitions: 0, easeFactor: 2.3, intervalDays: 1, dueDate: '2026-10-29', lapses: 2 }
});

function envelope(overrides = {}) {
  return JSON.stringify({ app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: NOW.toISOString(), states: STATES, ...overrides });
}

describe('serializeBackup', () => {
  it('writes the versioned envelope as pretty JSON with a trailing newline', () => {
    const text = serializeBackup(STATES, NOW);
    assert.ok(text.endsWith('}\n'));
    assert.deepEqual(JSON.parse(text), {
      app: 'flags',
      version: 1,
      exportedAt: '2026-10-28T09:30:00.000Z',
      states: STATES
    });
  });

  it('rejects bad arguments', () => {
    assert.throws(() => serializeBackup(null, NOW), TypeError);
    assert.throws(() => serializeBackup([], NOW), TypeError);
    assert.throws(() => serializeBackup(STATES, '2026-10-28'), TypeError);
    assert.throws(() => serializeBackup(STATES, new Date('nope')), TypeError);
  });
});

describe('parseBackup', () => {
  it('round-trips an export exactly (byte-for-byte once re-saved)', () => {
    const states = sanitizeStates(STATES, TODAY);
    const result = parseBackup(serializeBackup(states, NOW), TODAY, KNOWN_CODES);
    assert.equal(result.ok, true);
    assert.deepEqual(result.states, states);
    assert.equal(JSON.stringify(result.states), JSON.stringify(states));
    assert.equal(result.count, 2);
    assert.equal(result.dropped, 0);
    assert.equal(result.exportedAt, NOW.toISOString());
  });

  it('accepts an empty backup', () => {
    const result = parseBackup(envelope({ states: {} }), TODAY, KNOWN_CODES);
    assert.deepEqual(result, { ok: true, states: {}, count: 0, dropped: 0, exportedAt: NOW.toISOString() });
  });

  it('runs entries through sanitizeStates and counts what it drops', () => {
    const states = {
      ...STATES,
      xx: 'not a state',
      de: { code: 'fr', dueDate: TODAY },
      it: { dueDate: 'tomorrow' },
      es: { repetitions: 2.7, easeFactor: 99, intervalDays: 6, dueDate: '2026-11-01', lapses: -3, extra: true }
    };
    const result = parseBackup(envelope({ states }), TODAY, KNOWN_CODES);
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.states), ['fr', 'jp', 'es']);
    assert.equal(result.count, 3);
    assert.equal(result.dropped, 3);
    assert.deepEqual(result.states.es, sanitizeStates({ es: states.es }, TODAY).es);
    assert.equal('extra' in result.states.es, false);
  });

  it('drops and counts entries for codes outside the dataset (GitHub #30)', () => {
    const states = {
      ...STATES,
      FR: { ...STATES.fr, code: 'FR' },
      DE: { code: 'DE', dueDate: TODAY },
      xk: { code: 'xk', dueDate: TODAY },
      constructor: { dueDate: TODAY }
    };
    const result = parseBackup(envelope({ states }), TODAY, KNOWN_CODES);
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.states), ['fr', 'jp']);
    assert.equal(result.count, 2);
    assert.equal(result.dropped, 4);
  });

  it('refuses a backup whose every entry is for an unknown or upper-cased code', () => {
    const states = { FR: { code: 'FR', dueDate: TODAY }, JP: { dueDate: TODAY }, zz: { dueDate: TODAY } };
    assert.deepEqual(
      parseBackup(envelope({ states }), TODAY, KNOWN_CODES),
      { ok: false, error: BACKUP_ERRORS.noValidEntries }
    );
  });

  it('accepts `knownCodes` as an array too', () => {
    const result = parseBackup(envelope(), TODAY, ['fr']);
    assert.deepEqual(Object.keys(result.states), ['fr']);
    assert.equal(result.dropped, 1);
  });

  it('pulls a far-future due date back, as on load', () => {
    const states = { fr: { ...STATES.fr, dueDate: '2099-01-01' } };
    const result = parseBackup(envelope({ states }), TODAY, KNOWN_CODES);
    assert.ok(result.states.fr.dueDate < '2099-01-01');
  });

  it('gives `exportedAt: null` when it is missing or not a date', () => {
    assert.equal(parseBackup(envelope({ exportedAt: undefined }), TODAY, KNOWN_CODES).exportedAt, null);
    assert.equal(parseBackup(envelope({ exportedAt: 'yesterday' }), TODAY, KNOWN_CODES).exportedAt, null);
    assert.equal(parseBackup(envelope({ exportedAt: 42 }), TODAY, KNOWN_CODES).exportedAt, null);
  });

  const refusals = {
    'invalid JSON': ['{"app": "flags",', BACKUP_ERRORS.notJson],
    'a truncated file': [serializeBackup(STATES, NOW).slice(0, 80), BACKUP_ERRORS.notJson],
    'an empty file': ['', BACKUP_ERRORS.notJson],
    'a JSON array': ['[]', BACKUP_ERRORS.notBackup],
    'JSON null': ['null', BACKUP_ERRORS.notBackup],
    'a bare state map (no envelope)': [JSON.stringify(STATES), BACKUP_ERRORS.notBackup],
    'another app': [envelope({ app: 'other' }), BACKUP_ERRORS.notBackup],
    'a missing version': [envelope({ version: undefined }), BACKUP_ERRORS.notBackup],
    'a string version': [envelope({ version: '1' }), BACKUP_ERRORS.notBackup],
    'version 0': [envelope({ version: 0 }), BACKUP_ERRORS.notBackup],
    'a newer version': [envelope({ version: BACKUP_VERSION + 1 }), BACKUP_ERRORS.newerVersion],
    'missing states': [envelope({ states: undefined }), BACKUP_ERRORS.notBackup],
    'states as an array': [envelope({ states: [] }), BACKUP_ERRORS.notBackup],
    'only unreadable entries': [envelope({ states: { fr: { dueDate: 'soon' }, XX: {} } }), BACKUP_ERRORS.noValidEntries],
    'an oversized file': [' '.repeat(MAX_BACKUP_LENGTH + 1), BACKUP_ERRORS.tooLarge]
  };
  for (const [name, [text, error]] of Object.entries(refusals)) {
    it(`refuses ${name} with a clear message`, () => {
      assert.deepEqual(parseBackup(text, TODAY, KNOWN_CODES), { ok: false, error });
    });
  }

  it('rejects bad arguments', () => {
    assert.throws(() => parseBackup(null, TODAY, KNOWN_CODES), TypeError);
    assert.throws(() => parseBackup('{}', '28/10/2026'), TypeError);
    assert.throws(() => parseBackup('{}'), TypeError);
    assert.throws(() => parseBackup('{}', TODAY), TypeError);
    assert.throws(() => parseBackup('{}', TODAY, 'fr,jp'), TypeError);
    assert.throws(() => parseBackup('{}', TODAY, [1, 2]), TypeError);
  });

  it('keeps a fresh card exactly', () => {
    const states = { fr: createCardState('fr') };
    const result = parseBackup(serializeBackup(states, NOW), TODAY, KNOWN_CODES);
    assert.deepEqual(result.states, sanitizeStates(states, TODAY));
  });
});

describe('getBackupFilename', () => {
  it('names the file after the date', () => {
    assert.equal(getBackupFilename(TODAY), 'flags-backup-2026-10-28.json');
  });

  it('rejects anything but a YYYY-MM-DD date', () => {
    assert.throws(() => getBackupFilename('2026-10-28T00:00'), TypeError);
    assert.throws(() => getBackupFilename(undefined), TypeError);
  });
});
