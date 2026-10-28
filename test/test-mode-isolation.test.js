// Test mode must never read or write SRS state (spec #6, PLAN decision 4),
// and a test in progress is never persisted. This reads the sources of the
// test-mode files and of the shared modules they import, and fails if any of
// them reaches for storage or the SRS write path.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Files owned by spec #6.
const TEST_MODE_FILES = Object.freeze([
  'js/views/test.js',
  'js/views/results.js',
  'js/test-pass.js'
]);

// Shared modules the test-mode files may import, and what each may take.
// `null` means any named import (they are pure or DOM-only).
const ALLOWED_IMPORTS = Object.freeze({
  'js/question.js': null,
  'js/srs.js': ['REGIONS'],
  'js/test-pass.js': null,
  'js/ui.js': null
});

// The SRS write path and everything that touches storage.
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

function readSource(path) {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

// `{ names, from }` for every static `import ... from '...'`, with `from`
// resolved to a repo-relative path. Namespace and default imports give
// `names: null`.
function listImports(path) {
  const source = readSource(path);
  const imports = [];
  for (const match of source.matchAll(/^import\s+([^;]*?)\s+from\s+'([^']+)';/gm)) {
    const [, clause, specifier] = match;
    const from = join(dirname(path), specifier).split('\\').join('/');
    const named = /^\{([^}]*)\}$/.exec(clause.trim());
    const names = named === null
      ? null
      : named[1].split(',').map((name) => name.trim()).filter((name) => name !== '');
    imports.push({ names, from });
  }
  return imports;
}

function findForbidden(source) {
  return FORBIDDEN_NAMES.filter((name) => source.includes(name));
}

// Source without comments, for shared modules whose comments may mention
// storage (e.g. "no `localStorage`"). Test-mode files are scanned whole.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

describe('test mode isolation', () => {
  for (const path of TEST_MODE_FILES) {
    describe(path, () => {
      const source = readSource(path);

      it('never mentions storage or the SRS write path', () => {
        assert.deepEqual(findForbidden(source), []);
      });

      it('only imports allowed shared modules and names', () => {
        assert.ok(!/\bimport\s*\(/.test(source), 'no dynamic `import()`');
        assert.ok(!/\brequire\s*\(/.test(source), 'no `require()`');
        const imports = listImports(path);
        // The scan must see the real import lines, or it would prove nothing.
        const importLines = source.match(/^import\s/gm) ?? [];
        assert.equal(imports.length, importLines.length, 'every import line was parsed');
        for (const { names, from } of imports) {
          assert.ok(Object.hasOwn(ALLOWED_IMPORTS, from), `${path} imports ${from}`);
          const allowed = ALLOWED_IMPORTS[from];
          if (allowed !== null) {
            assert.ok(names !== null, `${path} must import named bindings from ${from}`);
            for (const name of names) {
              assert.ok(allowed.includes(name), `${path} imports \`${name}\` from ${from}`);
            }
          }
        }
      });
    });
  }

  it('checks the files that the views actually load', () => {
    const imported = new Set(TEST_MODE_FILES.flatMap((path) => listImports(path).map(({ from }) => from)));
    assert.ok(imported.has('js/question.js'));
    assert.ok(imported.has('js/test-pass.js'));
  });

  // The shared question UI is the only shared module in the test view that
  // imports storage at all. Pin down that it only reads a constant from it
  // and writes nothing, so the guarantee above holds transitively.
  it('js/question.js only takes `QUIZ_MODES` from storage and writes nothing', () => {
    assert.deepEqual(findForbidden(stripComments(readSource('js/question.js'))), []);
    const fromStorage = listImports('js/question.js').filter(({ from }) => from === 'js/storage.js');
    assert.deepEqual(fromStorage, [{ names: ['QUIZ_MODES'], from: 'js/storage.js' }]);
  });

  it('js/ui.js and js/quiz.js never touch storage', () => {
    for (const path of ['js/ui.js', 'js/quiz.js']) {
      assert.deepEqual(findForbidden(stripComments(readSource(path))), [], path);
      assert.ok(!listImports(path).some(({ from }) => from === 'js/storage.js'), path);
    }
  });
});
