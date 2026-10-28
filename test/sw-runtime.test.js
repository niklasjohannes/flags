// The service worker at run time (GitHub #29): `sw.js` is loaded in a
// `node:vm` context with a fake `self` (scope `https://x.github.io/flags/`,
// a project site on a shared Pages origin), an in-memory `caches` and a stub
// `fetch`, and its install, activate and fetch handlers are run. Its
// generated block is swapped for a small fixture list, so the tests own
// every byte the worker downloads.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script, createContext } from 'node:vm';

import { hashFile, renderBlock, replaceBlock } from '../scripts/build-sw.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SW_SOURCE = readFileSync(join(REPO_ROOT, 'sw.js'), 'utf8');

const SCOPE = 'https://x.github.io/flags/';
const VERSION = '0123456789abcdef';
const CACHE_NAME = `flags-precache-${VERSION}`;

// What the fixture "server" holds, by path under the scope.
const FILES = Object.freeze({
  'index.html': { body: '<!doctype html><title>Flags</title>', type: 'text/html; charset=utf-8' },
  'css/style.css': { body: 'body { margin: 0; }', type: 'text/css' },
  'data/countries.json': { body: '{"countries":[]}', type: 'application/json' },
  // Served without a `Content-Type`, so the worker has to supply one.
  'manifest.webmanifest': { body: '{"name":"Flags"}', type: null }
});

const SOURCE = replaceBlock(SW_SOURCE, renderBlock(VERSION, Object.entries(FILES).map(([path, { body }]) => ({
  path,
  sha256: hashFile(Buffer.from(body))
}))));

// ---- Fakes ----

// A response as the browser's `fetch` gives it: `type` 'basic' (same-origin)
// and gzip headers that describe the wire bytes, not the decoded body.
function serverResponse(body, { type = 'basic', status = 200, contentType = 'text/plain', redirected = false } = {}) {
  const headers = { 'Content-Encoding': 'gzip', 'Content-Length': '7', 'X-Served-By': 'cdn' };
  if (contentType !== null) {
    headers['Content-Type'] = contentType;
  }
  // Bytes, not a string: a string body would get a `text/plain` type.
  const response = new Response(new TextEncoder().encode(body), { status, headers });
  Object.defineProperty(response, 'type', { value: type });
  Object.defineProperty(response, 'redirected', { value: redirected });
  return response;
}

// Serves `FILES`; `override(url, init)` may return a different response.
function createFetch(override = () => undefined) {
  const calls = [];
  const fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    const custom = await override(new URL(url), init);
    if (custom !== undefined) {
      return custom;
    }
    const { pathname } = new URL(url);
    const path = pathname.startsWith('/flags/') ? pathname.slice('/flags/'.length) : null;
    const file = path === null ? undefined : FILES[path];
    if (file === undefined) {
      return serverResponse('not found', { status: 404 });
    }
    return serverResponse(file.body, { contentType: file.type });
  };
  return { fetch, calls };
}

function keyOf(request) {
  return typeof request === 'string' ? request : request.url;
}

function withoutSearch(href) {
  const url = new URL(href);
  url.search = '';
  url.hash = '';
  return url.href;
}

// `CacheStorage` in memory: name -> Map(url -> Response), in creation order.
function createCaches(initialNames = []) {
  const store = new Map(initialNames.map((name) => [name, new Map()]));
  const log = { opened: [], deleted: [] };
  const openCache = (entries) => ({
    async put(request, response) {
      entries.set(keyOf(request), response);
    },
    async match(request, options = {}) {
      return matchIn(entries, request, options);
    }
  });
  const matchIn = (entries, request, { ignoreSearch = false } = {}) => {
    const wanted = ignoreSearch ? withoutSearch(keyOf(request)) : keyOf(request).split('#')[0];
    for (const [key, response] of entries) {
      const candidate = ignoreSearch ? withoutSearch(key) : key;
      if (candidate === wanted) {
        return response.clone();
      }
    }
    return undefined;
  };
  const caches = {
    async open(name) {
      log.opened.push(name);
      if (!store.has(name)) {
        store.set(name, new Map());
      }
      return openCache(store.get(name));
    },
    async keys() {
      return [...store.keys()];
    },
    async delete(name) {
      log.deleted.push(name);
      return store.delete(name);
    },
    async match(request, { cacheName, ...options } = {}) {
      const names = cacheName === undefined ? [...store.keys()] : [cacheName];
      for (const name of names) {
        const entries = store.get(name);
        const found = entries === undefined ? undefined : matchIn(entries, request, options);
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    }
  };
  return { caches, store, log };
}

// Run sw.js in its own context. Returns the captured handlers, the fakes and
// a call log (`skipWaiting` / `clients.claim`, in order).
function loadWorker({ fetch = createFetch().fetch, caches = createCaches().caches } = {}) {
  const handlers = new Map();
  const calls = [];
  const sandbox = {
    registration: { scope: SCOPE },
    addEventListener: (type, handler) => handlers.set(type, handler),
    skipWaiting: async () => {
      calls.push('skipWaiting');
    },
    clients: {
      claim: async () => {
        calls.push('claim');
      }
    },
    caches,
    fetch,
    crypto: globalThis.crypto,
    Response,
    URL,
    console
  };
  sandbox.self = sandbox;
  const context = createContext(sandbox);
  new Script(SOURCE, { filename: 'sw.js' }).runInContext(context);
  return { handlers, calls };
}

// Dispatch an extendable event; resolves (or rejects) with `waitUntil`.
async function dispatchLifecycle(worker, type) {
  let promise = Promise.resolve();
  worker.handlers.get(type)({ waitUntil: (value) => { promise = value; } });
  return promise;
}

// Dispatch a fetch event. Resolves to the response, or `null` when the
// worker did not call `respondWith` (the browser handles the request).
async function dispatchFetch(worker, url, { mode = 'no-cors', method = 'GET', cache = 'default' } = {}) {
  let response = null;
  worker.handlers.get('fetch')({
    request: { url, mode, method, cache },
    respondWith: (value) => { response = value; }
  });
  return response === null ? null : await response;
}

// A worker that has installed the fixture files.
async function installedWorker({ fetch } = {}) {
  const fake = createCaches();
  const worker = loadWorker({ fetch, caches: fake.caches });
  await dispatchLifecycle(worker, 'install');
  return { worker, ...fake };
}

// ---- Tests ----

describe('sw.js install', () => {
  it('fetches each file cache-busted and stores it under the clean URL with only `Content-Type`', async () => {
    const server = createFetch();
    const { worker, store } = await installedWorker({ fetch: server.fetch });
    assert.deepEqual(worker.calls, ['skipWaiting']);

    for (const { url, init } of server.calls) {
      assert.equal(new URL(url).searchParams.get('v'), VERSION);
      assert.equal(init.cache, 'reload');
    }
    assert.deepEqual([...store.keys()], [CACHE_NAME]);
    const entries = store.get(CACHE_NAME);
    assert.deepEqual([...entries.keys()].sort(), Object.keys(FILES).map((path) => `${SCOPE}${path}`).sort());
    for (const [path, { body, type }] of Object.entries(FILES)) {
      const response = entries.get(`${SCOPE}${path}`);
      assert.equal(response.status, 200);
      assert.equal(await response.clone().text(), body);
      assert.deepEqual([...response.headers.keys()], ['content-type']);
      assert.equal(response.headers.get('Content-Type'), type ?? 'application/manifest+json');
    }
  });

  it('rejects the install when a body does not match its recorded hash', async () => {
    const server = createFetch((url) => url.pathname === '/flags/css/style.css'
      ? serverResponse('body { margin: 1px; }', { contentType: 'text/css' })
      : undefined);
    const worker = loadWorker({ fetch: server.fetch });
    await assert.rejects(dispatchLifecycle(worker, 'install'), /css\/style\.css .*does not match/);
    assert.deepEqual(worker.calls, []);
  });

  for (const [name, options] of Object.entries({
    'an HTTP error': { status: 500 },
    'an opaque response': { type: 'opaque' },
    'a redirected response': { redirected: true }
  })) {
    it(`rejects the install on ${name}`, async () => {
      const server = createFetch((url) => url.pathname === '/flags/index.html'
        ? serverResponse(FILES['index.html'].body, { contentType: 'text/html', ...options })
        : undefined);
      const worker = loadWorker({ fetch: server.fetch });
      await assert.rejects(dispatchLifecycle(worker, 'install'), /Precaching \.\/index\.html failed/);
      assert.deepEqual(worker.calls, []);
    });
  }
});

describe('sw.js activate', () => {
  it('deletes only this app\'s stale caches, then claims the clients', async () => {
    const others = ['other-project-v3', 'workbox-precache-v2', 'flags-x-precache-1', 'flagsprecache-old'];
    const fake = createCaches(['flags-precache-0000000000000000', CACHE_NAME, 'flags-precache-ffff', ...others]);
    const worker = loadWorker({ caches: fake.caches });
    await dispatchLifecycle(worker, 'activate');
    assert.deepEqual(fake.log.deleted.sort(), ['flags-precache-0000000000000000', 'flags-precache-ffff']);
    assert.deepEqual([...fake.store.keys()], [CACHE_NAME, ...others]);
    assert.deepEqual(worker.calls, ['claim']);
  });
});

describe('sw.js fetch', () => {
  it('does not intercept requests outside its scope, other origins or non-GETs', async () => {
    const { worker } = await installedWorker();
    for (const url of [
      'https://x.github.io/flags-x/index.html',
      'https://x.github.io/flags-x/',
      'https://x.github.io/other/flags/index.html',
      'https://x.github.io/',
      'https://x.github.io/flags',
      'https://example.com/flags/index.html'
    ]) {
      assert.equal(await dispatchFetch(worker, url), null, url);
      assert.equal(await dispatchFetch(worker, url, { mode: 'navigate' }), null, url);
    }
    assert.equal(await dispatchFetch(worker, `${SCOPE}index.html`, { method: 'POST' }), null);
  });

  it('serves in-scope files from its cache, without the network', async () => {
    const offline = createFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const fake = createCaches();
    const installer = loadWorker({ caches: fake.caches });
    await dispatchLifecycle(installer, 'install');
    const worker = loadWorker({ fetch: offline.fetch, caches: fake.caches });
    const response = await dispatchFetch(worker, `${SCOPE}css/style.css`);
    assert.equal(await response.text(), FILES['css/style.css'].body);
    assert.deepEqual(offline.calls, []);
    // Reading never opens (and so never recreates) a cache.
    assert.deepEqual(fake.log.opened, [CACHE_NAME]);
  });

  it('maps every app-shell navigation to the cached index.html', async () => {
    const offline = createFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const fake = createCaches();
    await dispatchLifecycle(loadWorker({ caches: fake.caches }), 'install');
    const worker = loadWorker({ fetch: offline.fetch, caches: fake.caches });
    for (const url of [SCOPE, `${SCOPE}?x`, `${SCOPE}?source=pwa#top`, `${SCOPE}index.html`, `${SCOPE}index.html#y`, `${SCOPE}index.html?v=1`]) {
      const response = await dispatchFetch(worker, url, { mode: 'navigate' });
      assert.equal(await response.text(), FILES['index.html'].body, url);
    }
    assert.deepEqual(offline.calls, []);
  });

  it('falls back to index.html for an unknown navigation when offline', async () => {
    const offline = createFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const fake = createCaches();
    await dispatchLifecycle(loadWorker({ caches: fake.caches }), 'install');
    const worker = loadWorker({ fetch: offline.fetch, caches: fake.caches });
    const response = await dispatchFetch(worker, `${SCOPE}nowhere`, { mode: 'navigate' });
    assert.equal(await response.text(), FILES['index.html'].body);
    // A cached non-shell file is found whatever its query string.
    const data = await dispatchFetch(worker, `${SCOPE}data/countries.json?t=1`, { mode: 'navigate' });
    assert.equal(await data.text(), FILES['data/countries.json'].body);
  });

  it('passes an uncached in-scope request to the network and stores nothing', async () => {
    const server = createFetch((url) => url.pathname === '/flags/extra.txt' ? serverResponse('extra') : undefined);
    const { worker, store } = await installedWorker({ fetch: server.fetch });
    const response = await dispatchFetch(worker, `${SCOPE}extra.txt`);
    assert.equal(await response.text(), 'extra');
    assert.equal(store.get(CACHE_NAME).has(`${SCOPE}extra.txt`), false);
  });
});
