/**
 * CF Stats+ — shared constants.
 *
 * This file is loaded as a classic script in three environments:
 *  - Chrome MV3 service worker (via importScripts)
 *  - Firefox MV3 background page (listed in manifest.background.scripts)
 *  - content script / options page
 *
 * The UMD wrapper also makes it requireable from Node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CFS_CONST = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '1.0.0';

  const MSG = Object.freeze({
    GET_STATS: 'CFS_GET_STATS',
    PROGRESS: 'CFS_PROGRESS',
    GET_CACHE_INFO: 'CFS_GET_CACHE_INFO',
    CLEAR_CACHE: 'CFS_CLEAR_CACHE',
    OPEN_OPTIONS: 'CFS_OPEN_OPTIONS',
    PING: 'CFS_PING',
  });

  const CF_API = 'https://codeforces.com/api';
  const ATCODER_PROBLEMS_URL = 'https://kenkoooo.com/atcoder/resources/problems.json';
  const ATCODER_MODELS_URL = 'https://kenkoooo.com/atcoder/resources/problem-models.json';

  // Bump a key suffix when the stored shape changes.
  const CACHE = Object.freeze({
    CF_ARCHIVE: 'cfs:archive:cf:v2',
    ATCODER_ARCHIVE: 'cfs:archive:atcoder:v1',
    STATUS_PREFIX: 'cfs:status:v1:',
    STATUS_INDEX: 'cfs:status:index:v1',
    SETTINGS: 'cfs:settings:v1',
    COOLDOWN: 'cfs:cooldown:v1',
  });

  const MAX_STATUS_PAGES = 10;
  const STATUS_PAGE_SIZE = 10000;
  const MAX_CACHED_HANDLES = 8;

  // Codeforces rating buckets used by the histogram. The last bucket is 3000+.
  const CF_RATING_BUCKETS = (function () {
    const buckets = [];
    for (let rating = 800; rating <= 2900; rating += 100) {
      buckets.push({ label: String(rating), min: rating, max: rating + 99 });
    }
    buckets.push({ label: '3000+', min: 3000, max: Infinity });
    return buckets;
  })();

  // AtCoder difficulty buckets. AtCoder's difficulty scale is not the same as
  // Codeforces rating, therefore it is rendered as a separate chart.
  const ATCODER_BUCKETS = (function () {
    const buckets = [];
    for (let difficulty = 0; difficulty <= 2800; difficulty += 400) {
      buckets.push({
        label: difficulty + '–' + (difficulty + 399),
        min: difficulty,
        max: difficulty + 399,
      });
    }
    buckets.push({ label: '3200+', min: 3200, max: Infinity });
    return buckets;
  })();

  const TAG_COLORS = Object.freeze([
    '#2563eb', '#0d9488', '#7c3aed', '#d97706', '#dc2626', '#0891b2',
    '#65a30d', '#c026d3', '#ea580c', '#4f46e5', '#059669', '#64748b',
    '#94a3b8',
  ]);

  const CF_RATING_COLORS = Object.freeze({
    newbie: '#8a94a6',
    pupil: '#16a34a',
    specialist: '#0d9488',
    expert: '#2563eb',
    candidateMaster: '#7c3aed',
    master: '#d97706',
    internationalMaster: '#ea580c',
    grandmaster: '#dc2626',
    legendary: '#991b1b',
  });

  return Object.freeze({
    VERSION,
    MSG,
    CF_API,
    ATCODER_PROBLEMS_URL,
    ATCODER_MODELS_URL,
    CACHE,
    MAX_STATUS_PAGES,
    STATUS_PAGE_SIZE,
    MAX_CACHED_HANDLES,
    CF_RATING_BUCKETS,
    ATCODER_BUCKETS,
    TAG_COLORS,
    CF_RATING_COLORS,
  });
});
