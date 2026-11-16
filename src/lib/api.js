/**
 * Codeforces / AtCoder API client with:
 *  - a single serialized request queue,
 *  - 1–2 s+ delay between requests (configurable),
 *  - exponential backoff with jitter on 403/429/5xx/Cloudflare,
 *  - persistent per-host cooldown,
 *  - local caches with TTL and stale-on-error fallback.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./constants.js'),
      require('./normalize.js'),
      require('./storage.js'),
      require('./settings.js')
    );
  } else {
    root.CFS_API = factory(root.CFS_CONST, root.CFS_NORMALIZE, root.CFS_STORAGE, root.CFS_SETTINGS);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CONST, NORMALIZE, STORAGE, SETTINGS) {
  'use strict';

  const MAX_COOLDOWN_WAIT_MS = 45000;
  const REQUEST_TIMEOUT_MS = 45000;
  const MAX_RETRY_AFTER_MS = 10 * 60 * 1000;

  let queueTail = Promise.resolve();
  let nextSlotAt = 0;
  let cooldowns = null;

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function randomBetween(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  function cfsError(code, message, extra) {
    const error = new Error(message);
    error.name = 'CfsError';
    error.code = code;
    error.retryable = false;
    if (extra && typeof extra === 'object') Object.assign(error, extra);
    return error;
  }

  function enqueue(task) {
    const run = queueTail.then(function () { return task(); });
    queueTail = run.then(function () { return undefined; }, function () { return undefined; });
    return run;
  }

  async function loadCooldowns() {
    if (cooldowns) return cooldowns;
    const result = await STORAGE.get(CONST.CACHE.COOLDOWN);
    const stored = result && result[CONST.CACHE.COOLDOWN];
    cooldowns = {
      codeforces: stored && stored.codeforces && Number(stored.codeforces.until) > Date.now()
        ? stored.codeforces.until
        : 0,
      atcoder: stored && stored.atcoder && Number(stored.atcoder.until) > Date.now()
        ? stored.atcoder.until
        : 0,
    };
    return cooldowns;
  }

  async function setCooldown(host, until, reason) {
    const state = await loadCooldowns();
    state[host] = Math.max(state[host] || 0, until);
    try {
      await STORAGE.set({
        [CONST.CACHE.COOLDOWN]: {
          v: 1,
          codeforces: { until: state.codeforces, reason: host === 'codeforces' ? reason : '' },
          atcoder: { until: state.atcoder, reason: host === 'atcoder' ? reason : '' },
          updatedAt: Date.now(),
        },
      });
    } catch (error) {
      // A failed cooldown write must not mask the original API error.
      console.warn('[CF Stats+] Could not persist cooldown', error);
    }
  }

  async function waitForCooldown(host) {
    const state = await loadCooldowns();
    const until = state[host] || 0;
    const remaining = until - Date.now();
    if (remaining <= 0) return;
    if (remaining > MAX_COOLDOWN_WAIT_MS) {
      throw cfsError(
        'RATE_LIMITED',
        'Codeforces/AtCoder temporarily rate-limited requests.',
        { retryAfterMs: remaining, host, retryable: false }
      );
    }
    await sleep(remaining);
  }

  async function waitForSlot(settings, host) {
    await waitForCooldown(host);
    const now = Date.now();
    if (nextSlotAt > now) {
      await sleep(nextSlotAt - now);
    }
    const delay = Math.max(1000, Number(settings.minRequestDelayMs) || 2100);
    nextSlotAt = Date.now() + delay + randomBetween(0, 250);
  }

  function parseRetryAfter(response) {
    const header = response && response.headers ? response.headers.get('retry-after') : null;
    if (!header) return 0;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1000));
    }
    const date = Date.parse(header);
    if (Number.isFinite(date)) {
      return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now()));
    }
    return 0;
  }

  function looksLikeCloudflare(text, status) {
    if (status !== 403 && status !== 429 && status !== 503) return false;
    if (!text) return false;
    if (text.length > 250000) return false;
    return /just a moment|cf-chl|cloudflare|attention required|checking your browser/i.test(text);
  }

  function backoffDelay(attempt, retryAfterMs, code) {
    const base = Math.min(60000, 3000 * Math.pow(2, attempt));
    const jitter = randomBetween(0, 600);
    const minimum = code === 'RATE_LIMITED' ? 5000 : 0;
    return Math.max(base + jitter, retryAfterMs || 0, minimum);
  }

  function classifyCfFailure(comment) {
    const text = String(comment || '').toLowerCase();
    if (text.includes('limit') || text.includes('too many') || text.includes('call') ||
        text.includes('wait') || text.includes('rate')) {
      return cfsError('RATE_LIMITED', 'Codeforces API call limit exceeded.', {
        retryable: true,
        retryAfterMs: 5000,
      });
    }
    if (text.includes('not found') || text.includes("couldn't find") || text.includes('no such user')) {
      return cfsError('HANDLE_NOT_FOUND', 'Codeforces user was not found.', { retryable: false });
    }
    if (text.includes('invalid')) {
      return cfsError('INVALID_HANDLE', 'Invalid Codeforces handle.', { retryable: false });
    }
    return cfsError('API_ERROR', 'Codeforces API error: ' + (comment || 'unknown'), { retryable: false });
  }

  function normalizeNetworkError(error, host) {
    if (error && error.code) return error;
    if (error && error.name === 'AbortError') {
      return cfsError('TIMEOUT', 'Request timed out.', { retryable: true, host });
    }
    return cfsError(
      'NETWORK',
      'Network error while contacting ' + (host === 'atcoder' ? 'AtCoder' : 'Codeforces') + '.',
      { retryable: true, host, cause: error }
    );
  }

  /**
   * One logical JSON request. The whole retry loop occupies the queue, so two
   * API calls can never run concurrently.
   */
  function requestJson(url, options, settings) {
    const opts = options || {};
    const host = opts.host === 'atcoder' ? 'atcoder' : 'codeforces';
    const maxRetries = Math.max(0, Math.min(8, Number(settings.maxRetries) || 0));

    return enqueue(async function () {
      let attempt = 0;
      let lastError = null;

      while (attempt <= maxRetries) {
        await waitForSlot(settings, host);
        const controller = new AbortController();
        const timer = setTimeout(function () { controller.abort(); }, opts.timeoutMs || REQUEST_TIMEOUT_MS);

        try {
          const response = await fetch(url, {
            method: 'GET',
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'follow',
            headers: {
              Accept: 'application/json, text/plain, */*',
            },
            signal: controller.signal,
          });
          const text = await response.text();
          clearTimeout(timer);

          const status = response.status;
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (parseError) {
            json = null;
          }

          if (json && json.status === 'FAILED') {
            throw classifyCfFailure(json.comment || json.message);
          }

          if (!response.ok) {
            const retryAfterMs = parseRetryAfter(response);
            if (status === 429) {
              throw cfsError('RATE_LIMITED', 'HTTP 429 from ' + host + '.', {
                retryable: true,
                retryAfterMs,
                httpStatus: status,
              });
            }
            if (status === 403 || status === 503) {
              // Codeforces sits behind Cloudflare and may return a bare 403
              // without the usual challenge markup. Treat every 403 as a
              // retryable block and back off; 503 may be a plain outage.
              const cloudflare = looksLikeCloudflare(text, status) || status === 403;
              if (cloudflare) {
                throw cfsError('CLOUDFLARE', 'Cloudflare challenge or block.', {
                  retryable: true,
                  retryAfterMs: retryAfterMs || 30000,
                  httpStatus: status,
                });
              }
              throw cfsError('HTTP_' + status, 'HTTP ' + status + ' from ' + host + '.', {
                retryable: status === 503,
                retryAfterMs,
                httpStatus: status,
              });
            }
            if (status >= 500) {
              throw cfsError('SERVER_ERROR', 'HTTP ' + status + ' from ' + host + '.', {
                retryable: true,
                retryAfterMs,
                httpStatus: status,
              });
            }
            throw cfsError('HTTP_' + status, 'HTTP ' + status + ' from ' + host + '.', {
              retryable: false,
              httpStatus: status,
            });
          }

          if (!json) {
            if (looksLikeCloudflare(text, status)) {
              throw cfsError('CLOUDFLARE', 'Cloudflare challenge page received.', {
                retryable: true,
                retryAfterMs: 30000,
              });
            }
            throw cfsError('PARSE_ERROR', 'Invalid JSON response from ' + host + '.', {
              retryable: true,
              httpStatus: status,
            });
          }

          return json;
        } catch (rawError) {
          clearTimeout(timer);
          lastError = normalizeNetworkError(rawError, host);
          if (!lastError.retryable) {
            throw lastError;
          }
          if (attempt >= maxRetries) {
            // Even when retries are exhausted, remember a cooldown so a new
            // tab or a service-worker restart does not immediately hammer API.
            const finalWait = backoffDelay(attempt, lastError.retryAfterMs, lastError.code);
            await setCooldown(host, Date.now() + finalWait, lastError.code);
            lastError.retryAfterMs = finalWait;
            throw lastError;
          }

          const wait = backoffDelay(attempt, lastError.retryAfterMs, lastError.code);
          await setCooldown(host, Date.now() + wait, lastError.code);
          if (wait > MAX_COOLDOWN_WAIT_MS) {
            lastError.retryAfterMs = wait;
            throw lastError;
          }
          attempt += 1;
        }
      }

      throw lastError || cfsError('UNKNOWN', 'Unknown API error.');
    });
  }

  function compactCfProblems(problems) {
    const seen = new Set();
    const compact = [];
    for (const problem of problems) {
      const rawContestId = problem && problem.contestId;
      const contestId = rawContestId == null || rawContestId === ''
        ? NaN
        : Number(rawContestId);
      const index = String(problem && problem.index != null ? problem.index : '').trim();
      const name = String(problem && problem.name != null ? problem.name : '').trim();
      if (!Number.isFinite(contestId) || !index || !name) continue;
      const key = contestId + ':' + index;
      if (seen.has(key)) continue;
      seen.add(key);
      const rawRating = problem && problem.rating;
      const numericRating = rawRating == null || rawRating === '' ? null : Number(rawRating);
      compact.push({
        contestId,
        index,
        name,
        rating: numericRating != null && Number.isFinite(numericRating) && numericRating > 0
          ? numericRating
          : null,
        tags: Array.isArray(problem.tags)
          ? problem.tags.filter(function (tag) { return typeof tag === 'string' && tag.trim(); })
          : [],
      });
    }
    return compact;
  }

  /**
   * Stores only localized names that differ from the English archive. This
   * lets one entry be found by either Russian or English title without
   * duplicating rating/tags.
   */
  function compactCfAliases(problems, englishProblems) {
    const englishByName = new Map();
    for (const problem of Array.isArray(englishProblems) ? englishProblems : []) {
      englishByName.set(problem.contestId + ':' + problem.index, problem.name);
    }
    const seen = new Set();
    const aliases = [];
    for (const problem of Array.isArray(problems) ? problems : []) {
      const contestId = Number(problem && problem.contestId);
      const index = String(problem && problem.index != null ? problem.index : '').trim();
      const name = String(problem && problem.name != null ? problem.name : '').trim();
      if (!Number.isFinite(contestId) || !index || !name) continue;
      const key = contestId + ':' + index;
      if (seen.has(key)) continue;
      seen.add(key);
      if (englishByName.get(key) === name) continue;
      aliases.push({ contestId, index, name });
    }
    return aliases;
  }

  function compactAtCoderProblems(problems, models) {    const modelMap = models && typeof models === 'object' ? models : {};
    const seen = new Set();
    const compact = [];
    for (const problem of Array.isArray(problems) ? problems : []) {
      const id = String(problem && problem.id != null ? problem.id : '').trim();
      const contestId = String(problem && problem.contest_id != null ? problem.contest_id : '').trim();
      const index = String(problem && problem.problem_index != null ? problem.problem_index : '').trim();
      const name = String(problem && problem.name != null ? problem.name : '').trim();
      if (!id || !contestId || !name || seen.has(id)) continue;
      seen.add(id);
      const model = modelMap[id];
      const rawDifficulty = model ? model.difficulty : null;
      const difficulty = rawDifficulty == null || rawDifficulty === '' ||
        !Number.isFinite(Number(rawDifficulty))
        ? null
        : Math.max(0, Math.round(Number(rawDifficulty)));
      compact.push({ id, contestId, index, name, difficulty });
    }
    return compact;
  }

  async function fetchCfArchive(options) {
    const opts = options || {};
    const settings = opts.settings || {};
    const cached = await STORAGE.readCache(CONST.CACHE.CF_ARCHIVE);
    const ttl = SETTINGS.archiveTtlMs(settings);

    if (!opts.force && cached && STORAGE.isFresh(cached, ttl)) {
      return {
        data: cached.data,
        fetchedAt: cached.fetchedAt,
        fromCache: true,
        stale: false,
      };
    }

    try {
      if (opts.onProgress) {
        opts.onProgress({ stage: 'archive', message: 'Загружаю архив задач Codeforces…' });
      }
      const json = await requestJson(CONST.CF_API + '/problemset.problems?locale=en', {
        host: 'codeforces',
        label: 'problemset.problems (en)',
      }, settings);

      if (!json || json.status !== 'OK' || !json.result || !Array.isArray(json.result.problems)) {
        throw cfsError('ARCHIVE_INVALID', 'Unexpected problemset.problems response.', {
          retryable: false,
        });
      }
      const problems = compactCfProblems(json.result.problems);
      if (problems.length < 500) {
        throw cfsError('ARCHIVE_INVALID', 'Problemset archive is suspiciously small.', {
          retryable: false,
        });
      }

      // Codeforces localizes problem names by Accept-Language, while
      // user.status has no locale parameter. We therefore index both the
      // English and Russian archive titles for the same contestId/index.
      let localized = [];
      let localizedFailed = false;
      try {
        if (opts.onProgress) {
          opts.onProgress({
            stage: 'archive',
            message: 'Загружаю русские названия задач Codeforces…',
          });
        }
        const localizedJson = await requestJson(
          CONST.CF_API + '/problemset.problems?locale=ru',
          { host: 'codeforces', label: 'problemset.problems (ru)' },
          Object.assign({}, settings, {
            maxRetries: Math.min(Number(settings.maxRetries) || 0, 1),
          })
        );
        if (
          localizedJson &&
          localizedJson.status === 'OK' &&
          localizedJson.result &&
          Array.isArray(localizedJson.result.problems)
        ) {
          localized = compactCfAliases(localizedJson.result.problems, problems);
        } else {
          localizedFailed = true;
          if (cached && cached.data && Array.isArray(cached.data.localized)) {
            localized = cached.data.localized;
          }
        }
      } catch (localizedError) {
        localizedFailed = true;
        console.warn('[CF Stats+] Russian archive titles unavailable', localizedError);
        if (cached && cached.data && Array.isArray(cached.data.localized)) {
          localized = cached.data.localized;
        }
      }

      let entry;
      try {
        entry = await STORAGE.writeCache(CONST.CACHE.CF_ARCHIVE, { problems, localized });
        // Remove the pre-localization cache format once a v2 archive is stored.
        await STORAGE.removeCache('cfs:archive:cf:v1');
      } catch (writeError) {
        console.warn('[CF Stats+] Could not cache CF archive', writeError);
      }

      return {
        data: { problems, localized },
        fetchedAt: entry ? entry.fetchedAt : Date.now(),
        fromCache: false,
        stale: false,
        localizedFailed,
        cacheWriteFailed: !entry,
      };
    } catch (error) {
      if (cached && cached.data) {
        return {
          data: cached.data,
          fetchedAt: cached.fetchedAt,
          fromCache: true,
          stale: true,
          staleReason: error.code || 'ERROR',
        };
      }
      throw error;
    }
  }

  async function fetchAtCoderArchive(options) {
    const opts = options || {};
    const settings = opts.settings || {};
    if (settings.atcoderEnabled === false) {
      return {
        data: { problems: [] },
        fetchedAt: 0,
        fromCache: false,
        stale: false,
        disabled: true,
        enabled: false,
      };
    }

    const cached = await STORAGE.readCache(CONST.CACHE.ATCODER_ARCHIVE);
    const ttl = SETTINGS.archiveTtlMs(settings);
    if (!opts.force && cached && STORAGE.isFresh(cached, ttl)) {
      return {
        data: cached.data,
        fetchedAt: cached.fetchedAt,
        fromCache: true,
        stale: false,
        enabled: true,
      };
    }

    try {
      if (opts.onProgress) {
        opts.onProgress({
          stage: 'archive',
          message: 'Загружаю архив задач AtCoder (AtCoder Problems)…',
        });
      }
      const problemsJson = await requestJson(CONST.ATCODER_PROBLEMS_URL, {
        host: 'atcoder',
        label: 'AtCoder problems',
      }, settings);

      if (!Array.isArray(problemsJson) || problemsJson.length < 500) {
        throw cfsError('ATCODER_INVALID', 'Unexpected AtCoder problems response.', {
          retryable: false,
        });
      }

      let modelsJson = null;
      let modelsFailed = false;
      try {
        modelsJson = await requestJson(CONST.ATCODER_MODELS_URL, {
          host: 'atcoder',
          label: 'AtCoder difficulty models',
        }, settings);
        if (!modelsJson || typeof modelsJson !== 'object' || Array.isArray(modelsJson)) {
          modelsFailed = true;
          modelsJson = null;
        }
      } catch (modelError) {
        modelsFailed = true;
        console.warn('[CF Stats+] AtCoder difficulty models unavailable', modelError);
      }

      const problems = compactAtCoderProblems(problemsJson, modelsJson);
      if (problems.length < 500) {
        throw cfsError('ATCODER_INVALID', 'AtCoder archive is suspiciously small.', {
          retryable: false,
        });
      }

      let entry;
      try {
        entry = await STORAGE.writeCache(CONST.CACHE.ATCODER_ARCHIVE, { problems });
      } catch (writeError) {
        console.warn('[CF Stats+] Could not cache AtCoder archive', writeError);
      }

      return {
        data: { problems },
        fetchedAt: entry ? entry.fetchedAt : Date.now(),
        fromCache: false,
        stale: false,
        enabled: true,
        modelsFailed,
        cacheWriteFailed: !entry,
      };
    } catch (error) {
      if (cached && cached.data) {
        return {
          data: cached.data,
          fetchedAt: cached.fetchedAt,
          fromCache: true,
          stale: true,
          staleReason: error.code || 'ERROR',
          enabled: true,
        };
      }
      return {
        data: { problems: [] },
        fetchedAt: 0,
        fromCache: false,
        stale: false,
        enabled: true,
        error: error.code || 'ERROR',
        errorMessage: error.message,
      };
    }
  }

  function trimSubmissions(rawSubmissions) {
    const totalSubmissions = Array.isArray(rawSubmissions) ? rawSubmissions.length : 0;
    const firstAc = new Map();

    for (const submission of Array.isArray(rawSubmissions) ? rawSubmissions : []) {
      if (!submission || submission.verdict !== 'OK') continue;
      const problem = submission.problem;
      if (!problem || !problem.name) continue;
      const contestId = Number.isFinite(Number(problem.contestId))
        ? Number(problem.contestId)
        : null;
      const index = problem.index == null ? '' : String(problem.index);
      const key = contestId != null ? contestId + ':' + index : 'name:' + problem.name;
      const timestamp = Number(submission.creationTimeSeconds) || 0;
      const existing = firstAc.get(key);
      if (existing) {
        if (timestamp && (!existing.ts || timestamp < existing.ts)) existing.ts = timestamp;
        continue;
      }
      const rawRating = problem.rating;
      const numericRating = rawRating == null || rawRating === '' ? null : Number(rawRating);
      firstAc.set(key, {
        c: contestId,
        i: index,
        n: String(problem.name),
        r: numericRating != null && Number.isFinite(numericRating) && numericRating > 0
          ? numericRating
          : null,
        t: Array.isArray(problem.tags) ? problem.tags.slice() : [],
        ts: timestamp,
        pt: submission.author && submission.author.participantType
          ? submission.author.participantType
          : null,
      });
    }

    return {
      solved: Array.from(firstAc.values()),
      totalSubmissions,
    };
  }

  async function fetchUserStatus(handle, options) {
    const opts = options || {};
    const settings = opts.settings || {};
    const normalized = NORMALIZE.normalizeHandle(handle);
    if (!NORMALIZE.isValidHandle(normalized)) {
      throw cfsError('INVALID_HANDLE', 'Invalid Codeforces handle.', { retryable: false });
    }

    const cacheKey = STORAGE.statusKey(normalized);
    const cached = await STORAGE.readCache(cacheKey);
    const ttl = SETTINGS.statusTtlMs(settings);
    if (!opts.force && cached && STORAGE.isFresh(cached, ttl)) {
      return {
        data: cached.data,
        fetchedAt: cached.fetchedAt,
        fromCache: true,
        stale: false,
      };
    }

    try {
      const allSubmissions = [];
      let complete = false;
      let pages = 0;

      for (let page = 1; page <= CONST.MAX_STATUS_PAGES; page += 1) {
        const from = (page - 1) * CONST.STATUS_PAGE_SIZE + 1;
        const url = CONST.CF_API + '/user.status?handle=' + encodeURIComponent(normalized) +
          '&from=' + from + '&count=' + CONST.STATUS_PAGE_SIZE;
        if (opts.onProgress) {
          opts.onProgress({
            stage: 'status',
            message: page === 1
              ? 'Загружаю посылки @' + normalized + '…'
              : 'Загружаю посылки @' + normalized + ' (страница ' + page + ')…',
            page,
            submissions: allSubmissions.length,
          });
        }

        const json = await requestJson(url, {
          host: 'codeforces',
          label: 'user.status page ' + page,
        }, settings);

        if (!json || json.status !== 'OK' || !Array.isArray(json.result)) {
          throw cfsError('STATUS_INVALID', 'Unexpected user.status response.', { retryable: false });
        }

        pages = page;
        allSubmissions.push.apply(allSubmissions, json.result);
        if (opts.onProgress) {
          opts.onProgress({
            stage: 'status',
            message: 'Загружено посылок: ' + allSubmissions.length.toLocaleString('ru-RU'),
            page,
            submissions: allSubmissions.length,
          });
        }

        if (json.result.length < CONST.STATUS_PAGE_SIZE) {
          complete = true;
          break;
        }
      }

      const trimmed = trimSubmissions(allSubmissions);
      const data = {
        handle: normalized,
        solved: trimmed.solved,
        totalSubmissions: trimmed.totalSubmissions,
        pages,
        truncated: !complete,
      };

      let entry;
      try {
        entry = await STORAGE.writeCache(cacheKey, data);
        await STORAGE.rememberStatusHandle(normalized);
      } catch (writeError) {
        console.warn('[CF Stats+] Could not cache user status', writeError);
      }

      return {
        data,
        fetchedAt: entry ? entry.fetchedAt : Date.now(),
        fromCache: false,
        stale: false,
        cacheWriteFailed: !entry,
      };
    } catch (error) {
      if (cached && cached.data) {
        return {
          data: cached.data,
          fetchedAt: cached.fetchedAt,
          fromCache: true,
          stale: true,
          staleReason: error.code || 'ERROR',
          error: error.code || 'ERROR',
        };
      }
      throw error;
    }
  }

  function resetQueueForTests() {
    queueTail = Promise.resolve();
    nextSlotAt = 0;
    cooldowns = null;
  }

  /** Clears in-memory cooldowns after the user explicitly clears the cache. */
  function resetCooldowns() {
    cooldowns = null;
    nextSlotAt = 0;
  }

  return {
    requestJson,
    fetchCfArchive,
    fetchAtCoderArchive,
    fetchUserStatus,
    trimSubmissions,
    compactCfProblems,
    compactCfAliases,
    compactAtCoderProblems,
    resetCooldowns,
    __resetQueueForTests: resetQueueForTests,
  };
});
