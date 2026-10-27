// Builds `data/countries.json` from the vendored flag-icons code list plus the
// hand-maintained enrichment in `scripts/country-overrides.js`. Deterministic:
// same inputs, byte-identical output. Zero dependencies.
//
// Usage (from the repo root):
//   node scripts/build-countries.js
//       Rebuild data/countries.json only.
//   node scripts/build-countries.js --flags-from <extracted-flag-icons>/flags/4x3
//       Also (re)vendor flags/<code>.svg for exactly the kept codes, and delete
//       any other SVG in flags/. Reads the SVGs as text; never executes anything
//       from the upstream checkout. Full re-vendoring steps: docs/DATA.md.

import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SOURCE, REGIONS, POLICY, EXCLUDED, ENTRIES } from './country-overrides.js';
import { findSvgSafetyIssues } from './svg-safety.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM_PATH = join(REPO_ROOT, 'vendor', 'flag-icons', 'country.json');
const OUTPUT_PATH = join(REPO_ROOT, 'data', 'countries.json');
const FLAGS_DIR = join(REPO_ROOT, 'flags');

/**
 * Combine the upstream code list with the overrides into the `countries.json`
 * document. Throws if the two disagree in any way.
 * @param {Array<{code: string, iso: boolean}>} upstream Parsed flag-icons `country.json`.
 * @param {{source: object, regions: string[], policy: object, excluded: Record<string, string>, entries: Record<string, object>}} overrides
 * @returns {{meta: object, countries: Array<{code: string, name: string, aliases: string[], region: string, sovereign: boolean, parentCode: string | null}>}}
 */
export function buildCountries(upstream, overrides) {
  if (!Array.isArray(upstream)) {
    throw new TypeError('`upstream` must be an array.');
  }
  if (overrides === null || typeof overrides !== 'object') {
    throw new TypeError('`overrides` must be an object.');
  }
  const { source, regions, policy, excluded, entries } = overrides;

  const isoCodes = upstream.filter((item) => item.iso === true).map((item) => item.code);
  const isoSet = new Set(isoCodes);
  if (isoSet.size !== isoCodes.length) {
    throw new Error('Upstream `country.json` lists an ISO code more than once.');
  }

  for (const code of [...Object.keys(entries), ...Object.keys(excluded)]) {
    if (!isoSet.has(code)) {
      throw new Error(`Override \`${code}\` is not an ISO code in the upstream list.`);
    }
    if (code in entries && code in excluded) {
      throw new Error(`\`${code}\` is both kept and excluded.`);
    }
  }
  const undecided = isoCodes.filter((code) => !(code in entries) && !(code in excluded));
  if (undecided.length > 0) {
    throw new Error(`Upstream ISO codes with no override decision: ${undecided.sort().join(', ')}.`);
  }

  const countries = Object.keys(entries)
    .sort()
    .map((code) => {
      const { name, aliases, region, sovereign, parentCode } = entries[code];
      if (!regions.includes(region)) {
        throw new RangeError(`\`${code}\` has region \`${region}\`, not in the closed list.`);
      }
      if (parentCode !== null && !(parentCode in entries && entries[parentCode].sovereign)) {
        throw new RangeError(`\`${code}\` has parentCode \`${parentCode}\`, which is not a kept sovereign entry.`);
      }
      return { code, name, aliases: [...aliases], region, sovereign, parentCode };
    });

  const sortedExcluded = Object.fromEntries(
    Object.keys(excluded).sort().map((code) => [code, excluded[code]])
  );

  return {
    meta: {
      source,
      regions,
      policy,
      excluded: sortedExcluded
    },
    countries
  };
}

/**
 * Copy `<code>.svg` for every kept code from an extracted flag-icons `flags/4x3`
 * directory into `flags/`, and delete any SVG in `flags/` that is not kept.
 * @param {string} fromDir Path to the upstream `flags/4x3` directory.
 * @param {string[]} codes Kept lowercase codes.
 * @returns {void}
 */
export function vendorFlags(fromDir, codes) {
  if (typeof fromDir !== 'string' || fromDir.length === 0) {
    throw new TypeError('`fromDir` must be a non-empty string.');
  }
  if (!Array.isArray(codes)) {
    throw new TypeError('`codes` must be an array.');
  }
  mkdirSync(FLAGS_DIR, { recursive: true });
  const keep = new Set(codes);
  for (const code of codes) {
    const svg = readFileSync(join(fromDir, `${code}.svg`), 'utf8');
    const issues = findSvgSafetyIssues(svg);
    if (issues.length > 0) {
      throw new Error(`Upstream \`${code}.svg\` failed the safety check: ${issues.join('; ')}.`);
    }
    writeFileSync(join(FLAGS_DIR, `${code}.svg`), svg);
  }
  for (const file of readdirSync(FLAGS_DIR)) {
    if (file.endsWith('.svg') && !keep.has(file.slice(0, -'.svg'.length))) {
      unlinkSync(join(FLAGS_DIR, file));
    }
  }
}

/**
 * Serialise the document exactly as committed (2-space JSON, trailing newline).
 * @param {object} document Output of `buildCountries`.
 * @returns {string}
 */
export function serialiseCountries(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Read the committed inputs and build the document.
 * @returns {ReturnType<typeof buildCountries>}
 */
export function buildFromRepo() {
  const upstream = JSON.parse(readFileSync(UPSTREAM_PATH, 'utf8'));
  return buildCountries(upstream, {
    source: SOURCE,
    regions: REGIONS,
    policy: POLICY,
    excluded: EXCLUDED,
    entries: ENTRIES
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const document = buildFromRepo();
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, serialiseCountries(document));
  console.log(`Wrote ${document.countries.length} entries to data/countries.json.`);

  const flagIndex = process.argv.indexOf('--flags-from');
  if (flagIndex !== -1) {
    const fromDir = process.argv[flagIndex + 1];
    vendorFlags(fromDir, document.countries.map((country) => country.code));
    console.log(`Vendored ${document.countries.length} SVGs into flags/.`);
  }
}
