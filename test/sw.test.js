// The service worker's precache list and cache version (spec #8); its
// run-time behaviour is in test/sw-runtime.test.js. The list must be honest (every file exists, every app file is on it, nothing else
// is) and the committed version must match a fresh content hash, so CI fails
// when someone changes an app file and forgets `node scripts/build-sw.js`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

import {
  BLOCK_END,
  BLOCK_START,
  buildFromRepo,
  hashFile,
  hashFiles,
  renderBlock,
  replaceBlock
} from '../scripts/build-sw.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SW_SOURCE = readFileSync(join(REPO_ROOT, 'sw.js'), 'utf8');

// Written out here rather than taken from scripts/build-sw.js, so the test
// does not just repeat the generator's own rules.
const REQUIRED_FILES = Object.freeze(['index.html', 'manifest.webmanifest']);
const REQUIRED_DIRS = Object.freeze(['css', 'data', 'flags', 'fonts', 'icons', 'img', 'js']);
const FORBIDDEN_PREFIXES = Object.freeze([
  'test/', 'test-support/', 'scripts/', 'vendor/', 'docs/', '.claude/', '.github/', '.git/', '.tmp/',
  '.vendor-tmp/', 'node_modules/'
]);

// ---- Helpers ----

function readBlock(source) {
  const start = source.indexOf(BLOCK_START);
  const end = source.indexOf(BLOCK_END);
  assert.ok(start !== -1 && end > start, 'sw.js has no generated block.');
  return source.slice(start, end + BLOCK_END.length);
}

function parseBlock(block) {
  const version = block.match(/^const CACHE_VERSION = '([0-9a-f]+)';$/m)?.[1];
  const list = block.match(/^const PRECACHE_FILES = \[\n([\s\S]*?)\n\];$/m)?.[1];
  assert.ok(version !== undefined && list !== undefined, 'The generated block is malformed.');
  const files = list.split(',\n').map((line) => {
    const match = line.match(/^ {2}\['\.\/([^']+)', '([0-9a-f]{64})'\]$/);
    assert.ok(match !== null, `Unexpected line in \`PRECACHE_FILES\`: ${line}`);
    return { path: match[1], sha256: match[2] };
  });
  return { version, files, paths: files.map(({ path }) => path) };
}

function walk(relativeDir) {
  return readdirSync(join(REPO_ROOT, relativeDir), { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .flatMap((entry) => {
      const path = `${relativeDir}/${entry.name}`;
      return entry.isDirectory() ? walk(path) : [path];
    });
}

const committed = parseBlock(readBlock(SW_SOURCE));

// ---- Tests ----

describe('sw.js', () => {
  it('is a classic script that parses (no `import`/`export`)', () => {
    assert.doesNotThrow(() => new Script(SW_SOURCE, { filename: 'sw.js' }));
    assert.doesNotMatch(SW_SOURCE, /^\s*(import|export)\b/m);
    assert.doesNotMatch(SW_SOURCE, /importScripts\s*\(/);
  });

  it('is registered from js/app.js as `./sw.js`', () => {
    const app = readFileSync(join(REPO_ROOT, 'js', 'app.js'), 'utf8');
    assert.match(app, /navigator\.serviceWorker\.register\('\.\/sw\.js', \{ updateViaCache: 'none' \}\)/);
    // Resumed installed apps do not navigate, so the page checks itself.
    assert.match(app, /registration\.update\(\)/);
  });

  // The behaviour (install, activate, fetch) runs in test/sw-runtime.test.js.
  // These guard intent that a behaviour test cannot see.
  it('writes to a cache in one place only, the precache', () => {
    assert.equal(SW_SOURCE.match(/\.put\(/g)?.length, 1);
    assert.doesNotMatch(SW_SOURCE, /\.add(All)?\(/);
  });
});

describe('precache list', () => {
  it('matches a fresh build (run `node scripts/build-sw.js` if not)', () => {
    const fresh = buildFromRepo(REPO_ROOT);
    assert.deepEqual(committed.files, fresh.files, 'The precache list (or a file hash) is stale.');
    assert.equal(committed.version, fresh.version, 'CACHE_VERSION does not match the files\' content hash.');
    assert.equal(readBlock(SW_SOURCE), fresh.block);
  });

  it('records each file\'s SHA-256', () => {
    for (const { path, sha256 } of committed.files) {
      const actual = createHash('sha256').update(readFileSync(join(REPO_ROOT, path))).digest('hex');
      assert.equal(sha256, actual, `The hash of \`${path}\` is stale.`);
    }
  });

  it('lists only files that exist, each once', () => {
    assert.equal(new Set(committed.paths).size, committed.paths.length, 'A path is listed twice.');
    for (const path of committed.paths) {
      const full = join(REPO_ROOT, path);
      assert.ok(existsSync(full) && statSync(full).isFile(), `\`${path}\` is listed but does not exist.`);
      assert.equal(normalize(path), path, `\`${path}\` is not a normalised relative path.`);
    }
  });

  it('lists every file the app serves', () => {
    const listed = new Set(committed.paths);
    const required = [...REQUIRED_FILES, ...REQUIRED_DIRS.flatMap(walk)];
    const missing = required.filter((path) => !listed.has(path));
    assert.deepEqual(missing, [], 'App files missing from the precache list.');
  });

  it('lists nothing outside the app', () => {
    for (const path of committed.paths) {
      assert.ok(!FORBIDDEN_PREFIXES.some((prefix) => path.startsWith(prefix)), `\`${path}\` is not part of the app.`);
      assert.ok(!path.split('/').some((part) => part.startsWith('.')), `\`${path}\` is a dotfile.`);
      assert.notEqual(path, 'sw.js', 'sw.js must not precache itself.');
    }
  });

  it('covers every local URL in index.html and every module import', () => {
    const listed = new Set(committed.paths);
    const html = readFileSync(join(REPO_ROOT, 'index.html'), 'utf8');
    const urls = [...html.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((match) => normalize(match[1]));
    assert.ok(urls.length > 0);
    for (const url of urls) {
      assert.ok(listed.has(url), `index.html loads \`${url}\`, which is not precached.`);
    }
    for (const module of committed.paths.filter((path) => path.endsWith('.js'))) {
      const source = readFileSync(join(REPO_ROOT, module), 'utf8');
      for (const [, specifier] of source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'([^']+)'/gm)) {
        const target = normalize(join(dirname(module), specifier));
        assert.ok(listed.has(target), `\`${module}\` imports \`${target}\`, which is not precached.`);
      }
    }
  });
});

describe('hashFiles', () => {
  const files = [
    { path: 'a.txt', bytes: Buffer.from('alpha') },
    { path: 'b.txt', bytes: Buffer.from('beta') }
  ];

  it('is a 16-digit hex string, stable for the same input', () => {
    assert.match(hashFiles(files), /^[0-9a-f]{16}$/);
    assert.equal(hashFiles(files), hashFiles(files.map((file) => ({ ...file }))));
  });

  it('changes when any byte, path or file changes', () => {
    const base = hashFiles(files);
    assert.notEqual(hashFiles([files[0], { path: 'b.txt', bytes: Buffer.from('betA') }]), base);
    assert.notEqual(hashFiles([files[0], { path: 'c.txt', bytes: files[1].bytes }]), base);
    assert.notEqual(hashFiles([files[0]]), base);
    // Moving bytes across the boundary between two files changes it too.
    assert.notEqual(hashFiles([
      { path: 'a.txt', bytes: Buffer.from('alphab') },
      { path: 'b.txt', bytes: Buffer.from('eta') }
    ]), base);
  });

  it('rejects bad input', () => {
    assert.throws(() => hashFiles([]), TypeError);
    assert.throws(() => hashFiles([{ path: 'a', bytes: 'text' }]), TypeError);
  });
});

describe('hashFile', () => {
  it('is the hex SHA-256 of the bytes', () => {
    assert.equal(hashFile(Buffer.from('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.throws(() => hashFile('text'), TypeError);
  });
});

describe('renderBlock / replaceBlock', () => {
  const SHA = 'a'.repeat(64);

  it('round-trips through replaceBlock', () => {
    const files = [{ path: 'index.html', sha256: SHA }, { path: 'js/app.js', sha256: 'b'.repeat(64) }];
    const block = renderBlock('abc123', files);
    const source = `head\n${BLOCK_START}\nold\n${BLOCK_END}\ntail\n`;
    assert.equal(replaceBlock(source, block), `head\n${block}\ntail\n`);
    assert.deepEqual(parseBlock(block), { version: 'abc123', files, paths: ['index.html', 'js/app.js'] });
  });

  it('refuses paths that could escape the app or break the quoting, and bad hashes', () => {
    assert.throws(() => renderBlock('abc', [{ path: '../secret', sha256: SHA }]), RangeError);
    assert.throws(() => renderBlock('abc', [{ path: "it's.js", sha256: SHA }]), RangeError);
    assert.throws(() => renderBlock('abc', [{ path: 'a.js', sha256: 'abc' }]), TypeError);
    assert.throws(() => renderBlock('abc', ['a.js']), RangeError);
    assert.throws(() => renderBlock('ABC', [{ path: 'a.js', sha256: SHA }]), TypeError);
  });

  it('requires exactly one block', () => {
    assert.throws(() => replaceBlock('no markers', 'x'), /exactly one generated block/);
    const twice = `${BLOCK_START}\n${BLOCK_END}\n${BLOCK_START}\n${BLOCK_END}`;
    assert.throws(() => replaceBlock(twice, 'x'), /exactly one generated block/);
  });
});
