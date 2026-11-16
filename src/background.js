/**
 * CF Stats+ background service worker / event page.
 *
 * Loads the classic-script libraries (Chrome via importScripts, Firefox via
 * manifest.background.scripts), then serves stats requests from the content
 * script. All network access and computation happens here.
 */
(function () {
  'use strict';

  if (typeof importScripts === 'function' && typeof CFS_API === 'undefined') {
    importScripts(
      'lib/constants.js',
      'lib/normalize.js',
      'lib/matcher.js',
      'lib/stats.js',
      'lib/storage.js',
      'lib/settings.js',
      'lib/api.js'
    );
  }

  if (
    typeof CFS_CONST === 'undefined' ||
    typeof CFS_NORMALIZE === 'undefined' ||
    typeof CFS_MATCHER === 'undefined' ||
    typeof CFS_STATS === 'undefined' ||
    typeof CFS_STORAGE === 'undefined' ||
    typeof CFS_SETTINGS === 'undefined' ||
    typeof CFS_API === 'undefined'
  ) {
    console.error('[CF Stats+] Background libraries failed to load.');
    return;
  }

  const inflight = new Map();
  let catalogCache = null;

  function sendProgress(tabId, payload) {
    if (!tabId || !chrome.tabs || !chrome.tabs.sendMessage) return;
    try {
      chrome.tabs.sendMessage(tabId, Object.assign({ type: CFS_CONST.MSG.PROGRESS }, payload), function () {
        // Reading lastError suppresses "Receiving end does not exist".
        if (chrome.runtime && chrome.runtime.lastError) return;
      });
    } catch (error) {
      // Tab closed or navigated away.
    }
  }

  function makeProgress(tabId, handle) {
    return function (payload) {
      sendProgress(tabId, Object.assign({ handle }, payload || {}));
    };
  }

  function warningCollector() {
    const warnings = [];
    return {
      add: function (message) {
        if (message && !warnings.includes(message)) warnings.push(message);
      },
      list: warnings,
    };
  }

  function errorText(code) {
    const map = {
      RATE_LIMITED: 'Codeforces ограничил частоту запросов.',
      CLOUDFLARE: 'Codeforces временно блокирует запросы (Cloudflare).',
      NETWORK: 'Нет соединения с API.',
      TIMEOUT: 'API не ответил вовремя.',
      HANDLE_NOT_FOUND: 'Пользователь не найден на Codeforces.',
      INVALID_HANDLE: 'Некорректный handle.',
      API_ERROR: 'Codeforces API вернул ошибку.',
      PARSE_ERROR: 'API вернул некорректный ответ.',
      SERVER_ERROR: 'Сервер API временно недоступен.',
    };
    return map[code] || 'Неизвестная ошибка API.';
  }

  function getCatalog(cfData, atcoderData, cfFetchedAt, atcoderFetchedAt) {
    const cfProblems = cfData && Array.isArray(cfData.problems) ? cfData.problems : [];
    const cfLocalized = cfData && Array.isArray(cfData.localized) ? cfData.localized : [];
    const atcoderProblems = atcoderData && Array.isArray(atcoderData.problems)
      ? atcoderData.problems
      : [];
    const key = [
      cfProblems.length,
      cfLocalized.length,
      cfFetchedAt || 0,
      atcoderProblems.length,
      atcoderFetchedAt || 0,
    ].join('|');

    if (catalogCache && catalogCache.key === key) return catalogCache.value;
    const catalog = CFS_MATCHER.buildCatalog(cfProblems, atcoderProblems, cfLocalized);
    catalogCache = { key, value: catalog };
    return catalog;
  }

  function normalizeScrapedProblems(items) {
    const result = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item !== 'object') continue;
      const name = String(item.name == null ? '' : item.name).trim();
      if (!name) continue;
      const group = item.group === true || item.g === 1 || item.g === true;
      const contestId = !group && Number.isFinite(Number(item.contestId)) && Number(item.contestId) > 0
        ? Number(item.contestId)
        : null;
      const index = String(item.index == null ? '' : item.index).trim();
      const url = String(item.url == null ? '' : item.url).trim();
      const key = group
        ? 'group:' + (url || CFS_NORMALIZE.normalizeTitle(name))
        : (contestId != null && index
          ? 'id:' + contestId + ':' + index
          : 'name:' + CFS_NORMALIZE.normalizeTitle(name));
      if (!result.has(key)) {
        result.set(key, {
          c: contestId,
          i: index,
          n: name,
          g: group ? 1 : 0,
          u: url || null,
          r: null,
          t: [],
          ts: 0,
        });
      }
    }
    return Array.from(result.values());
  }

  async function doGetStats(message, sender) {
    const startedAt = Date.now();
    const rawHandle = message && message.handle;
    const handle = CFS_NORMALIZE.normalizeHandle(rawHandle);
    if (!CFS_NORMALIZE.isValidHandle(handle)) {
      const error = new Error('Invalid handle');
      error.code = 'INVALID_HANDLE';
      throw error;
    }

    const settings = await CFS_SETTINGS.load();
    const force = !!(message && message.force);
    const tabId = sender && sender.tab ? sender.tab.id : null;
    const progress = makeProgress(tabId, handle);
    const warnings = warningCollector();
    const scrapeMeta = message && message.scrapeMeta && typeof message.scrapeMeta === 'object'
      ? message.scrapeMeta
      : null;
    const hasScraped = Array.isArray(message && message.scraped);
    let status;

    progress({ stage: 'start', message: 'Начинаю сбор статистики…' });

    if (hasScraped) {
      const solved = normalizeScrapedProblems(message.scraped);
      status = {
        data: {
          solved,
          totalSubmissions: Number(scrapeMeta && scrapeMeta.totalRows) || solved.length,
          pages: Number(scrapeMeta && scrapeMeta.pages) || 0,
          truncated: !!(scrapeMeta && scrapeMeta.truncated),
        },
        fetchedAt: Number(scrapeMeta && scrapeMeta.fetchedAt) || Date.now(),
        fromCache: !!(scrapeMeta && scrapeMeta.fromCache),
        stale: false,
        source: 'html',
      };
      if (scrapeMeta) {
        if (scrapeMeta.stale) {
          warnings.add('HTML-страницы посылок сейчас недоступны — показан сохранённый ' +
            'HTML-кэш. Он может быть неполным.');
        }
        if (scrapeMeta.fromCache) {
          // The HTML cache is already visible in the panel; no warning needed.
        }
        if (scrapeMeta.partial) {
          warnings.add('HTML-сбор посылок остановился на странице ' +
            (scrapeMeta.pages || '?') +
            (scrapeMeta.stopReason ? ' (' + scrapeMeta.stopReason + ')' : '') +
            ' — данные могут быть неполными.');
        } else if (scrapeMeta.stopReason && scrapeMeta.stopReason !== 'end' &&
                   scrapeMeta.stopReason !== 'limit' && scrapeMeta.stopReason !== 'stale-cache') {
          warnings.add('HTML-сбор посылок остановился: ' + scrapeMeta.stopReason +
            '. Показаны уже собранные данные.');
        }
        if (scrapeMeta.truncated) {
          warnings.add('Достигнут лимит страниц HTML-сбора. Увеличьте лимит в настройках, ' +
            'если у вас очень длинная история посылок.');
        }
      }
    } else {
      progress({ stage: 'status', message: 'Загружаю посылки @' + handle + '…' });
      status = await CFS_API.fetchUserStatus(handle, {
        force,
        settings,
        onProgress: progress,
      });
      status.source = 'api';
      if (settings.htmlScraping) {
        warnings.add('HTML-страницы посылок недоступны — использован публичный API. ' +
          'Задачи из закрытых групп могут быть не видны.');
      }
    }

    // 2. Official Codeforces archive.
    let cfArchive = null;
    let cfArchiveError = null;
    try {
      cfArchive = await CFS_API.fetchCfArchive({
        force,
        settings,
        onProgress: progress,
      });
    } catch (error) {
      cfArchiveError = error;
      console.warn('[CF Stats+] CF archive unavailable', error);
    }

    // 3. AtCoder archive (optional, non-fatal).
    let atcoderArchive = null;
    if (settings.atcoderEnabled) {
      progress({ stage: 'archive', message: 'Проверяю архив AtCoder…' });
      atcoderArchive = await CFS_API.fetchAtCoderArchive({
        force,
        settings,
        onProgress: progress,
      });
    } else {
      atcoderArchive = {
        data: { problems: [] },
        fetchedAt: 0,
        fromCache: false,
        stale: false,
        disabled: true,
        enabled: false,
      };
    }

    if (status.stale) {
      warnings.add('Codeforces API сейчас недоступен — показаны сохранённые посылки из кэша.');
    }
    if (status.cacheWriteFailed) {
      warnings.add('Не удалось обновить локальный кэш посылок (хранилище недоступно).');
    }
    if (status.data && status.data.truncated && status.source === 'api') {
      warnings.add('История посылок очень большая: обработаны первые ' +
        (CFS_CONST.MAX_STATUS_PAGES * CFS_CONST.STATUS_PAGE_SIZE).toLocaleString('ru-RU') + '.');
    }

    if (cfArchive) {
      if (cfArchive.stale) {
        warnings.add('Архив Codeforces не обновился — использую сохранённую копию. ' +
          errorText(cfArchive.staleReason));
      }
      if (cfArchive.localizedFailed) {
        warnings.add('Русские названия задач Codeforces не загрузились — задачи с русскими ' +
          'названиями могут не сопоставиться.');
      }
      if (cfArchive.cacheWriteFailed) {
        warnings.add('Не удалось сохранить архив Codeforces в кэш.');
      }
    } else {
      warnings.add('Архив Codeforces недоступен — задачи не удалось сверить с CF. ' +
        (cfArchiveError ? errorText(cfArchiveError.code) : ''));
    }

    if (atcoderArchive) {
      if (atcoderArchive.disabled) {
        // No warning: the user explicitly disabled AtCoder.
      } else if (atcoderArchive.error) {
        warnings.add('Архив AtCoder недоступен — сверка с AtCoder пропущена. ' +
          errorText(atcoderArchive.error));
      } else if (atcoderArchive.stale) {
        warnings.add('Архив AtCoder не обновился — использую сохранённую копию.');
      } else if (atcoderArchive.modelsFailed) {
        warnings.add('Сложности AtCoder не загрузились: задачи AtCoder останутся без сложности.');
      }
    }

    const cfData = cfArchive && cfArchive.data ? cfArchive.data : { problems: [] };
    const atcoderData = atcoderArchive && atcoderArchive.data
      ? atcoderArchive.data
      : { problems: [] };
    if (!cfData.problems.length && !atcoderData.problems.length) {
      warnings.add('Не удалось загрузить ни один архив — задачи показаны как «другие».');
    }

    progress({ stage: 'matching', message: 'Сопоставляю задачи с архивами…' });

    const catalog = getCatalog(
      cfData,
      atcoderData,
      cfArchive ? cfArchive.fetchedAt : 0,
      atcoderArchive ? atcoderArchive.fetchedAt : 0
    );

    const stats = CFS_STATS.buildStats({
      handle,
      solved: status.data.solved || [],
      totalSubmissions: status.data.totalSubmissions || 0,
      fetchedAt: status.fetchedAt,
      catalog,
      settings,
      warnings: warnings.list,
      meta: {
        cfArchive: cfArchive ? {
          fetchedAt: cfArchive.fetchedAt,
          fromCache: cfArchive.fromCache,
          stale: cfArchive.stale,
        } : null,
        atcoderArchive: atcoderArchive ? {
          fetchedAt: atcoderArchive.fetchedAt,
          fromCache: atcoderArchive.fromCache,
          stale: atcoderArchive.stale,
          enabled: !atcoderArchive.disabled,
          error: atcoderArchive.error || null,
        } : null,
      },
    });

    stats.performance = {
      elapsedMs: Date.now() - startedAt,
      statusFromCache: !!status.fromCache,
      statusSource: status.source || 'api',
      scrapePages: status.source === 'html' ? (status.data.pages || 0) : 0,
      cfArchiveFromCache: !!(cfArchive && cfArchive.fromCache),
      atcoderArchiveFromCache: !!(atcoderArchive && atcoderArchive.fromCache),
      atcoderDisabled: !!(atcoderArchive && atcoderArchive.disabled),
      statusTruncated: !!(status.data && status.data.truncated),
      statusPages: status.data ? status.data.pages || 0 : 0,
    };
    stats.version = CFS_CONST.VERSION;
    stats.isStale = !!status.stale;
    stats.staleReason = status.staleReason || null;
    stats.forceRefreshed = force;

    return stats;
  }

  function getStats(message, sender) {
    const handle = CFS_NORMALIZE.normalizeHandle(message && message.handle).toLowerCase();
    const force = !!(message && message.force);
    const key = handle + (force ? '|force' : '|normal');
    if (inflight.has(key)) return inflight.get(key);

    const promise = doGetStats(message, sender).finally(function () {
      inflight.delete(key);
    });
    inflight.set(key, promise);
    return promise;
  }

  function serializeError(error) {
    return {
      code: error && error.code ? error.code : 'UNKNOWN',
      message: error && error.message ? error.message : 'Unknown error',
      retryAfterMs: error && Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0,
      httpStatus: error && error.httpStatus ? error.httpStatus : 0,
    };
  }

  async function handleMessage(message, sender) {
    if (!message || typeof message.type !== 'string') return undefined;

    switch (message.type) {
      case CFS_CONST.MSG.GET_STATS:
        try {
          const data = await getStats(message, sender);
          return { ok: true, data };
        } catch (error) {
          console.error('[CF Stats+] Stats request failed', error);
          return { ok: false, error: serializeError(error) };
        }

      case CFS_CONST.MSG.GET_SCRAPE_CONFIG: {
        const settings = await CFS_SETTINGS.load();
        return {
          ok: true,
          data: {
            htmlScraping: !!settings.htmlScraping,
            maxScrapePages: settings.maxScrapePages,
            scrapeDelayMs: settings.scrapeDelayMs,
            cacheTtlMs: settings.statusTtlMinutes * 60 * 1000,
            pageSize: CFS_CONST.SCRAPE_PAGE_SIZE,
          },
        };
      }

      case CFS_CONST.MSG.GET_SCRAPE_CACHE: {
        const handle = CFS_NORMALIZE.normalizeHandle(message.handle);
        if (!CFS_NORMALIZE.isValidHandle(handle)) {
          return { ok: false, error: { code: 'INVALID_HANDLE', message: 'Invalid handle' } };
        }
        const settings = await CFS_SETTINGS.load();
        const cached = await CFS_STORAGE.readCache(CFS_STORAGE.scrapeKey(handle));
        return {
          ok: true,
          data: {
            data: cached ? cached.data : null,
            fetchedAt: cached ? cached.fetchedAt : 0,
            fresh: cached ? CFS_STORAGE.isFresh(cached, settings.statusTtlMinutes * 60 * 1000) : false,
          },
        };
      }

      case CFS_CONST.MSG.SAVE_SCRAPE_CACHE: {
        const handle = CFS_NORMALIZE.normalizeHandle(message.handle);
        if (!CFS_NORMALIZE.isValidHandle(handle)) {
          return { ok: false, error: { code: 'INVALID_HANDLE', message: 'Invalid handle' } };
        }
        const data = message.data && typeof message.data === 'object' ? message.data : null;
        if (!data || !Array.isArray(data.solved)) {
          return { ok: false, error: { code: 'INVALID_SCRAPE_DATA', message: 'Invalid scrape data' } };
        }
        await CFS_STORAGE.writeCache(CFS_STORAGE.scrapeKey(handle), data);
        return { ok: true };
      }

      case CFS_CONST.MSG.GET_CACHE_INFO:
        return { ok: true, data: await CFS_STORAGE.getCacheInfo() };

      case CFS_CONST.MSG.CLEAR_CACHE: {
        if (message.handle) {
          await CFS_STORAGE.clearStatusCache(message.handle);
        } else {
          await CFS_STORAGE.clearAllCaches({ keepSettings: true });
          CFS_API.resetCooldowns();
          catalogCache = null;
        }
        return { ok: true, data: await CFS_STORAGE.getCacheInfo() };
      }

      case CFS_CONST.MSG.OPEN_OPTIONS:
        try {
          chrome.runtime.openOptionsPage();
        } catch (error) {
          console.warn('[CF Stats+] Could not open options', error);
        }
        return { ok: true };

      case CFS_CONST.MSG.PING:
        return { ok: true, data: { version: CFS_CONST.VERSION, now: Date.now() } };

      default:
        return undefined;
    }
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || typeof message.type !== 'string' || !message.type.startsWith('CFS_')) {
      return undefined;
    }
    handleMessage(message, sender).then(function (response) {
      sendResponse(response);
    }).catch(function (error) {
      console.error('[CF Stats+] Unhandled message error', error);
      sendResponse({ ok: false, error: serializeError(error) });
    });
    return true;
  });

  chrome.runtime.onInstalled.addListener(function () {
    CFS_SETTINGS.ensureDefaults().catch(function (error) {
      console.warn('[CF Stats+] Could not initialize settings', error);
    });
  });

  if (chrome.action && chrome.action.onClicked) {
    chrome.action.onClicked.addListener(function () {
      chrome.runtime.openOptionsPage();
    });
  }
})();
