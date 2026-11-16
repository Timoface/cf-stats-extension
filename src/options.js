/**
 * Options page logic. Uses the same storage/settings modules as the worker;
 * no background messaging is required.
 */
(function () {
  'use strict';

  if (typeof CFS_CONST === 'undefined' || typeof CFS_SETTINGS === 'undefined' || typeof CFS_STORAGE === 'undefined') {
    document.body.textContent = 'Не удалось загрузить модули расширения.';
    return;
  }

  const form = document.getElementById('settings-form');
  const saveStatus = document.getElementById('save-status');
  const toast = document.getElementById('toast');
  const delayWarning = document.getElementById('delay-warning');
  const fields = {
    minRequestDelayMs: document.getElementById('minRequestDelayMs'),
    maxRetries: document.getElementById('maxRetries'),
    archiveTtlHours: document.getElementById('archiveTtlHours'),
    statusTtlMinutes: document.getElementById('statusTtlMinutes'),
    htmlScraping: document.getElementById('htmlScraping'),
    maxScrapePages: document.getElementById('maxScrapePages'),
    scrapeDelayMs: document.getElementById('scrapeDelayMs'),
    atcoderEnabled: document.getElementById('atcoderEnabled'),
    fuzzyMatching: document.getElementById('fuzzyMatching'),
    topTags: document.getElementById('topTags'),
    recentLimit: document.getElementById('recentLimit'),
  };

  let toastTimer = null;

  function showToast(message, isError) {
    if (!toast) return;
    toast.textContent = message;
    toast.style.background = isError ? '#7f1d1d' : '#101828';
    toast.style.borderColor = isError ? '#991b1b' : '#1f2937';
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.hidden = true;
    }, 3200);
  }

  function formatBytes(bytes) {
    if (bytes == null || !Number.isFinite(bytes)) return '—';
    if (bytes < 1024) return bytes + ' Б';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1).replace('.', ',') + ' КБ';
    return (bytes / (1024 * 1024)).toFixed(2).replace('.', ',') + ' МБ';
  }

  function formatRelative(ms) {
    if (!ms) return 'нет данных';
    const diff = Date.now() - ms;
    if (diff < 45 * 1000) return 'только что';
    if (diff < 3600 * 1000) return Math.max(1, Math.floor(diff / 60000)) + ' мин назад';
    if (diff < 86400 * 1000) return Math.max(1, Math.floor(diff / 3600000)) + ' ч назад';
    return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(new Date(ms));
  }

  function formatDateTime(ms) {
    if (!ms) return '—';
    return new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ms));
  }

  function updateDelayWarning() {
    if (!delayWarning) return;
    const value = Number(fields.minRequestDelayMs.value);
    delayWarning.hidden = !(Number.isFinite(value) && value < 2000);
  }

  function fillForm(settings) {
    fields.minRequestDelayMs.value = settings.minRequestDelayMs;
    fields.maxRetries.value = settings.maxRetries;
    fields.archiveTtlHours.value = settings.archiveTtlHours;
    fields.statusTtlMinutes.value = settings.statusTtlMinutes;
    fields.htmlScraping.checked = !!settings.htmlScraping;
    fields.maxScrapePages.value = settings.maxScrapePages;
    fields.scrapeDelayMs.value = settings.scrapeDelayMs;
    fields.atcoderEnabled.checked = !!settings.atcoderEnabled;
    fields.fuzzyMatching.checked = !!settings.fuzzyMatching;
    fields.topTags.value = settings.topTags;
    fields.recentLimit.value = settings.recentLimit;
    updateDelayWarning();
    updateHtmlFields();
  }

  function updateHtmlFields() {
    const disabled = !fields.htmlScraping.checked;
    fields.maxScrapePages.disabled = disabled;
    fields.scrapeDelayMs.disabled = disabled;
  }

  function readForm() {
    return CFS_SETTINGS.normalizeSettings({
      minRequestDelayMs: fields.minRequestDelayMs.value,
      maxRetries: fields.maxRetries.value,
      archiveTtlHours: fields.archiveTtlHours.value,
      statusTtlMinutes: fields.statusTtlMinutes.value,
      htmlScraping: fields.htmlScraping.checked,
      maxScrapePages: fields.maxScrapePages.value,
      scrapeDelayMs: fields.scrapeDelayMs.value,
      atcoderEnabled: fields.atcoderEnabled.checked,
      fuzzyMatching: fields.fuzzyMatching.checked,
      topTags: fields.topTags.value,
      recentLimit: fields.recentLimit.value,
    });
  }

  function setStatus(text) {
    if (!saveStatus) return;
    saveStatus.textContent = text;
    if (text) {
      setTimeout(function () {
        if (saveStatus.textContent === text) saveStatus.textContent = '';
      }, 2600);
    }
  }

  async function saveSettings(event) {
    if (event) event.preventDefault();
    const normalized = readForm();
    try {
      await CFS_SETTINGS.save(normalized);
      fillForm(normalized);
      setStatus('Сохранено');
      showToast('Настройки сохранены');
    } catch (error) {
      console.error('[CF Stats+] Settings save failed', error);
      setStatus('Ошибка сохранения');
      showToast('Не удалось сохранить настройки: ' + (error.message || 'storage error'), true);
    }
  }

  async function resetSettings() {
    const normalized = CFS_SETTINGS.normalizeSettings(CFS_SETTINGS.DEFAULTS);
    fillForm(normalized);
    try {
      await CFS_SETTINGS.save(normalized);
      setStatus('Сброшено');
      showToast('Настройки сброшены по умолчанию');
    } catch (error) {
      showToast('Не удалось сбросить настройки', true);
    }
  }

  function renderCacheInfo(info) {
    const bytesEl = document.getElementById('cache-bytes');
    const cfEl = document.getElementById('cache-cf');
    const atcoderEl = document.getElementById('cache-atcoder');
    const profilesEl = document.getElementById('cache-profiles');
    const details = document.getElementById('cache-details');
    const handles = document.getElementById('cache-handles');
    const cooldown = document.getElementById('cooldown');

    if (bytesEl) bytesEl.textContent = formatBytes(info ? info.bytesInUse : null);

    if (cfEl) {
      if (info && info.codeforcesArchive) {
        cfEl.textContent = new Intl.NumberFormat('ru-RU').format(info.codeforcesArchive.count) + ' задач';
        cfEl.title = 'Обновлён ' + formatDateTime(info.codeforcesArchive.fetchedAt);
      } else {
        cfEl.textContent = 'нет';
        cfEl.title = '';
      }
    }

    if (atcoderEl) {
      if (info && info.atcoderArchive) {
        atcoderEl.textContent = new Intl.NumberFormat('ru-RU').format(info.atcoderArchive.count) + ' задач';
        atcoderEl.title = 'Обновлён ' + formatDateTime(info.atcoderArchive.fetchedAt);
      } else {
        atcoderEl.textContent = 'нет';
        atcoderEl.title = '';
      }
    }

    if (profilesEl) {
      const profiles = new Set();
      for (const status of (info && info.statuses) || []) profiles.add(status.handle);
      for (const scrape of (info && info.scrapes) || []) profiles.add(scrape.handle);
      profilesEl.textContent = String(profiles.size);
    }

    if (details && handles) {
      handles.textContent = '';
      const statuses = info && Array.isArray(info.statuses) ? info.statuses : [];
      const scrapes = info && Array.isArray(info.scrapes) ? info.scrapes : [];
      details.hidden = statuses.length === 0 && scrapes.length === 0;
      for (const status of statuses) {
        const item = document.createElement('li');
        item.textContent = status.handle + ' · API · ' + formatRelative(status.fetchedAt);
        item.title = 'Посылок: ' + (status.totalSubmissions || 0) + ', решённых: ' + (status.solved || 0) +
          '\nОбновлено: ' + formatDateTime(status.fetchedAt);
        handles.append(item);
      }
      for (const scrape of scrapes) {
        const item = document.createElement('li');
        item.textContent = scrape.handle + ' · HTML, ' + (scrape.pages || 0) + ' стр. · ' +
          formatRelative(scrape.fetchedAt);
        item.title = 'Посылок: ' + (scrape.totalSubmissions || 0) + ', решённых: ' +
          (scrape.solved || 0) + (scrape.stopReason ? ', конец: ' + scrape.stopReason : '') +
          '\nОбновлено: ' + formatDateTime(scrape.fetchedAt);
        handles.append(item);
      }
    }

    if (cooldown) {
      const state = info && info.cooldown ? info.cooldown : null;
      const untilCf = state && state.codeforces ? Number(state.codeforces.until) || 0 : 0;
      const untilAtCoder = state && state.atcoder ? Number(state.atcoder.until) || 0 : 0;
      const now = Date.now();
      const active = Math.max(untilCf, untilAtCoder);
      if (active > now) {
        cooldown.hidden = false;
        cooldown.textContent = 'API временно на паузе после лимита. Повторные запросы будут ждать ещё ' +
          Math.max(1, Math.ceil((active - now) / 60000)) + ' мин.';
      } else {
        cooldown.hidden = true;
        cooldown.textContent = '';
      }
    }
  }

  async function refreshCacheInfo() {
    try {
      const info = await CFS_STORAGE.getCacheInfo();
      renderCacheInfo(info);
    } catch (error) {
      console.warn('[CF Stats+] Cache info failed', error);
      renderCacheInfo(null);
    }
  }

  async function clearCache() {
    const confirmed = window.confirm(
      'Очистить кэш архивов и историю посылок? Настройки останутся на месте.\n\n' +
      'При следующем открытии профиля данные будут загружены заново (с учётом задержек API).'
    );
    if (!confirmed) return;
    try {
      await CFS_STORAGE.clearAllCaches({ keepSettings: true });
      try {
        chrome.runtime.sendMessage({ type: CFS_CONST.MSG.CLEAR_CACHE }, function () {
          if (chrome.runtime && chrome.runtime.lastError) return;
        });
      } catch (error) {
        // The worker may be asleep; direct storage cleanup already happened.
      }
      await refreshCacheInfo();
      showToast('Кэш очищен');
    } catch (error) {
      console.error('[CF Stats+] Cache clear failed', error);
      showToast('Не удалось очистить кэш: ' + (error.message || 'storage error'), true);
    }
  }

  function bind() {
    form.addEventListener('submit', saveSettings);
    const saveTop = document.getElementById('save-top');
    if (saveTop) saveTop.addEventListener('click', saveSettings);
    const reset = document.getElementById('reset');
    if (reset) reset.addEventListener('click', resetSettings);
    const clear = document.getElementById('clear-cache');
    if (clear) clear.addEventListener('click', clearCache);
    fields.minRequestDelayMs.addEventListener('input', updateDelayWarning);
    fields.htmlScraping.addEventListener('change', updateHtmlFields);
  }

  async function init() {
    document.getElementById('version-badge').textContent = 'v' + CFS_CONST.VERSION;
    document.getElementById('version-text').textContent = CFS_CONST.VERSION;
    bind();
    try {
      const settings = await CFS_SETTINGS.ensureDefaults();
      fillForm(settings);
    } catch (error) {
      console.warn('[CF Stats+] Settings load failed', error);
      fillForm(CFS_SETTINGS.DEFAULTS);
      showToast('Не удалось прочитать настройки, показаны значения по умолчанию', true);
    }
    await refreshCacheInfo();
  }

  init();
})();
