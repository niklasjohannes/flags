import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REGIONS } from '../js/srs.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { meta } = JSON.parse(readFileSync(join(REPO_ROOT, 'data', 'countries.json'), 'utf8'));

describe('region taxonomy', () => {
  it('has the same regions in js/srs.js and data/countries.json', () => {
    assert.deepEqual([...REGIONS].sort(), [...meta.regions].sort());
  });

  it('lists each region once', () => {
    assert.equal(new Set(REGIONS).size, REGIONS.length);
    assert.equal(new Set(meta.regions).size, meta.regions.length);
  });
});
