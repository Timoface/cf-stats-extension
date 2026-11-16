/**
 * chrome.storage.local helpers and cache bookkeeping.
 * Uses callback-style APIs so the same code works in Chrome and Firefox.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./constants.js'));
  } else {
    root.CFS_STORAGE = factory(root.CFS_CONST);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CONST) {
  'use strict';

  function api() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      return chrome.storage.local;
    }
    if (typeof browser !== 'undefined' && browser.storage && browser.storage.local) {
      return browser.storage.local;
    }
    throw new Error('chrome.storage.local is unavailable');
  }

  function runtimeLastError() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) {
        return chrome.runtime.lastError;
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  function call(method, args) {
    return new Promise(function (resolve, reject) {
      let area;
      try {
        area = api();
      } catch (error) {
        reject(error);
        return;
      }
      try {
        area[method].apply(area, args.concat([function (result) {
          const error = runtimeLastError();
          if (error) {
            reject(new Error(error.message || 'storage error'));
          } else {
            resolve(result);
          }
        }]));
      } catch (error) {
        reject(error);
      }
    });
  }

  function get(keys) {
    return call('get', [keys]);
  }

  function set(items) {
    return call('set', [items]);
  }

  function remove(keys) {
    return call('remove', [keys]);
  }

  function clear() {
    return call('clear', []);
  }

  function getBytesInUse(keys) {
    return call('getBytesInUse', [keys == null ? null : keys]).catch(function () {
      return null;
    });
  }

  function readCache(key) {
    return get(key).then(function (result) {
      const entry = result ? result[key] : null;
      if (!entry || typeof entry.fetchedAt !== 'number') return null;
      return entry;
    });
  }

  function writeCache(key, data) {
    const entry = { v: 1, fetchedAt: Date.now(), data };
    return set({ [key]: entry }).then(function () {
      return entry;
    });
  }

  function removeCache(keys) {
    return remove(Array.isArray(keys) ? keys : [keys]);
  }

  function isFresh(entry, ttlMs) {
    if (!entry || typeof entry.fetchedAt !== 'number') return false;
    return Date.now() - entry.fetchedAt < ttlMs;
  }

  function statusKey(handle) {
    return CONST.CACHE.STATUS_PREFIX + String(handle || '').toLowerCase();
  }

  async function rememberStatusHandle(handle) {
    const normalized = String(handle || '').toLowerCase();
    if (!normalized) return;
    const result = await get(CONST.CACHE.STATUS_INDEX);
    const current = result && Array.isArray(result[CONST.CACHE.STATUS_INDEX])
      ? result[CONST.CACHE.STATUS_INDEX]
      : [];
    const next = [normalized].concat(current.filter(function (item) {
      return item !== normalized;
    }));
    const evicted = next.slice(CONST.MAX_CACHED_HANDLES);
    await set({ [CONST.CACHE.STATUS_INDEX]: next.slice(0, CONST.MAX_CACHED_HANDLES) });
    if (evicted.length) {
      await remove(evicted.map(statusKey));
    }
  }

  async function clearAllCaches(options) {
    const opts = options || {};
    const all = await get(null);
    const keys = Object.keys(all || {}).filter(function (key) {
      if (!key.startsWith('cfs:')) return false;
      if (opts.keepSettings !== false && key === CONST.CACHE.SETTINGS) return false;
      return true;
    });
    if (keys.length) await remove(keys);
    return keys;
  }

  async function clearStatusCache(handle) {
    const normalized = String(handle || '').toLowerCase();
    if (!normalized) return;
    await remove(statusKey(normalized));
    const result = await get(CONST.CACHE.STATUS_INDEX);
    const current = result && Array.isArray(result[CONST.CACHE.STATUS_INDEX])
      ? result[CONST.CACHE.STATUS_INDEX]
      : [];
    await set({
      [CONST.CACHE.STATUS_INDEX]: current.filter(function (item) {
        return item !== normalized;
      }),
    });
  }

  async function getCacheInfo() {
    const all = await get(null);
    const bytes = await getBytesInUse(null);
    const data = all || {};
    const cfArchive = data[CONST.CACHE.CF_ARCHIVE] || null;
    const atcoderArchive = data[CONST.CACHE.ATCODER_ARCHIVE] || null;
    const statusKeys = Object.keys(data).filter(function (key) {
      return key.startsWith(CONST.CACHE.STATUS_PREFIX);
    });
    const settings = data[CONST.CACHE.SETTINGS] || null;
    const cooldown = data[CONST.CACHE.COOLDOWN] || null;

    return {
      bytesInUse: bytes,
      codeforcesArchive: cfArchive ? {
        fetchedAt: cfArchive.fetchedAt,
        count: cfArchive.data && Array.isArray(cfArchive.data.problems)
          ? cfArchive.data.problems.length
          : 0,
        version: cfArchive.v || 1,
      } : null,
      atcoderArchive: atcoderArchive ? {
        fetchedAt: atcoderArchive.fetchedAt,
        count: atcoderArchive.data && Array.isArray(atcoderArchive.data.problems)
          ? atcoderArchive.data.problems.length
          : 0,
        version: atcoderArchive.v || 1,
      } : null,
      statuses: statusKeys.map(function (key) {
        const entry = data[key] || {};
        return {
          handle: key.slice(CONST.CACHE.STATUS_PREFIX.length),
          fetchedAt: entry.fetchedAt || 0,
          solved: entry.data && Array.isArray(entry.data.solved) ? entry.data.solved.length : 0,
          totalSubmissions: entry.data ? entry.data.totalSubmissions || 0 : 0,
        };
      }).sort(function (a, b) { return b.fetchedAt - a.fetchedAt; }),
      settingsPresent: !!settings,
      cooldown: cooldown || null,
      keys: Object.keys(data).filter(function (key) { return key.startsWith('cfs:'); }).length,
    };
  }

  return {
    get,
    set,
    remove,
    clear,
    getBytesInUse,
    readCache,
    writeCache,
    removeCache,
    isFresh,
    statusKey,
    rememberStatusHandle,
    clearStatusCache,
    clearAllCaches,
    getCacheInfo,
  };
});
