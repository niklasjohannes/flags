// Test mode must never read or write SRS state (spec #6, PLAN decision 4),
// and a test in progress is never persisted. This walks the static import
// graph from the test-mode views and fails if any module they load reaches
// for storage or the SRS write path.
//
// Two modules hold exactly what is banned, so they are boundaries rather than
// scanned: `js/storage.js` (all storage access) and `js/srs.js` (the write
// path). Every import of a boundary may only take the names allowed below.
// It guards against mistakes, not deliberate evasion (string concatenation).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ENTRY_POINTS = Object.freeze(['js/views/test.js', 'js/views/results.js']);

// Boundary module -> the names any reached module may import from it.
const BOUNDARY_IMPORTS = Object.freeze({
  'js/storage.js': Object.freeze(['QUIZ_MODES']),
  'js/srs.js': Object.freeze(['REGIONS'])
});

// Storage APIs and the SRS write path.
const FORBIDDEN_NAMES = Object.freeze([
  'updateCardState',
  'saveStates',
  'requeueLapse',
  'loadStates',
  'saveMode',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'document.cookie'
]);

// ---- Helpers ----

function readSource(path) {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

// Source without comments, so prose like "no `localStorage`" is not a hit.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

// Imported names of an import/export clause (`{ a, b as c }` -> ['a', 'b']),
// or `null` for a default, namespace or bare import.
function parseNames(clause) {
  const named = /^\{([^}]*)\}$/.exec(clause.trim());
  if (named === null) {
    return null;
  }
  return named[1]
    .split(',')
    .map((part) => part.trim().split(/\s+as\s+/)[0])
    .filter((name) => name !== '');
}

// `{ names, from }` for every static `import`/`export ... from` and bare
// `import '...'` in `path`, `from` resolved to a repo-relative path.
function listImports(path, code) {
  const resolve = (specifier) => {
    assert.ok(/^\.\.?\//.test(specifier), `${path}: \`${specifier}\` must be a relative specifier`);
    return normalize(join(dirname(path), specifier)).split('\\').join('/');
  };
  const imports = [];
  for (const [, clause, specifier] of code.matchAll(/\b(?:import|export)\s+([^'";]*?)\s*\bfrom\s*['"]([^'"]+)['"]/g)) {
    imports.push({ names: parseNames(clause), from: resolve(specifier) });
  }
  for (const [, specifier] of code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) {
    imports.push({ names: null, from: resolve(specifier) });
  }
  return imports;
}

// Walk the graph from `ENTRY_POINTS`. Returns every reached module (code
// stripped of comments) and every import of a boundary module.
function walkGraph() {
  const modules = new Map();
  const boundaryImports = [];
  const queue = [...ENTRY_POINTS];
  while (queue.length > 0) {
    const path = queue.shift();
    if (modules.has(path)) {
      continue;
    }
    const code = stripComments(readSource(path));
    const imports = listImports(path, code);
    modules.set(path, { code, imports });
    for (const entry of imports) {
      if (Object.hasOwn(BOUNDARY_IMPORTS, entry.from)) {
        boundaryImports.push({ path, ...entry });
      } else {
        queue.push(entry.from);
      }
    }
  }
  return { modules, boundaryImports };
}

// ---- Tests ----

describe('test mode isolation', () => {
  const { modules, boundaryImports } = walkGraph();

  it('reaches the shared modules the views really load', () => {
    for (const path of ['js/test-pass.js', 'js/question.js', 'js/quiz.js', 'js/ui.js']) {
      assert.ok(modules.has(path), path);
    }
    assert.ok(boundaryImports.some(({ from }) => from === 'js/storage.js'), 'question.js imports storage.js');
  });

  it('parses every import line it scans', () => {
    for (const [path, { code, imports }] of modules) {
      const lines = code.match(/^\s*(?:import\s|export\s[^;]*\bfrom\b)/gm) ?? [];
      assert.equal(imports.length, lines.length, path);
    }
  });

  it('no reached module mentions storage or the SRS write path', () => {
    for (const [path, { code }] of modules) {
      assert.deepEqual(FORBIDDEN_NAMES.filter((name) => code.includes(name)), [], path);
      assert.ok(!/\bimport\s*\(/.test(code), `${path}: no dynamic \`import()\``);
      assert.ok(!/\brequire\s*\(/.test(code), `${path}: no \`require()\``);
    }
  });

  it('only takes allowed names from storage.js and srs.js', () => {
    for (const { path, names, from } of boundaryImports) {
      assert.ok(names !== null, `${path} must import named bindings from ${from}`);
      for (const name of names) {
        assert.ok(BOUNDARY_IMPORTS[from].includes(name), `${path} imports \`${name}\` from ${from}`);
      }
    }
  });
});
