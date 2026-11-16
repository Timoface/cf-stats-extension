/**
 * User settings: validation, defaults, persistence.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./constants.js'), require('./storage.js'));
  } else {
    root.CFS_SETTINGS = factory(root.CFS_CONST, root.CFS_STORAGE);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CONST, STORAGE) {
  'use strict';

  const DEFAULTS = Object.freeze({
    minRequestDelayMs: 2100,
    maxRetries: 4,
    archiveTtlHours: 24,
    statusTtlMinutes: 15,
    htmlScraping: true,
    maxScrapePages: 180,
    scrapeDelayMs: 300,
    atcoderEnabled: true,
    fuzzyMatching: true,
    topTags: 12,
    recentLimit: 5,
  });

  function clampNumber(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  }

  function toBoolean(value, fallback) {
    if (value === true || value === false) return value;
    if (value === 'true' || value === 1 || value === '1') return true;
    if (value === 'false' || value === 0 || value === '0') return false;
    return fallback;
  }

  function normalizeSettings(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    return {
      minRequestDelayMs: clampNumber(
        input.minRequestDelayMs,
        DEFAULTS.minRequestDelayMs,
        1000,
        5000
      ),
      maxRetries: clampNumber(input.maxRetries, DEFAULTS.maxRetries, 1, 8),
      archiveTtlHours: clampNumber(
        input.archiveTtlHours,
        DEFAULTS.archiveTtlHours,
        1,
        168
      ),
      statusTtlMinutes: clampNumber(
        input.statusTtlMinutes,
        DEFAULTS.statusTtlMinutes,
        5,
        240
      ),
      htmlScraping: toBoolean(input.htmlScraping, DEFAULTS.htmlScraping),
      maxScrapePages: clampNumber(
        input.maxScrapePages,
        DEFAULTS.maxScrapePages,
        1,
        180
      ),
      scrapeDelayMs: clampNumber(
        input.scrapeDelayMs,
        DEFAULTS.scrapeDelayMs,
        100,
        2000
      ),
      atcoderEnabled: toBoolean(input.atcoderEnabled, DEFAULTS.atcoderEnabled),
      fuzzyMatching: toBoolean(input.fuzzyMatching, DEFAULTS.fuzzyMatching),
      topTags: clampNumber(input.topTags, DEFAULTS.topTags, 5, 20),
      recentLimit: clampNumber(input.recentLimit, DEFAULTS.recentLimit, 3, 10),
    };
  }

  async function load() {
    const result = await STORAGE.get(CONST.CACHE.SETTINGS);
    const raw = result && result[CONST.CACHE.SETTINGS];
    return normalizeSettings(raw);
  }

  async function save(settings) {
    const normalized = normalizeSettings(settings);
    await STORAGE.set({
      [CONST.CACHE.SETTINGS]: Object.assign({ v: 1 }, normalized),
    });
    return normalized;
  }

  async function ensureDefaults() {
    const result = await STORAGE.get(CONST.CACHE.SETTINGS);
    if (!result || !result[CONST.CACHE.SETTINGS]) {
      await save(DEFAULTS);
      return Object.assign({}, DEFAULTS);
    }
    return normalizeSettings(result[CONST.CACHE.SETTINGS]);
  }

  function archiveTtlMs(settings) {
    return (settings.archiveTtlHours || DEFAULTS.archiveTtlHours) * 60 * 60 * 1000;
  }

  function statusTtlMs(settings) {
    return (settings.statusTtlMinutes || DEFAULTS.statusTtlMinutes) * 60 * 1000;
  }

  return {
    DEFAULTS,
    normalizeSettings,
    load,
    save,
    ensureDefaults,
    archiveTtlMs,
    statusTtlMs,
  };
});
