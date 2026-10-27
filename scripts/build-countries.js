// Builds `data/countries.json` from the vendored flag-icons code list plus the
// hand-maintained enrichment in `scripts/country-overrides.js`. Deterministic:
// same inputs, byte-identical output. Zero dependencies.
//
// Usage (from the repo root):
//   node scripts/build-countries.js
//       Rebuild data/countries.json only.
//   node scripts/build-countries.js --flags-from <extracted-flag-icons>/flags/4x3
//       Also (re)vendor flags/<code>.svg for exactly the kept codes, replacing
//       flags/ wholesale. Every SVG and the JSON are validated before anything is
//       written. Reads the SVGs as text; never executes anything
//       from the upstream checkout. Full re-vendoring steps: docs/DATA.md.

import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SOURCE, REGIONS, POLICY, EXCLUDED, ENTRIES } from './country-overrides.js';
import { findSvgSafetyIssues, normaliseSvgIds } from './svg-safety.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM_PATH = join(REPO_ROOT, 'vendor', 'flag-icons', 'country.json');
const OUTPUT_PATH = join(REPO_ROOT, 'data', 'countries.json');
const FLAGS_DIR = join(REPO_ROOT, 'flags');
// Staging for the atomic flags/ swap; inside the gitignored scratch dir.
const STAGING_DIR = join(REPO_ROOT, '.vendor-tmp', 'flags-staging');
const PREVIOUS_DIR = join(REPO_ROOT, '.vendor-tmp', 'flags-previous');

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
 * Read `<code>.svg` for every kept code from an extracted flag-icons `flags/4x3`
 * directory and validate all of them, without writing anything. Throws one
 * error listing every missing, unsafe or duplicate file.
 * @param {string} fromDir Path to the upstream `flags/4x3` directory.
 * @param {string[]} codes Kept lowercase codes.
 * @returns {Map<string, string>} Code -> SVG source, in `codes` order.
 */
export function readUpstreamFlags(fromDir, codes) {
  if (typeof fromDir !== 'string' || fromDir.length === 0) {
    throw new TypeError('`fromDir` must be a non-empty string.');
  }
  if (!Array.isArray(codes)) {
    throw new TypeError('`codes` must be an array.');
  }
  const svgs = new Map();
  const seen = new Map();
  const problems = [];
  for (const code of codes) {
    let svg;
    try {
      svg = readFileSync(join(fromDir, `${code}.svg`), 'utf8');
    } catch (error) {
      problems.push(`\`${code}.svg\` could not be read (${error.code ?? error.message})`);
      continue;
    }
    const issues = findSvgSafetyIssues(svg);
    if (issues.length > 0) {
      problems.push(`\`${code}.svg\` failed the safety check: ${issues.join('; ')}`);
    }
    const key = normaliseSvgIds(code, svg);
    if (seen.has(key)) {
      problems.push(`\`${code}.svg\` is identical to \`${seen.get(key)}.svg\` apart from ids`);
    }
    seen.set(key, code);
    svgs.set(code, svg);
  }
  if (problems.length > 0) {
    throw new Error(`Refusing to vendor flags:\n  ${problems.join('\n  ')}`);
  }
  return svgs;
}

/**
 * Replace `flags/` with exactly the given SVGs. The new set is written to a
 * staging directory first and swapped in with renames, so `flags/` is never
 * left half-written.
 * @param {Map<string, string>} svgs Code -> validated SVG source.
 * @returns {void}
 */
export function replaceFlagsDir(svgs) {
  if (!(svgs instanceof Map)) {
    throw new TypeError('`svgs` must be a Map.');
  }
  rmSync(STAGING_DIR, { recursive: true, force: true });
  rmSync(PREVIOUS_DIR, { recursive: true, force: true });
  mkdirSync(STAGING_DIR, { recursive: true });
  for (const [code, svg] of svgs) {
    writeFileSync(join(STAGING_DIR, `${code}.svg`), svg);
  }
  if (existsSync(FLAGS_DIR)) {
    renameSync(FLAGS_DIR, PREVIOUS_DIR);
  }
  renameSync(STAGING_DIR, FLAGS_DIR);
  rmSync(PREVIOUS_DIR, { recursive: true, force: true });
}

/**
 * Write a file via a temporary sibling and a rename, so readers never see a
 * partial file.
 * @param {string} path Destination path.
 * @param {string} content File contents.
 * @returns {void}
 */
function writeFileAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, content);
  renameSync(temporaryPath, path);
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
  const flagIndex = process.argv.indexOf('--flags-from');
  const fromDir = flagIndex === -1 ? null : process.argv[flagIndex + 1];
  if (flagIndex !== -1 && (fromDir === undefined || fromDir.startsWith('--'))) {
    throw new TypeError('`--flags-from` needs a path to an extracted flag-icons `flags/4x3` directory.');
  }

  // Validate everything before writing anything.
  const document = buildFromRepo();
  const serialised = serialiseCountries(document);
  const svgs = fromDir === null
    ? null
    : readUpstreamFlags(fromDir, document.countries.map((country) => country.code));

  if (svgs !== null) {
    replaceFlagsDir(svgs);
    console.log(`Vendored ${svgs.size} SVGs into flags/.`);
  }
  writeFileAtomic(OUTPUT_PATH, serialised);
  console.log(`Wrote ${document.countries.length} entries to data/countries.json.`);
}
