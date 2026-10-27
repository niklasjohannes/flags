import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCountries, buildFromRepo, serialiseCountries } from '../scripts/build-countries.js';
import { findSvgSafetyIssues, normaliseSvgIds } from '../scripts/svg-safety.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COUNTRIES_PATH = join(REPO_ROOT, 'data', 'countries.json');
const FLAGS_DIR = join(REPO_ROOT, 'flags');
const REGIONS = ['africa', 'asia', 'europe', 'north-america', 'south-america', 'oceania'];

const document = JSON.parse(readFileSync(COUNTRIES_PATH, 'utf8'));
const { countries } = document;
const byCode = new Map(countries.map((country) => [country.code, country]));
const svgCodes = readdirSync(FLAGS_DIR)
  .filter((file) => file.endsWith('.svg'))
  .map((file) => file.slice(0, -'.svg'.length));

describe('countries.json <-> flags/ mapping', () => {
  it('has an SVG for every country code', () => {
    const svgSet = new Set(svgCodes);
    const missing = countries.map((country) => country.code).filter((code) => !svgSet.has(code));
    assert.deepEqual(missing, []);
  });

  it('has a country entry for every SVG', () => {
    const orphans = svgCodes.filter((code) => !byCode.has(code));
    assert.deepEqual(orphans, []);
  });

  it('contains nothing but SVGs in flags/', () => {
    const others = readdirSync(FLAGS_DIR).filter((file) => !file.endsWith('.svg'));
    assert.deepEqual(others, []);
  });
});

describe('countries.json schema', () => {
  it('has meta with the pinned source, the closed region list and the policy', () => {
    assert.deepEqual(document.meta.regions, REGIONS);
    assert.equal(document.meta.source.name, 'flag-icons');
    assert.match(document.meta.source.tag, /^v\d+\.\d+\.\d+$/);
    assert.match(document.meta.source.commit, /^[0-9a-f]{40}$/);
    assert.match(document.meta.source.archiveSha256, /^[0-9a-f]{64}$/);
    for (const key of ['scope', 'regionBasis', 'transcontinental', 'sovereignty', 'parentCode', 'naming', 'contested']) {
      assert.ok(key in document.meta.policy, `meta.policy.${key} is missing`);
    }
  });

  it('gives every entry exactly the required fields with the right types', () => {
    for (const country of countries) {
      assert.deepEqual(
        Object.keys(country),
        ['code', 'name', 'aliases', 'region', 'sovereign', 'parentCode'],
        `${country.code}: unexpected keys`
      );
      assert.match(country.code, /^[a-z]{2}$/, `${country.code}: code`);
      assert.equal(typeof country.name, 'string', `${country.code}: name`);
      assert.ok(country.name.trim().length > 0, `${country.code}: empty name`);
      assert.ok(Array.isArray(country.aliases), `${country.code}: aliases`);
      for (const alias of country.aliases) {
        assert.equal(typeof alias, 'string', `${country.code}: alias type`);
        assert.ok(alias.trim().length > 0, `${country.code}: empty alias`);
        assert.notEqual(alias, country.name, `${country.code}: alias repeats name`);
      }
      assert.equal(new Set(country.aliases).size, country.aliases.length, `${country.code}: duplicate alias`);
      assert.ok(REGIONS.includes(country.region), `${country.code}: region ${country.region}`);
      assert.equal(typeof country.sovereign, 'boolean', `${country.code}: sovereign`);
      assert.ok(country.parentCode === null || typeof country.parentCode === 'string', `${country.code}: parentCode`);
    }
  });

  it('has unique codes, sorted', () => {
    const codes = countries.map((country) => country.code);
    assert.equal(new Set(codes).size, codes.length);
    assert.deepEqual(codes, [...codes].sort());
  });

  it('points every parentCode at an existing sovereign entry, never itself', () => {
    for (const country of countries) {
      if (country.parentCode === null) continue;
      assert.notEqual(country.parentCode, country.code, `${country.code}: self-parent`);
      const parent = byCode.get(country.parentCode);
      assert.ok(parent, `${country.code}: parent ${country.parentCode} missing`);
      assert.equal(parent.sovereign, true, `${country.code}: parent ${country.parentCode} is not sovereign`);
    }
  });

  it('never gives a sovereign entry a parent', () => {
    const offenders = countries.filter((country) => country.sovereign && country.parentCode !== null);
    assert.deepEqual(offenders.map((country) => country.code), []);
  });

  it('uses no entry name twice', () => {
    const names = countries.map((country) => country.name.toLowerCase());
    assert.equal(new Set(names).size, names.length);
  });
});

describe('countries.json reproducibility', () => {
  it('matches a fresh build from vendor/ and scripts/country-overrides.js byte for byte', () => {
    assert.equal(readFileSync(COUNTRIES_PATH, 'utf8'), serialiseCountries(buildFromRepo()));
  });

  it('rejects an upstream ISO code that has no override decision', () => {
    const upstream = [{ code: 'aa', iso: true }, { code: 'bb', iso: true }];
    const overrides = {
      source: {},
      regions: REGIONS,
      policy: {},
      excluded: {},
      entries: { aa: { name: 'A', aliases: [], region: 'europe', sovereign: true, parentCode: null } }
    };
    assert.throws(() => buildCountries(upstream, overrides), /no override decision: bb/);
  });

  it('rejects a parentCode that is not a kept sovereign entry', () => {
    const upstream = [{ code: 'aa', iso: true }, { code: 'bb', iso: true }];
    const overrides = {
      source: {},
      regions: REGIONS,
      policy: {},
      excluded: { bb: 'test' },
      entries: { aa: { name: 'A', aliases: [], region: 'europe', sovereign: false, parentCode: 'bb' } }
    };
    assert.throws(() => buildCountries(upstream, overrides), RangeError);
  });
});

describe('spot checks', () => {
  it('places transcontinental countries per UN M49', () => {
    assert.equal(byCode.get('ru').region, 'europe');
    assert.equal(byCode.get('tr').region, 'asia');
    assert.equal(byCode.get('eg').region, 'africa');
    assert.equal(byCode.get('kz').region, 'asia');
  });

  it('links territories to their administering state', () => {
    assert.equal(byCode.get('pr').parentCode, 'us');
    assert.equal(byCode.get('gl').parentCode, 'dk');
    assert.equal(byCode.get('hk').parentCode, 'cn');
  });

  it('applies the sovereignty rule to contested entries', () => {
    assert.deepEqual([byCode.get('tw').sovereign, byCode.get('tw').parentCode], [false, null]);
    assert.deepEqual([byCode.get('eh').sovereign, byCode.get('eh').parentCode], [false, null]);
    assert.equal(byCode.get('ps').sovereign, true);
    assert.equal(byCode.get('va').sovereign, true);
    assert.equal(byCode.has('xk'), false);
  });

  it('has 193 UN members plus 2 observer states as sovereign', () => {
    assert.equal(countries.filter((country) => country.sovereign).length, 195);
  });
});

describe('vendored SVG safety', () => {
  for (const code of svgCodes) {
    it(`${code}.svg has no script, handlers, foreignObject or external refs`, () => {
      const svg = readFileSync(join(FLAGS_DIR, `${code}.svg`), 'utf8');
      assert.deepEqual(findSvgSafetyIssues(svg), []);
    });
  }

  it('flags each unsafe construct the check is meant to catch', () => {
    const cases = [
      '<svg><script>alert(1)</script></svg>',
      '<svg onload="x()"></svg>',
      '<svg><rect onclick = "x()"/></svg>',
      '<svg><foreignObject></foreignObject></svg>',
      '<svg><image href="https://example.com/a.png"/></svg>',
      '<svg><use xlink:href="//example.com/a.svg#x"/></svg>',
      '<svg><a href="javascript:alert(1)"/></svg>',
      '<svg><rect style="fill:url(http://example.com/x)"/></svg>',
      '<svg><style>@import "x.css";</style></svg>',
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg/>'
    ];
    for (const svg of cases) {
      assert.ok(findSvgSafetyIssues(svg).length > 0, `not caught: ${svg}`);
    }
  });

  it('allows internal fragment references', () => {
    assert.deepEqual(findSvgSafetyIssues('<svg><use href="#a"/><path fill="url(#g)"/></svg>'), []);
  });

  it('ships no two flags that are identical apart from their ids', () => {
    const seen = new Map();
    for (const code of svgCodes) {
      const key = normaliseSvgIds(code, readFileSync(join(FLAGS_DIR, `${code}.svg`), 'utf8'));
      assert.ok(!seen.has(key), `${code}.svg duplicates ${seen.get(key)}.svg`);
      seen.set(key, code);
    }
  });
});
