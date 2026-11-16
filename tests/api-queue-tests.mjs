/**
 * Integration tests for the request queue, retry/backoff and cache fallback.
 * Uses a fake chrome.storage.local and a fake fetch; no network.
 */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);

let store = {};
let fetchCalls = [];

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

const fakeChrome = {
  runtime: { lastError: null },
  storage: {
    local: {
      get(keys, callback) {
        let result = {};
        if (keys == null) {
          result = clone(store);
        } else if (typeof keys === 'string') {
          if (Object.prototype.hasOwnProperty.call(store, keys)) result[keys] = clone(store[keys]);
        } else if (Array.isArray(keys)) {
          for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(store, key)) result[key] = clone(store[key]);
          }
        } else if (typeof keys === 'object') {
          for (const [key, fallback] of Object.entries(keys)) {
            result[key] = Object.prototype.hasOwnProperty.call(store, key)
              ? clone(store[key])
              : fallback;
          }
        }
        setTimeout(() => callback(result), 0);
      },
      set(items, callback) {
        for (const [key, value] of Object.entries(items)) store[key] = clone(value);
        setTimeout(() => callback && callback(), 0);
      },
      remove(keys, callback) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
        setTimeout(() => callback && callback(), 0);
      },
      clear(callback) {
        store = {};
        setTimeout(() => callback && callback(), 0);
      },
      getBytesInUse(keys, callback) {
        const value = keys == null ? store : keys;
        setTimeout(() => callback(JSON.stringify(value).length), 0);
      },
    },
  },
};

globalThis.chrome = fakeChrome;

const API = require('../src/lib/api.js');

const originalFetch = globalThis.fetch;

function makeResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        return Object.prototype.hasOwnProperty.call(headers, key) ? headers[key] : null;
      },
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

function reset() {
  store = {};
  fetchCalls = [];
  API.__resetQueueForTests();
}

function installFetch(responses) {
  const queue = responses.slice();
  globalThis.fetch = async function (url, options) {
    fetchCalls.push({ url: String(url), time: Date.now() });
    if (!queue.length) throw new Error('Unexpected fetch call: ' + url);
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
}

function makeCfArchive(count, prefix) {
  const problems = [];
  for (let i = 0; i < count; i += 1) {
    problems.push({
      contestId: 1000 + i,
      index: 'A',
      name: (prefix || '') + 'Problem ' + i,
      rating: 800 + (i % 20) * 100,
      tags: ['math'],
    });
  }
  return { status: 'OK', result: { problems, problemStatistics: [] } };
}

const FAST = { minRequestDelayMs: 1000, maxRetries: 0 };
const RETRY = { minRequestDelayMs: 1000, maxRetries: 2 };

let passed = 0;

async function test(name, fn) {
  try {
    reset();
    await fn();
    passed += 1;
    console.log('  ok  ' + name);
  } catch (error) {
    console.error('  FAIL ' + name + '\n       ' + error.message);
    process.exitCode = 1;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log('API queue and cache');
await test('serializes requests and enforces the minimum delay', async () => {
  installFetch([
    makeResponse(200, { ok: 1 }),
    makeResponse(200, { ok: 2 }),
  ]);
  const started = Date.now();
  const results = await Promise.all([
    API.requestJson('https://codeforces.com/api/fake1', { host: 'codeforces' }, FAST),
    API.requestJson('https://codeforces.com/api/fake2', { host: 'codeforces' }, FAST),
  ]);
  const elapsed = Date.now() - started;
  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(results, [{ ok: 1 }, { ok: 2 }]);
  const gap = fetchCalls[1].time - fetchCalls[0].time;
  assert.ok(gap >= 950, 'request gap was ' + gap + 'ms');
  assert.ok(elapsed >= 950, 'total elapsed was ' + elapsed + 'ms');
});

await test('retries HTTP 429 after Retry-After and persists cooldown', async () => {
  installFetch([
    makeResponse(429, 'slow down', { 'retry-after': '1' }),
    makeResponse(200, { ok: true }),
  ]);
  const started = Date.now();
  const result = await API.requestJson('https://codeforces.com/api/fake', { host: 'codeforces' }, RETRY);
  const elapsed = Date.now() - started;
  assert.deepEqual(result, { ok: true });
  assert.equal(fetchCalls.length, 2);
  assert.ok(elapsed >= 800, 'retry did not wait long enough: ' + elapsed + 'ms');
  assert.ok(store['cfs:cooldown:v1'], 'cooldown was not persisted');
  assert.ok(store['cfs:cooldown:v1'].codeforces.until >= Date.now() - 1000);
});

await test('handles a Codeforces FAILED limit response as retryable', async () => {
  // maxRetries=0: classification must still produce RATE_LIMITED and a cooldown.
  installFetch([
    makeResponse(400, { status: 'FAILED', comment: 'Call limit exceeded' }),
  ]);
  await assert.rejects(
    () => API.requestJson('https://codeforces.com/api/fake', { host: 'codeforces' }, FAST),
    (error) => error.code === 'RATE_LIMITED'
  );
  assert.equal(fetchCalls.length, 1);
  assert.ok(store['cfs:cooldown:v1'].codeforces.until > Date.now());
});

await test('classifies a Cloudflare HTML 403 and stops after maxRetries', async () => {
  installFetch([
    makeResponse(403, '<html><title>Just a moment...</title>Cloudflare</html>'),
  ]);
  await assert.rejects(
    () => API.requestJson('https://codeforces.com/api/fake', { host: 'codeforces' }, FAST),
    (error) => error.code === 'CLOUDFLARE'
  );
  assert.equal(fetchCalls.length, 1);
  assert.ok(store['cfs:cooldown:v1'].codeforces.until > Date.now());
});

await test('serves a fresh archive from cache and falls back to stale data', async () => {
  installFetch([
    makeResponse(200, makeCfArchive(650)),
    makeResponse(200, makeCfArchive(650, 'Задача ')),
  ]);
  const settings = { archiveTtlHours: 24, maxRetries: 0, minRequestDelayMs: 1000 };
  const first = await API.fetchCfArchive({ settings, force: false });
  assert.equal(first.fromCache, false);
  assert.equal(first.stale, false);
  assert.equal(first.data.problems.length, 650);
  assert.ok(first.data.localized.length > 0, 'localized aliases were not built');
  assert.equal(fetchCalls.length, 2);
  assert.ok(store['cfs:archive:cf:v2']);

  const cached = await API.fetchCfArchive({ settings, force: false });
  assert.equal(cached.fromCache, true);
  assert.equal(cached.stale, false);
  assert.equal(fetchCalls.length, 2, 'fresh cache should not hit the network');

  globalThis.fetch = async () => { throw new Error('network down'); };
  const stale = await API.fetchCfArchive({ settings, force: true });
  assert.equal(stale.fromCache, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.data.problems.length, 650);
});

console.log('\nAPI queue: ' + passed + ' tests passed' + (process.exitCode ? ', failures' : ''));
