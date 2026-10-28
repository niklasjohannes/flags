import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SUGGESTION_LIMIT,
  DISTRACTOR_COUNT,
  MATCH_TIERS,
  buildChoices,
  filterSuggestions,
  getTypoThreshold,
  normalizeText,
  pickDistractors
} from '../js/quiz.js';

// ---- Helpers ----

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { countries } = JSON.parse(readFileSync(join(REPO_ROOT, 'data', 'countries.json'), 'utf8'));
const byCode = new Map(countries.map((country) => [country.code, country]));

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

function deepFreeze(value) {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

// Independent statement of the exclusion rule: the target, its parent, its
// siblings and its dependents.
function getExcluded(code, list) {
  const target = list.find((country) => country.code === code);
  const parent = target.parentCode ?? null;
  const excluded = new Set([code]);
  for (const country of list) {
    const isSibling = parent !== null && country.parentCode === parent;
    const isDependent = country.parentCode === code;
    if (country.code === parent || isSibling || isDependent) {
      excluded.add(country.code);
    }
  }
  return excluded;
}

function countValidSameRegion(code, list) {
  const target = list.find((country) => country.code === code);
  const excluded = getExcluded(code, list);
  return list.filter((country) => country.region === target.region && !excluded.has(country.code)).length;
}

function assertValidDistractors(distractors, code, list) {
  const listByCode = new Map(list.map((country) => [country.code, country]));
  const excluded = getExcluded(code, list);
  assert.equal(distractors.length, DISTRACTOR_COUNT, `${code}: wrong count`);
  assert.equal(new Set(distractors).size, DISTRACTOR_COUNT, `${code}: duplicates in ${distractors}`);
  for (const distractor of distractors) {
    assert.ok(listByCode.has(distractor), `${code}: unknown code ${distractor}`);
    assert.ok(!excluded.has(distractor), `${code}: related distractor ${distractor}`);
  }
}

function codesOf(suggestions) {
  return suggestions.map((suggestion) => suggestion.code);
}

// ---- Multiple choice: real data ----

describe('pickDistractors on data/countries.json', () => {
  it('returns 3 distinct, valid, unrelated codes for every entry', () => {
    const rng = createRng(1);
    for (const { code } of countries) {
      for (let round = 0; round < 20; round += 1) {
        assertValidDistractors(pickDistractors({ code, countries, rng }), code, countries);
      }
    }
  });

  it('stays in the target region whenever the region has enough valid options', () => {
    const rng = createRng(2);
    for (const { code, region } of countries) {
      assert.ok(countValidSameRegion(code, countries) >= DISTRACTOR_COUNT, `${code}: region pool too small`);
      for (let round = 0; round < 20; round += 1) {
        const distractors = pickDistractors({ code, countries, rng });
        const regions = distractors.map((distractor) => byCode.get(distractor).region);
        assert.deepEqual(regions, [region, region, region], `${code}: left its region`);
      }
    }
  });

  it('never pairs Puerto Rico and the United States, in either direction', () => {
    const rng = createRng(3);
    for (let round = 0; round < 500; round += 1) {
      assert.ok(!pickDistractors({ code: 'pr', countries, rng }).includes('us'));
      assert.ok(!pickDistractors({ code: 'us', countries, rng }).includes('pr'));
    }
  });

  it('never pairs US territories with each other or with the United States', () => {
    const usFamily = new Set(['us', ...countries.filter((c) => c.parentCode === 'us').map((c) => c.code)]);
    assert.ok(usFamily.has('gu') && usFamily.has('as') && usFamily.has('pr'));
    const rng = createRng(4);
    for (const code of usFamily) {
      for (let round = 0; round < 200; round += 1) {
        const related = pickDistractors({ code, countries, rng }).filter((d) => usFamily.has(d));
        assert.deepEqual(related, [], `${code} got ${related}`);
      }
    }
  });

  it('handles Oceania: same-region and unrelated for gu, as, au, nz and ck', () => {
    const rng = createRng(5);
    const expectedExclusions = {
      gu: ['us', 'as', 'mp'],
      as: ['us', 'gu', 'mp'],
      au: ['cx', 'cc', 'nf'],
      nz: ['ck', 'nu', 'tk'],
      ck: ['nz', 'nu', 'tk']
    };
    for (const [code, related] of Object.entries(expectedExclusions)) {
      const excluded = getExcluded(code, countries);
      for (const relative of related) {
        assert.ok(excluded.has(relative), `${code} should exclude ${relative}`);
      }
      for (let round = 0; round < 200; round += 1) {
        const distractors = pickDistractors({ code, countries, rng });
        assertValidDistractors(distractors, code, countries);
        for (const distractor of distractors) {
          assert.equal(byCode.get(distractor).region, 'oceania', `${code} got ${distractor}`);
          assert.ok(!related.includes(distractor), `${code} got ${distractor}`);
        }
      }
    }
  });

  it('draws every valid same-region candidate, roughly uniformly', () => {
    const rng = createRng(6);
    const code = 'nz';
    const excluded = getExcluded(code, countries);
    const pool = countries.filter((c) => c.region === 'oceania' && !excluded.has(c.code)).map((c) => c.code);
    const counts = new Map(pool.map((candidate) => [candidate, 0]));
    const draws = 6_000;
    for (let round = 0; round < draws; round += 1) {
      for (const distractor of pickDistractors({ code, countries, rng })) {
        counts.set(distractor, counts.get(distractor) + 1);
      }
    }
    const expected = (draws * DISTRACTOR_COUNT) / pool.length;
    for (const [candidate, count] of counts) {
      assert.ok(Math.abs(count - expected) < expected * 0.15, `${candidate}: ${count} vs ~${expected}`);
    }
  });

  it('is deterministic for a given rng seed', () => {
    const first = pickDistractors({ code: 'fj', countries, rng: createRng(7) });
    const second = pickDistractors({ code: 'fj', countries, rng: createRng(7) });
    assert.deepEqual(first, second);
  });

  it('does not modify `countries`', () => {
    const frozen = deepFreeze(structuredClone(countries));
    const rng = createRng(8);
    pickDistractors({ code: 'pr', countries: frozen, rng });
    buildChoices({ code: 'au', countries: frozen, rng });
    assert.deepEqual(frozen, countries);
  });
});

// ---- Multiple choice: synthetic small region ----

describe('pickDistractors fallback for a small region', () => {
  // `t1` is a territory of sovereign `p` in tiny region `oceania`; its
  // siblings `t2` (same region) and `t3` (another region) and the parent
  // itself are off limits. Only `o1` is a valid same-region option.
  const tiny = [
    { code: 'p', region: 'europe', sovereign: true, parentCode: null },
    { code: 't1', region: 'oceania', sovereign: false, parentCode: 'p' },
    { code: 't2', region: 'oceania', sovereign: false, parentCode: 'p' },
    { code: 't3', region: 'asia', sovereign: false, parentCode: 'p' },
    { code: 'o1', region: 'oceania', sovereign: true, parentCode: null },
    { code: 'e1', region: 'europe', sovereign: true, parentCode: null },
    { code: 'e2', region: 'europe', sovereign: true, parentCode: null },
    { code: 'a1', region: 'asia', sovereign: true, parentCode: null }
  ];

  it('keeps every valid same-region option and fills the rest from other regions', () => {
    const rng = createRng(9);
    const seen = new Set();
    for (let round = 0; round < 500; round += 1) {
      const distractors = pickDistractors({ code: 't1', countries: tiny, rng });
      assertValidDistractors(distractors, 't1', tiny);
      assert.ok(distractors.includes('o1'), `missing o1 in ${distractors}`);
      distractors.forEach((distractor) => seen.add(distractor));
    }
    assert.deepEqual([...seen].sort(), ['a1', 'e1', 'e2', 'o1']);
  });

  it('excludes a sovereign target\'s dependents in every region', () => {
    const rng = createRng(10);
    for (let round = 0; round < 500; round += 1) {
      const distractors = pickDistractors({ code: 'p', countries: tiny, rng });
      assertValidDistractors(distractors, 'p', tiny);
      for (const dependent of ['t1', 't2', 't3']) {
        assert.ok(!distractors.includes(dependent), `p got ${dependent}`);
      }
    }
  });

  it('returns 4 valid options from buildChoices', () => {
    const rng = createRng(11);
    for (let round = 0; round < 200; round += 1) {
      const choices = buildChoices({ code: 't1', countries: tiny, rng });
      assert.equal(choices.length, DISTRACTOR_COUNT + 1);
      assert.equal(choices.filter((choice) => choice === 't1').length, 1);
      assertValidDistractors(choices.filter((choice) => choice !== 't1'), 't1', tiny);
    }
  });

  it('throws when the whole dataset has too few valid options', () => {
    const tooSmall = tiny.filter((country) => !['e1', 'e2'].includes(country.code));
    assert.throws(
      () => pickDistractors({ code: 't1', countries: tooSmall, rng: createRng(12) }),
      { name: 'RangeError', message: /only 2 valid distractors/ }
    );
  });

  it('counts duplicate codes once', () => {
    const duplicated = [...tiny, { code: 'o1', region: 'oceania', parentCode: null }];
    const rng = createRng(13);
    for (let round = 0; round < 200; round += 1) {
      assertValidDistractors(pickDistractors({ code: 't1', countries: duplicated, rng }), 't1', tiny);
    }
  });
});

// ---- Multiple choice: buildChoices on real data ----

describe('buildChoices', () => {
  it('returns 4 distinct codes including the target exactly once', () => {
    const rng = createRng(14);
    for (const { code } of countries) {
      const choices = buildChoices({ code, countries, rng });
      assert.equal(choices.length, DISTRACTOR_COUNT + 1);
      assert.equal(new Set(choices).size, choices.length);
      assert.ok(choices.includes(code));
      assertValidDistractors(choices.filter((choice) => choice !== code), code, countries);
    }
  });

  it('puts the correct answer in each position roughly equally often', () => {
    const rng = createRng(15);
    const rounds = 8_000;
    const counts = [0, 0, 0, 0];
    for (let round = 0; round < rounds; round += 1) {
      counts[buildChoices({ code: 'fr', countries, rng }).indexOf('fr')] += 1;
    }
    const expected = rounds / counts.length;
    for (const [position, count] of counts.entries()) {
      assert.ok(Math.abs(count - expected) < expected * 0.1, `position ${position}: ${count} vs ~${expected}`);
    }
  });
});

// ---- Multiple choice: validation ----

describe('pickDistractors and buildChoices validation', () => {
  const rng = createRng(16);

  it('rejects a bad or unknown `code`', () => {
    assert.throws(() => pickDistractors({ code: 42, countries, rng }), { name: 'TypeError', message: /`code`/ });
    assert.throws(() => pickDistractors({ code: 'zz', countries, rng }), { name: 'RangeError', message: /`code` `zz`/ });
    assert.throws(() => buildChoices({ code: 'zz', countries, rng }), RangeError);
  });

  it('rejects bad `countries`', () => {
    assert.throws(() => pickDistractors({ code: 'fr', countries: {}, rng }), { name: 'TypeError', message: /`countries`/ });
    assert.throws(
      () => pickDistractors({ code: 'fr', countries: [null], rng }),
      { name: 'TypeError', message: /`countries\[0\]`/ }
    );
    assert.throws(
      () => pickDistractors({ code: 'fr', countries: [{ code: 'fr' }], rng }),
      { name: 'TypeError', message: /`countries\[0\]\.region`/ }
    );
    assert.throws(
      () => pickDistractors({ code: 'fr', countries: [{ code: 'fr', region: 'europe', parentCode: 7 }], rng }),
      { name: 'TypeError', message: /`countries\[0\]\.parentCode`/ }
    );
  });

  it('rejects a bad `rng`', () => {
    assert.throws(() => pickDistractors({ code: 'fr', countries }), { name: 'TypeError', message: /`rng`/ });
    assert.throws(() => pickDistractors({ code: 'fr', countries, rng: () => 1 }), { name: 'RangeError', message: /`rng`/ });
    assert.throws(() => pickDistractors({ code: 'fr', countries, rng: () => NaN }), RangeError);
  });

  it('rejects a missing or non-object options argument', () => {
    assert.throws(() => pickDistractors(), TypeError);
    assert.throws(() => buildChoices(), TypeError);
    for (const options of [null, 'fr', ['fr']]) {
      assert.throws(() => pickDistractors(options), { name: 'TypeError', message: /`options`/ });
      assert.throws(() => buildChoices(options), { name: 'TypeError', message: /`options`/ });
    }
  });
});

// ---- Typing mode: normalization ----

describe('normalizeText', () => {
  it('folds case, diacritics, punctuation and whitespace', () => {
    assert.equal(normalizeText("Côte d'Ivoire"), 'cote d ivoire');
    assert.equal(normalizeText('  COTE   d IVOIRE '), 'cote d ivoire');
    assert.equal(normalizeText('São Tomé and Príncipe'), 'sao tome and principe');
    assert.equal(normalizeText('Guinea-Bissau'), 'guinea bissau');
    assert.equal(normalizeText('U.S. Virgin Islands'), 'u s virgin islands');
    assert.equal(normalizeText('Åland'), 'aland');
    assert.equal(normalizeText("'.- "), '');
  });

  it('splits ligatures and full-width forms (NFKD)', () => {
    assert.equal(normalizeText('ﬁji'), 'fiji');
    assert.equal(normalizeText('ＵＳＡ'), 'usa');
  });

  it('folds letters that decomposition leaves whole', () => {
    assert.equal(normalizeText('Straße'), 'strasse');
    assert.equal(normalizeText('Færøerne'), 'faeroerne');
    assert.equal(normalizeText('Œuvre'), 'oeuvre');
    assert.equal(normalizeText('Łódź'), 'lodz');
    assert.equal(normalizeText('Đakovo'), 'dakovo');
    assert.equal(normalizeText('Diyarbakır'), 'diyarbakir');
    assert.equal(normalizeText('Þórshöfn'), 'thorshofn');
  });

  it('rejects non-strings', () => {
    assert.throws(() => normalizeText(null), { name: 'TypeError', message: /`text`/ });
  });
});

describe('getTypoThreshold', () => {
  it('scales with query length', () => {
    assert.equal(getTypoThreshold('br'), 0);
    assert.equal(getTypoThreshold('bra'), 1);
    assert.equal(getTypoThreshold('braz'), 2);
    assert.equal(getTypoThreshold('brazl'), 2);
    assert.equal(getTypoThreshold('phillipi'), 2);
    assert.equal(getTypoThreshold('a b'), 0);
    assert.equal(getTypoThreshold('a b c'), 1);
  });

  it('never decreases as the query grows', () => {
    let previous = 0;
    for (let length = 1; length <= 30; length += 1) {
      const threshold = getTypoThreshold('x'.repeat(length));
      assert.ok(threshold >= previous, `length ${length}`);
      previous = threshold;
    }
  });

  it('rejects non-strings', () => {
    assert.throws(() => getTypoThreshold(3), { name: 'TypeError', message: /`query`/ });
  });
});

// ---- Typing mode: filterSuggestions ----

describe('filterSuggestions', () => {
  function top(query, options) {
    return filterSuggestions(query, countries, options)[0];
  }

  it('matches aliases', () => {
    assert.deepEqual(top('holland'), { code: 'nl', name: 'Netherlands', matched: 'Holland' });
    assert.equal(top('usa').code, 'us');
    assert.equal(top('usa').matched, 'USA');
    assert.deepEqual(top('burma'), { code: 'mm', name: 'Myanmar', matched: 'Burma' });
    assert.equal(top('ivory coast').code, 'ci');
    assert.equal(top('turkey').code, 'tr');
    for (const query of ['england', 'scotland', 'wales', 'northern ireland', 'great britain']) {
      assert.equal(top(query).code, 'gb', query);
    }
    assert.equal(top('ireland').code, 'ie');
  });

  it('matches a missing-letter subsequence', () => {
    assert.equal(top('grmny').code, 'de');
    assert.equal(top('nwzlnd').code, 'nz');
  });

  it('ignores case, diacritics and punctuation', () => {
    for (const query of ["cote d'ivoire", "Côte d'Ivoire", 'cote d ivoire', 'CÔTE', 'cotedivoire']) {
      assert.equal(top(query).code, 'ci', query);
    }
    assert.equal(top('sao tome').code, 'st');
    assert.equal(top('TÜRKIYE').code, 'tr');
  });

  it('matches partial input', () => {
    assert.equal(top('swit').code, 'ch');
    assert.equal(top('zeal').code, 'nz');
  });

  it('tolerates typos', () => {
    assert.equal(top('brazl').code, 'br');
    assert.equal(top('jermany').code, 'de');
    assert.equal(top('phillipines').code, 'ph');
    assert.equal(top('nwe zealand').code, 'nz');
    assert.equal(top('morroco').code, 'ma');
    assert.equal(top('sirya').code, 'sy');
  });

  it('ranks a one-edit typo above a widely spread subsequence', () => {
    // Each query is also a subsequence of the second, longer name.
    const cases = [
      ['fratce', 'fr', 'fm'],
      ['bahrein', 'bh', 'ba'],
      ['kenia', 'ke', 'cc'],
      ['brzzil', 'br', 'cg']
    ];
    for (const [query, expected, spread] of cases) {
      const codes = codesOf(filterSuggestions(query, countries, { limit: 50 }));
      assert.equal(codes[0], expected, query);
      assert.ok(codes.includes(spread), `${query} should still list ${spread}`);
    }
  });

  it('does not drop a country while the user types on past a typo', () => {
    function isShown(query, code) {
      return codesOf(filterSuggestions(query, countries, { limit: 300 })).includes(code);
    }
    function assertStaysShown(typed, code) {
      let wasShown = false;
      for (let length = 1; length <= typed.length; length += 1) {
        const shown = isShown(typed.slice(0, length), code);
        assert.ok(shown || !wasShown, `${typed.slice(0, length)} dropped ${code}`);
        wasShown = shown;
      }
      assert.ok(wasShown, `${typed} never showed ${code}`);
    }
    assertStaysShown('morroco', 'ma');
    assertStaysShown('sirya', 'sy');
    assertStaysShown('phillipines', 'ph');
    assertStaysShown('jermany', 'de');
    assertStaysShown('brzzil', 'br');
    // One typo (deletion or substitution) in the middle of every real name;
    // the letters after it are typed correctly.
    for (const { code, name } of countries) {
      const normalized = normalizeText(name);
      const middle = Math.floor(normalized.length / 2);
      const substituted = normalized[middle] === 'x' ? 'q' : 'x';
      assertStaysShown(normalized.slice(0, middle) + normalized.slice(middle + 1), code);
      assertStaysShown(normalized.slice(0, middle) + substituted + normalized.slice(middle + 1), code);
    }
  });

  it('returns both sides of a shared bare name', () => {
    assert.deepEqual(codesOf(filterSuggestions('korea', countries)).slice(0, 2).sort(), ['kp', 'kr']);
    assert.deepEqual(codesOf(filterSuggestions('congo', countries)).slice(0, 2).sort(), ['cd', 'cg']);
  });

  it('ranks by tier: exact, prefix, word-prefix, substring, fuzzy', () => {
    const list = [
      { code: 'e', name: 'Mali', aliases: [] },
      { code: 'p', name: 'Malibu', aliases: [] },
      { code: 'w', name: 'North Mali', aliases: [] },
      { code: 's', name: 'Somalia', aliases: [] },
      { code: 'q', name: 'Mxaxlxi', aliases: [] },
      { code: 't', name: 'Mlai', aliases: [] },
      { code: 'n', name: 'Chad', aliases: [] }
    ];
    assert.deepEqual(MATCH_TIERS, ['exact', 'prefix', 'word-prefix', 'substring', 'fuzzy']);
    // Both last two are fuzzy: 'mlai' is one swap (cost 1), 'mxaxlxi' skips
    // three letters (cost 1.5).
    assert.deepEqual(codesOf(filterSuggestions('mali', list)), ['e', 'p', 'w', 's', 't', 'q']);
  });

  it('orders shorter matches first within a tier, then by name', () => {
    const list = [
      { code: 'c', name: 'Grenadines', aliases: [] },
      { code: 'b', name: 'Grenada Bay', aliases: [] },
      { code: 'a', name: 'Grenada', aliases: [] },
      { code: 'd', name: 'Greece', aliases: [] },
      { code: 'z', name: 'Gren Zeta', aliases: [] },
      { code: 'y', name: 'Gren Alfa', aliases: [] }
    ];
    // Greece is one typo away ('gree'), so it comes last.
    assert.deepEqual(codesOf(filterSuggestions('gren', list)), ['a', 'y', 'z', 'c', 'b', 'd']);
  });

  it('lists each country once, under its best match', () => {
    const results = filterSuggestions('united states', countries, { limit: 50 });
    assert.equal(new Set(codesOf(results)).size, results.length);
    assert.deepEqual(results[0], { code: 'us', name: 'United States', matched: 'United States' });
    for (const query of ['a', 'us', 'island', 'saint', 'guinea']) {
      const codes = codesOf(filterSuggestions(query, countries, { limit: 300 }));
      assert.equal(new Set(codes).size, codes.length, query);
    }
  });

  it('respects `limit`', () => {
    assert.equal(filterSuggestions('a', countries).length, DEFAULT_SUGGESTION_LIMIT);
    assert.equal(filterSuggestions('a', countries, { limit: 3 }).length, 3);
    assert.equal(filterSuggestions('holland', countries, { limit: 1 }).length, 1);
    assert.ok(filterSuggestions('a', countries, { limit: 300 }).length > DEFAULT_SUGGESTION_LIMIT);
  });

  it('returns [] for an empty, whitespace or punctuation-only query', () => {
    assert.deepEqual(filterSuggestions('', countries), []);
    assert.deepEqual(filterSuggestions('   ', countries), []);
    assert.deepEqual(filterSuggestions(" ' - ", countries), []);
  });

  it('returns [] when nothing matches', () => {
    assert.deepEqual(filterSuggestions('xqzwv', countries), []);
  });

  it('counts duplicate codes once and accepts missing aliases', () => {
    const list = [
      { code: 'fr', name: 'France' },
      { code: 'fr', name: 'France', aliases: ['French Republic'] }
    ];
    assert.deepEqual(filterSuggestions('fra', list), [{ code: 'fr', name: 'France', matched: 'France' }]);
  });

  it('does not modify `countries`', () => {
    const frozen = deepFreeze(structuredClone(countries));
    filterSuggestions('cote', frozen);
    assert.deepEqual(frozen, countries);
  });

  it('is fast enough to run on every keystroke', () => {
    // A generous bound on the median, so a loaded CI machine cannot flake it;
    // a laptop takes well under 1 ms.
    const queries = ['g', 'ge', 'ger', 'germ', 'grmny', 'xqzwv', 'cote d iv', 'phillipines'];
    const timings = [];
    for (let i = 0; i < 200; i += 1) {
      const start = performance.now();
      filterSuggestions(queries[i % queries.length], countries);
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    const median = timings[timings.length / 2];
    assert.ok(median < 25, `median ${median.toFixed(2)} ms per call`);
  });

  it('rejects bad arguments', () => {
    assert.throws(() => filterSuggestions(null, countries), { name: 'TypeError', message: /`query`/ });
    assert.throws(() => filterSuggestions('a', 'x'), { name: 'TypeError', message: /`countries`/ });
    assert.throws(
      () => filterSuggestions('a', [{ code: 'fr' }]),
      { name: 'TypeError', message: /`countries\[0\]\.name`/ }
    );
    assert.throws(
      () => filterSuggestions('a', [{ code: 'fr', name: 'France', aliases: 'Gaul' }]),
      { name: 'TypeError', message: /`countries\[0\]\.aliases`/ }
    );
    for (const options of [null, 'x', [8]]) {
      assert.throws(() => filterSuggestions('a', countries, options), { name: 'TypeError', message: /`options`/ });
    }
    for (const limit of [0, -1, 1.5, '3']) {
      assert.throws(() => filterSuggestions('a', countries, { limit }), { name: 'RangeError', message: /`limit`/ });
    }
  });
});
