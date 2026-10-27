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

  it('marks exactly the dependencies/territories plus tw and eh as non-sovereign', () => {
    const nonSovereign = countries.filter((country) => !country.sovereign).map((country) => country.code);
    assert.deepEqual(nonSovereign, [
      'ai', 'as', 'aw', 'ax', 'bm', 'cc', 'ck', 'cw', 'cx', 'eh', 'fk', 'fo', 'gg', 'gi', 'gl', 'gu',
      'hk', 'im', 'je', 'ky', 'mo', 'mp', 'mq', 'ms', 'nc', 'nf', 'nu', 'pf', 'pn', 'pr', 'sx', 'tc',
      'tk', 'tw', 'vg', 'vi'
    ]);
  });

  it('gives no entry a bare name shared by two entries as an alias', () => {
    assert.equal(byCode.get('kr').aliases.includes('Korea'), false);
    assert.equal(byCode.get('kp').aliases.includes('Korea'), false);
    assert.equal(byCode.get('cg').aliases.includes('Congo'), false);
    assert.equal(byCode.get('cd').aliases.includes('Congo'), false);
  });
});

describe('vendored SVG safety', () => {
  for (const code of svgCodes) {
    it(`${code}.svg passes the SVG allowlist`, () => {
      const svg = readFileSync(join(FLAGS_DIR, `${code}.svg`), 'utf8');
      assert.deepEqual(findSvgSafetyIssues(svg), []);
    });
  }

  const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';
  const XLINK_NS = 'xmlns:xlink="http://www.w3.org/1999/xlink"';
  const wrap = (inner) => `<svg ${SVG_NS} ${XLINK_NS} viewBox="0 0 640 480">${inner}</svg>`;

  // Each of these gets past a denylist of `<script`, `on*=`, `<foreignObject`
  // and literal `http(s):`/`//` hrefs. The allowlist must reject every one.
  const BYPASSES = {
    'decimal char ref in href scheme': wrap('<a href="&#106;avascript:alert(1)"><path d="M0 0h9"/></a>'),
    'hex char ref in href scheme': wrap('<use href="&#x68;ttps://evil.example/x.svg#a"/>'),
    'char ref in xlink:href scheme': wrap('<use xlink:href="&#104;ttps://evil.example/x.svg#a"/>'),
    'named entity': wrap('<path d="M0 0" fill="&amp;"/>'),
    'namespaced script element': `<svg ${SVG_NS} xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>`,
    'SMIL animate rewriting href': wrap('<a href="#x"><animate attributeName="href" values="javascript:alert(1)"/><path d="M0 0"/></a>'),
    'SMIL set rewriting href': wrap('<a href="#x"><set attributeName="href" to="javascript:alert(1)"/><path d="M0 0"/></a>'),
    'unquoted external href': wrap('<use href=https://evil.example/x.svg#a />'),
    'single-quoted external href': wrap('<use href=\'https://evil.example/x.svg#a\'/>'),
    'CSS escape inside url()': wrap('<path d="M0 0" style="fill:url(\\68ttps://evil.example/x#g)"/>'),
    'CSS-escaped @import': wrap('<path d="M0 0" style="@\\69mport \'https://evil.example/x.css\'"/>'),
    'bare iframe': wrap('<iframe src="https://evil.example/"/>'),
    'relative image': wrap('<image href="other.svg" width="9" height="9"/>'),
    'relative use': wrap('<use href="other.svg#a"/>'),
    'relative use via xlink:href': wrap('<use xlink:href="other.svg#a"/>'),
    'xml-stylesheet processing instruction': `<?xml-stylesheet href="https://evil.example/x.css"?>${wrap('<path d="M0 0"/>')}`,
    'script element': wrap('<script>alert(1)</script>'),
    'upper-case script element': wrap('<SCRIPT>alert(1)</SCRIPT>'),
    'slash-separated onload': `<svg/onload=alert(1)>${wrap('')}`,
    'quoted onload on root': `<svg ${SVG_NS} onload="alert(1)"></svg>`,
    'event handler with space before =': wrap('<path d="M0 0" onclick ="alert(1)"/>'),
    'foreignObject': wrap('<foreignObject><div/></foreignObject>'),
    'style element': wrap('<style>path{fill:url(https://evil.example/x#g)}</style>'),
    'external url() in presentation attribute': wrap('<path d="M0 0" fill="url(https://evil.example/x#g)"/>'),
    'protocol-relative url()': wrap('<path d="M0 0" fill="url( //evil.example/x#g)"/>'),
    'unclosed external url(': wrap('<path d="M0 0" fill="url(https://evil.example/p.svg#a"/>'),
    'unclosed url( in style': wrap('<path d="M0 0" style="marker:none;fill:url(https://evil.example/p.svg#a"/>'),
    'url( with whitespace before the fragment': wrap('<path d="M0 0" fill="url( #a)"/>'),
    'upper-case URL( external': wrap('<path d="M0 0" fill="URL(https://evil.example/p.svg#a)"/>'),
    'fragment url() followed by an unclosed external one': wrap('<path d="M0 0" fill="url(#a) url(https://evil.example/p.svg#a"/>'),
    'CSS expression in style': wrap('<path d="M0 0" style="background:expression(alert(1))"/>'),
    'unknown style property': wrap('<path d="M0 0" style="behavior:none"/>'),
    'javascript: in xlink:href beside a safe href': wrap('<use href="#a" xlink:href="javascript:alert(1)"/>'),
    'data: URI href': wrap('<a xlink:href="data:text/html,x"><path d="M0 0"/></a>'),
    'CDATA section': wrap('<![CDATA[x]]>'),
    'DOCTYPE with ENTITY': `<!DOCTYPE svg [<!ENTITY x "y">]>${wrap('')}`,
    'comment': wrap('<!-- x -->'),
    'text node': wrap('alert(1)'),
    'second root element': `${wrap('')}<svg ${SVG_NS}></svg>`,
    'non-svg root': '<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>',
    'xmlns:xlink rebound to another namespace': `<svg ${SVG_NS} xmlns:xlink="http://www.w3.org/1999/xhtml"></svg>`,
    'unclosed element': wrap('<g><path d="M0 0"/>'),
    'mismatched closing tag': wrap('<g><path d="M0 0"/></defs>')
  };

  for (const [label, svg] of Object.entries(BYPASSES)) {
    it(`rejects: ${label}`, () => {
      assert.ok(findSvgSafetyIssues(svg).length > 0, `not caught: ${svg}`);
    });
  }

  it('allows same-document references and plain style declarations', () => {
    const svg = wrap(
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient>' +
      '<path id="a" d="M0 0h9"/></defs>' +
      '<use href="#a"/><use xlink:href="#a"/>' +
      '<path d="M0 0" fill="url(#g)" style="marker:none;text-align:center"/>'
    );
    assert.deepEqual(findSvgSafetyIssues(svg), []);
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
