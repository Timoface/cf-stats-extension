/**
 * CF Stats+ content script.
 *
 * Injected on codeforces.com/profile/*; renders a self-contained statistics
 * panel under the standard user box. All data and matching happen in the
 * background worker; this script only renders.
 */
(function () {
  'use strict';

  if (window.__cfsStatsPlusLoaded) return;
  window.__cfsStatsPlusLoaded = true;

  if (typeof CFS_CONST === 'undefined') {
    console.warn('[CF Stats+] constants are not loaded; content script skipped.');
    return;
  }

  const HOST_ID = 'cf-stats-plus';
  const COLLAPSE_KEY = 'cfs.statsPlus.collapsed';
  const MESSAGE_TIMEOUT_MS = 180000;
  const NUMBER_FORMAT = new Intl.NumberFormat('ru-RU');
  const DATE_FORMAT = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const SHORT_DATE_FORMAT = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
  });

  const TEMPLATE = `
<section class="cfs-panel" aria-label="CF Stats+ статистика пользователя Codeforces" data-state="idle">
  <header class="cfs-header">
    <div class="cfs-brand">
      <span class="cfs-logo" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3" y="12" width="4.2" height="9" rx="1.2" fill="currentColor"/>
          <rect x="9.9" y="7" width="4.2" height="14" rx="1.2" fill="currentColor" opacity=".92"/>
          <rect x="16.8" y="3" width="4.2" height="18" rx="1.2" fill="currentColor" opacity=".82"/>
        </svg>
      </span>
      <div class="cfs-brand-text">
        <div class="cfs-title-row">
          <h2 class="cfs-title">CF Stats+</h2>
          <span class="cfs-version">CF + AtCoder</span>
        </div>
        <p class="cfs-subtitle" data-role="subtitle">Статистика по архивам Codeforces и AtCoder</p>
      </div>
    </div>
    <div class="cfs-actions">
      <span class="cfs-cache-status" data-role="cache-status" title="Состояние локального кэша">загрузка…</span>
      <button class="cfs-icon-btn cfs-refresh" type="button" aria-label="Обновить статистику" title="Обновить и заново загрузить данные">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20.5 12a8.5 8.5 0 1 1-2.5-6.01"/>
          <path d="M20.5 3v6h-6"/>
        </svg>
      </button>
      <button class="cfs-icon-btn cfs-settings" type="button" aria-label="Настройки CF Stats+" title="Настройки">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/>
          <path d="M1 14h6M9 8h6M17 16h6"/>
        </svg>
      </button>
      <button class="cfs-icon-btn cfs-collapse" type="button" aria-label="Свернуть статистику" aria-expanded="true" title="Свернуть / развернуть">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m18 15-6-6-6 6"/>
        </svg>
      </button>
    </div>
  </header>

  <div class="cfs-progress" data-role="progress" role="status" aria-live="polite" hidden>
    <span class="cfs-progress-text" data-role="progress-text">Начинаю сбор статистики…</span>
  </div>

  <div class="cfs-warnings" data-role="warnings" hidden></div>

  <div class="cfs-skeleton" data-role="skeleton" aria-hidden="true">
    <div class="cfs-skel cfs-skel-summary"></div>
    <div class="cfs-skel cfs-skel-grid"></div>
    <div class="cfs-skel cfs-skel-lower"></div>
  </div>

  <div class="cfs-error" data-role="error" role="alert" hidden>
    <div class="cfs-error-icon" aria-hidden="true">!</div>
    <div>
      <h3 data-role="error-title">Не удалось загрузить статистику</h3>
      <p data-role="error-text"></p>
      <button class="cfs-retry" type="button" data-role="retry">Повторить</button>
    </div>
  </div>

  <div class="cfs-body" data-role="body" hidden>
    <div class="cfs-summary">
      <div class="cfs-stat cfs-stat--total">
        <div class="cfs-stat-label">Всего решено</div>
        <div class="cfs-stat-value" data-role="stat-total">—</div>
        <div class="cfs-stat-sub" data-role="stat-total-sub">уникальных задач</div>
      </div>
      <div class="cfs-stat cfs-stat--cf">
        <div class="cfs-stat-label">В архиве CF</div>
        <div class="cfs-stat-value" data-role="stat-cf">—</div>
        <div class="cfs-stat-sub" data-role="stat-cf-sub">—</div>
      </div>
      <div class="cfs-stat cfs-stat--training">
        <div class="cfs-stat-label">Из тренировок</div>
        <div class="cfs-stat-value" data-role="stat-training">—</div>
        <div class="cfs-stat-sub" data-role="stat-training-sub">—</div>
      </div>
      <div class="cfs-stat cfs-stat--atcoder">
        <div class="cfs-stat-label">AtCoder</div>
        <div class="cfs-stat-value" data-role="stat-atcoder">—</div>
        <div class="cfs-stat-sub" data-role="stat-atcoder-sub">—</div>
      </div>
      <div class="cfs-stat cfs-stat--rating">
        <div class="cfs-stat-label">Макс. рейтинг</div>
        <div class="cfs-stat-value" data-role="stat-rating">—</div>
        <div class="cfs-stat-sub" data-role="stat-rating-sub">—</div>
      </div>
    </div>

    <div class="cfs-grid">
      <article class="cfs-card cfs-rating-card">
        <div class="cfs-card-head">
          <div>
            <h3>Распределение по сложности</h3>
            <p class="cfs-card-sub" data-role="rating-sub">Решённые задачи по рейтингу Codeforces</p>
          </div>
          <div class="cfs-tabs" role="tablist" aria-label="Источник шкалы сложности">
            <button class="cfs-tab is-active" type="button" role="tab" aria-selected="true" data-source="cf">
              Codeforces <span class="cfs-tab-count" data-role="cf-count">0</span>
            </button>
            <button class="cfs-tab" type="button" role="tab" aria-selected="false" data-source="atcoder">
              AtCoder <span class="cfs-tab-count" data-role="atcoder-count">0</span>
            </button>
          </div>
        </div>
        <div class="cfs-chips" data-role="rating-chips"></div>
        <div class="cfs-canvas-wrap">
          <canvas class="cfs-rating-canvas" data-role="rating-canvas" role="img" aria-label="Гистограмма решённых задач по сложности"></canvas>
          <div class="cfs-chart-empty" data-role="rating-empty" hidden></div>
        </div>
        <p class="cfs-chart-note" data-role="rating-note"></p>
      </article>

      <article class="cfs-card cfs-tags-card">
        <div class="cfs-card-head">
          <div>
            <h3>Решённые теги</h3>
            <p class="cfs-card-sub" data-role="tags-sub">Распределение по тегам Codeforces</p>
          </div>
        </div>
        <div class="cfs-tags-layout" data-role="tags-layout">
          <div class="cfs-donut">
            <canvas data-role="tags-canvas" role="img" aria-label="Круговая диаграмма решённых тегов"></canvas>
            <div class="cfs-donut-center">
              <strong data-role="tags-center">0</strong>
              <span data-role="tags-center-label">задач с тегами</span>
            </div>
          </div>
          <ul class="cfs-legend" data-role="tags-legend" aria-label="Легенда тегов"></ul>
        </div>
        <div class="cfs-tags-empty" data-role="tags-empty" hidden>Нет данных по тегам.</div>
        <p class="cfs-tags-note" data-role="tags-note"></p>
      </article>
    </div>

    <div class="cfs-lower">
      <article class="cfs-card cfs-recent-card">
        <div class="cfs-card-head">
          <div>
            <h3>Из тренировок</h3>
            <p class="cfs-card-sub">Последние задачи gym, найденные в архивах</p>
          </div>
          <span class="cfs-pill" data-role="recent-count">0</span>
        </div>
        <ul class="cfs-recent" data-role="recent"></ul>
        <p class="cfs-empty" data-role="recent-empty" hidden>Задач из тренировок не найдено.</p>
      </article>

      <article class="cfs-card cfs-match-card">
        <div class="cfs-card-head">
          <div>
            <h3>Сопоставление</h3>
            <p class="cfs-card-sub">Сначала точное название, затем ID и эвристики</p>
          </div>
          <span class="cfs-pill" data-role="match-rate">0%</span>
        </div>
        <div class="cfs-source-bar" aria-hidden="true">
          <span class="cfs-source-bar-cf" data-role="bar-cf"></span>
          <span class="cfs-source-bar-atcoder" data-role="bar-atcoder"></span>
          <span class="cfs-source-bar-other" data-role="bar-other"></span>
        </div>
        <div class="cfs-source-legend">
          <span><i style="background:#2563eb"></i>CF <b data-role="legend-cf">0</b></span>
          <span><i style="background:#0d9488"></i>AtCoder <b data-role="legend-atcoder">0</b></span>
          <span><i style="background:#cbd5e1"></i>другие <b data-role="legend-other">0</b></span>
        </div>
        <div class="cfs-match-rows">
          <div class="cfs-match-row"><span>Точный contest ID</span><span data-match="contest-id">0</span></div>
          <div class="cfs-match-row"><span>Точное название (CF)</span><span data-match="exact-name">0</span></div>
          <div class="cfs-match-row"><span>Нечёткое название (CF)</span><span data-match="fuzzy-name">0</span></div>
          <div class="cfs-match-row"><span>AtCoder по названию</span><span data-match="atcoder-exact-name">0</span></div>
          <div class="cfs-match-row"><span>Не найдено</span><span data-match="none">0</span></div>
        </div>
        <details class="cfs-diag-details" data-role="unmatched-details">
          <summary>Не найдено: <span data-role="unmatched-count">0</span></summary>
          <div class="cfs-unmatched" data-role="unmatched-list"></div>
        </details>
        <p class="cfs-diag-note" data-role="diag-note"></p>
      </article>
    </div>

    <footer class="cfs-footer">
      <span>
        Данные: <a href="https://codeforces.com/apiHelp" target="_blank" rel="noopener noreferrer">Codeforces API</a>
        · <a href="https://kenkoooo.com/atcoder/" target="_blank" rel="noopener noreferrer">AtCoder Problems</a>
        · <span data-role="version"></span>
      </span>
      <span data-role="footer-cache"></span>
    </footer>
  </div>
</section>`;

  const state = {
    host: null,
    handle: null,
    loading: false,
    stats: null,
    activeTab: 'cf',
    selectedTag: -1,
    tagItems: [],
    tagColors: [],
    ratingChart: null,
    tagsChart: null,
    initToken: 0,
    loadSeq: 0,
    lastError: null,
  };

  function byRole(role) {
    return state.host ? state.host.querySelector('[data-role="' + role + '"]') : null;
  }

  function createElement(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function setText(role, text) {
    const node = byRole(role);
    if (node) node.textContent = text;
  }

  function formatNumber(value) {
    return NUMBER_FORMAT.format(Number(value) || 0);
  }

  function plural(number, one, few, many) {
    const abs = Math.abs(Number(number) || 0);
    const mod100 = abs % 100;
    const mod10 = abs % 10;
    if (mod100 >= 11 && mod100 <= 19) return many;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
  }

  function formatRelative(ms) {
    if (!ms) return 'нет данных';
    const diff = Date.now() - ms;
    if (diff < 45 * 1000) return 'только что';
    if (diff < 60 * 60 * 1000) {
      const minutes = Math.max(1, Math.floor(diff / 60000));
      return minutes + ' ' + plural(minutes, 'минуту', 'минуты', 'минут') + ' назад';
    }
    if (diff < 24 * 60 * 60 * 1000) {
      const hours = Math.max(1, Math.floor(diff / 3600000));
      return hours + ' ' + plural(hours, 'час', 'часа', 'часов') + ' назад';
    }
    return SHORT_DATE_FORMAT.format(new Date(ms));
  }

  function formatDateTime(ms) {
    if (!ms) return '—';
    return DATE_FORMAT.format(new Date(ms));
  }

  function formatSolvedDate(seconds) {
    if (!seconds) return '';
    return SHORT_DATE_FORMAT.format(new Date(seconds * 1000));
  }

  function safeUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(String(value));
      if (url.protocol !== 'https:') return null;
      const host = url.hostname.toLowerCase();
      const allowed = host === 'codeforces.com' || host.endsWith('.codeforces.com') ||
        host === 'atcoder.jp' || host.endsWith('.atcoder.jp');
      return allowed ? url.href : null;
    } catch (error) {
      return null;
    }
  }

  function makeError(code, message, extra) {
    const error = new Error(message || code || 'Unknown error');
    error.code = code || 'UNKNOWN';
    if (extra && typeof extra === 'object') Object.assign(error, extra);
    return error;
  }

  function parseProfileHandle() {
    const match = /^\/profile\/([^/?#]+)/i.exec(location.pathname);
    if (!match) return null;
    let handle;
    try {
      handle = decodeURIComponent(match[1]);
    } catch (error) {
      return null;
    }
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(handle)) return null;
    return handle;
  }

  function findAnchor() {
    const pageContent = document.getElementById('pageContent');
    if (pageContent) {
      const userbox = pageContent.querySelector('.userbox');
      if (userbox && userbox.parentNode) return { node: userbox, mode: 'after', userbox };
      return { node: pageContent, mode: 'prepend', pageContent };
    }
    const userbox = document.querySelector('.userbox');
    if (userbox && userbox.parentNode) return { node: userbox, mode: 'after', userbox };
    return null;
  }

  function resolveInsertionPoint(anchor) {
    if (!anchor || !anchor.node) return anchor;
    const pageContent = document.getElementById('pageContent');
    if (pageContent && !pageContent.contains(anchor.node)) {
      // Never insert into a sidebar/global wrapper: the widget must live in the
      // central column, after the profile card.
      return { node: pageContent, mode: 'prepend', pageContent };
    }
    return { node: anchor.node, mode: anchor.mode || 'after', userbox: anchor.userbox };
  }

  function waitForAnchor(timeoutMs) {
    return new Promise(function (resolve) {
      const started = Date.now();
      function check() {
        const anchor = findAnchor();
        if (anchor) {
          resolve(anchor);
          return;
        }
        if (Date.now() - started >= (timeoutMs || 12000)) {
          resolve(null);
          return;
        }
        setTimeout(check, 250);
      }
      check();
    });
  }

  function pageLooksDark() {
    try {
      const classes = (
        String(document.documentElement.className || '') + ' ' +
        String(document.body ? document.body.className : '')
      ).toLowerCase();
      if (/(^|\s)(dark|theme-dark|dark-theme)(\s|$)/.test(classes)) return true;

      const nodes = [document.body, document.documentElement];
      for (const node of nodes) {
        if (!node) continue;
        const background = getComputedStyle(node).backgroundColor;
        const match = /rgba?\(([^)]+)\)/.exec(background || '');
        if (!match) continue;
        const parts = match[1].split(',').map(function (part) { return Number(part.trim()); });
        const alpha = parts.length > 3 ? parts[3] : 1;
        if (alpha < 0.5) continue;
        const r = parts[0] / 255;
        const g = parts[1] / 255;
        const b = parts[2] / 255;
        const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        return luminance < 0.4;
      }
    } catch (error) {
      return false;
    }
    return false;
  }

  function prefersReducedMotion() {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (error) {
      return false;
    }
  }

  function applyTheme() {
    if (!state.host) return;
    state.host.classList.toggle('cfs-dark', pageLooksDark());
  }

  function chartTheme() {
    const fallback = {
      text: '#667085',
      grid: 'rgba(16, 24, 40, 0.07)',
      tooltipBg: '#101828',
      tooltipText: '#f9fafb',
      tooltipBorder: '#1f2937',
      donutBorder: '#ffffff',
      font: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif',
    };
    if (!state.host) return fallback;
    const style = getComputedStyle(state.host);
    function read(name, defaultValue) {
      const value = style.getPropertyValue(name).trim();
      return value || defaultValue;
    }
    return {
      text: read('--cfs-chart-text', fallback.text),
      grid: read('--cfs-chart-grid', fallback.grid),
      tooltipBg: read('--cfs-tooltip-bg', fallback.tooltipBg),
      tooltipText: read('--cfs-tooltip-text', fallback.tooltipText),
      tooltipBorder: read('--cfs-tooltip-border', fallback.tooltipBorder),
      donutBorder: read('--cfs-donut-border', fallback.donutBorder),
      font: style.fontFamily || fallback.font,
    };
  }

  function baseTooltip(theme) {
    return {
      backgroundColor: theme.tooltipBg,
      titleColor: theme.tooltipText,
      bodyColor: theme.tooltipText,
      borderColor: theme.tooltipBorder,
      borderWidth: 1,
      padding: 10,
      cornerRadius: 8,
      displayColors: false,
      titleFont: { size: 11, weight: '600', family: theme.font },
      bodyFont: { size: 11, family: theme.font },
    };
  }

  function ratingColorForBucket(bucket) {
    const colors = CFS_CONST.CF_RATING_COLORS;
    const rating = bucket.min;
    if (rating >= 3000) return colors.legendary;
    if (rating >= 2600) return colors.grandmaster;
    if (rating >= 2400) return colors.internationalMaster;
    if (rating >= 2100) return colors.master;
    if (rating >= 1900) return colors.candidateMaster;
    if (rating >= 1600) return colors.expert;
    if (rating >= 1400) return colors.specialist;
    if (rating >= 1200) return colors.pupil;
    return colors.newbie;
  }

  const ATCODER_BAR_COLORS = [
    '#5eead4', '#2dd4bf', '#14b8a6', '#0d9488', '#0f766e',
    '#0e7490', '#0369a1', '#1d4ed8', '#4338ca',
  ];

  function hexToRgba(hex, alpha) {
    const value = String(hex || '').replace('#', '');
    if (value.length !== 6) return hex;
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
  }

  function chartLibAvailable() {
    return typeof Chart !== 'undefined';
  }

  function createChips(container, chips) {
    container.textContent = '';
    for (const chip of chips) {
      const node = createElement('span', 'cfs-chip');
      node.append(document.createTextNode(chip.label + ' '));
      const strong = createElement('strong', null, chip.value);
      node.append(strong);
      container.append(node);
    }
  }

  function createRatingChart(canvas) {
    const theme = chartTheme();
    const tooltip = baseTooltip(theme);
    tooltip.callbacks = {
      title: function (items) {
        if (!items || !items.length) return '';
        return (state.activeTab === 'cf' ? 'Рейтинг ' : 'Сложность ') + items[0].label;
      },
      label: function (context) {
        const value = Number(context.parsed.y) || 0;
        return formatNumber(value) + ' ' + plural(value, 'задача', 'задачи', 'задач');
      },
    };

    return new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: [],
        datasets: [{
          label: 'Решённые задачи',
          data: [],
          backgroundColor: [],
          borderRadius: 5,
          borderSkipped: false,
          maxBarThickness: 34,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: prefersReducedMotion() ? false : {
          duration: 520,
          easing: 'easeOutQuart',
        },
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 6, right: 2, left: 0, bottom: 0 } },
        plugins: {
          legend: { display: false },
          tooltip: tooltip,
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: {
              color: theme.text,
              font: { size: 10, family: theme.font },
              maxRotation: 0,
              autoSkip: false,
              padding: 4,
              callback: function (value) {
                const label = this.getLabelForValue(value);
                if (state.activeTab !== 'cf') return label;
                if (label === '3000+') return label;
                const numeric = Number(label);
                return Number.isFinite(numeric) && (numeric - 800) % 400 === 0 ? label : '';
              },
            },
          },
          y: {
            beginAtZero: true,
            grid: { color: theme.grid, drawTicks: false },
            border: { display: false },
            ticks: {
              color: theme.text,
              font: { size: 10, family: theme.font },
              precision: 0,
              padding: 6,
              maxTicksLimit: 6,
            },
          },
        },
      },
    });
  }

  function createTagsChart(canvas) {
    const theme = chartTheme();
    const tooltip = baseTooltip(theme);
    tooltip.callbacks = {
      label: function (context) {
        const item = state.tagItems[context.dataIndex];
        if (!item) return '';
        return ' ' + item.tag + ': ' + formatNumber(item.count) + ' ' +
          plural(item.count, 'задача', 'задачи', 'задач') + ' (' + item.percent + '%)';
      },
    };

    return new Chart(canvas.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: [],
        datasets: [{
          data: [],
          backgroundColor: [],
          borderColor: theme.donutBorder,
          borderWidth: 2,
          hoverOffset: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        animation: prefersReducedMotion() ? false : {
          duration: 520,
          easing: 'easeOutQuart',
        },
        plugins: {
          legend: { display: false },
          tooltip: tooltip,
        },
      },
    });
  }

  function updateChartTheme(chart) {
    if (!chart) return;
    const theme = chartTheme();
    const tooltip = chart.options.plugins.tooltip;
    tooltip.backgroundColor = theme.tooltipBg;
    tooltip.titleColor = theme.tooltipText;
    tooltip.bodyColor = theme.tooltipText;
    tooltip.borderColor = theme.tooltipBorder;
    tooltip.titleFont.family = theme.font;
    tooltip.bodyFont.family = theme.font;
    if (chart.options.scales && chart.options.scales.x) {
      chart.options.scales.x.ticks.color = theme.text;
      chart.options.scales.x.ticks.font.family = theme.font;
      chart.options.scales.y.ticks.color = theme.text;
      chart.options.scales.y.ticks.font.family = theme.font;
      chart.options.scales.y.grid.color = theme.grid;
    }
    if (chart.config.type === 'doughnut') {
      chart.data.datasets[0].borderColor = theme.donutBorder;
    }
  }

  function setTabsState() {
    if (!state.host) return;
    const tabs = state.host.querySelectorAll('.cfs-tab');
    tabs.forEach(function (tab) {
      const active = tab.getAttribute('data-source') === state.activeTab;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  function renderRatingSection() {
    if (!state.host || !state.stats) return;
    const stats = state.stats;
    setText('cf-count', formatNumber(stats.cfRating.rated));
    setText('atcoder-count', formatNumber(stats.atcoder.rated));

    const atcoderAvailable = !!(stats.archives.atcoder.enabled && !stats.archives.atcoder.error);
    const atcoderTab = state.host.querySelector('.cfs-tab[data-source="atcoder"]');
    if (atcoderTab) {
      atcoderTab.hidden = !atcoderAvailable;
      atcoderTab.disabled = !atcoderAvailable;
    }
    if (!atcoderAvailable && state.activeTab === 'atcoder') state.activeTab = 'cf';
    setTabsState();

    const isCf = state.activeTab === 'cf';
    const rating = isCf ? stats.cfRating : stats.atcoder;
    const canvas = byRole('rating-canvas');
    const empty = byRole('rating-empty');
    const sub = byRole('rating-sub');
    const note = byRole('rating-note');
    const chips = byRole('rating-chips');

    if (sub) {
      sub.textContent = isCf
        ? 'Решённые задачи по рейтингу Codeforces'
        : 'Решённые задачи по сложности AtCoder';
    }

    createChips(chips, isCf
      ? [
        { label: 'Макс.', value: rating.max == null ? '—' : formatNumber(rating.max) },
        { label: 'Средний', value: rating.avg == null ? '—' : formatNumber(rating.avg) },
        { label: 'Без рейтинга', value: formatNumber(rating.unrated) },
      ]
      : [
        { label: 'Макс.', value: rating.max == null ? '—' : formatNumber(rating.max) },
        { label: 'Средний', value: rating.avg == null ? '—' : formatNumber(rating.avg) },
        { label: 'Без сложности', value: formatNumber(rating.unrated) },
      ]);

    if (note) {
      note.textContent = isCf
        ? 'Задачи из архива CF, а также задачи вне архива с известным рейтингом. Без рейтинга: ' +
          formatNumber(rating.unrated) + '.'
        : 'Шкала AtCoder difficulty не совпадает с рейтингом Codeforces, поэтому показана отдельно. ' +
          'Без сложности: ' + formatNumber(rating.unrated) + '.';
    }

    if (!chartLibAvailable()) {
      if (empty) {
        empty.hidden = false;
        empty.textContent = 'Библиотека графиков не загрузилась. Перезагрузите страницу.';
      }
      return;
    }

    if (!state.ratingChart) {
      state.ratingChart = createRatingChart(canvas);
    }
    const chart = state.ratingChart;
    const theme = chartTheme();
    const labels = rating.buckets.map(function (bucket) { return bucket.label; });
    const values = rating.buckets.map(function (bucket) { return bucket.count; });
    const colors = isCf
      ? rating.buckets.map(ratingColorForBucket)
      : rating.buckets.map(function (bucket, index) {
        return ATCODER_BAR_COLORS[index % ATCODER_BAR_COLORS.length];
      });

    chart.data.labels = labels;
    chart.data.datasets[0].data = values;
    chart.data.datasets[0].backgroundColor = colors;
    chart.options.scales.x.ticks.autoSkip = !isCf;
    chart.options.scales.x.ticks.maxTicksLimit = isCf ? undefined : 9;
    chart.options.scales.y.suggestedMax = values.some(function (value) { return value > 0; }) ? undefined : 5;
    updateChartTheme(chart);
    chart.update();

    const hasData = rating.rated > 0;
    if (empty) {
      empty.hidden = hasData;
      empty.textContent = isCf
        ? 'Нет задач с рейтингом Codeforces.'
        : 'Нет задач AtCoder с известной сложностью.';
    }
    if (canvas) {
      canvas.setAttribute('aria-label', isCf
        ? 'Гистограмма решённых задач по рейтингу Codeforces: ' + formatNumber(rating.rated) + ' задач'
        : 'Гистограмма решённых задач по сложности AtCoder: ' + formatNumber(rating.rated) + ' задач');
    }
    if (theme && state.host) {
      state.host.classList.toggle('cfs-dark', pageLooksDark());
    }
  }

  function updateTagsSelection() {
    if (!state.host) return;
    const chart = state.tagsChart;
    const selected = state.selectedTag;
    if (chart) {
      const colors = state.tagColors.map(function (color, index) {
        if (selected < 0 || selected === index) return color;
        return hexToRgba(color, 0.24);
      });
      chart.data.datasets[0].backgroundColor = colors;
      chart.data.datasets[0].borderWidth = selected < 0 ? 2 : 2.5;
      updateChartTheme(chart);
      chart.update();
    }

    const legendItems = state.host.querySelectorAll('.cfs-legend-item');
    legendItems.forEach(function (item, index) {
      item.classList.toggle('is-selected', selected === index);
      item.classList.toggle('is-dimmed', selected >= 0 && selected !== index);
    });

    const centerValue = byRole('tags-center');
    const centerLabel = byRole('tags-center-label');
    if (!centerValue || !centerLabel) return;
    if (selected >= 0 && state.tagItems[selected]) {
      const item = state.tagItems[selected];
      centerValue.textContent = formatNumber(item.count);
      centerLabel.textContent = item.isOther ? 'другие теги' : item.tag;
    } else if (state.stats) {
      centerValue.textContent = formatNumber(state.stats.tags.taggedProblems);
      centerLabel.textContent = 'задач с тегами';
    }
  }

  function renderTagsSection() {
    if (!state.host || !state.stats) return;
    const stats = state.stats;
    const items = stats.tags.items || [];
    const layout = byRole('tags-layout');
    const empty = byRole('tags-empty');
    const note = byRole('tags-note');
    const legend = byRole('tags-legend');
    const sub = byRole('tags-sub');

    if (!items.length) {
      if (layout) layout.hidden = true;
      if (empty) empty.hidden = false;
      if (legend) legend.textContent = '';
      if (state.tagsChart) {
        state.tagsChart.destroy();
        state.tagsChart = null;
      }
      if (note) note.textContent = 'У решённых задач нет тегов в архиве Codeforces.';
      if (sub) sub.textContent = 'Нет данных по тегам';
      return;
    }

    if (layout) layout.hidden = false;
    if (empty) empty.hidden = true;
    if (sub) {
      sub.textContent = 'Распределение по ' + formatNumber(stats.tags.distinctTags) + ' тегам Codeforces';
    }

    state.tagItems = items;
    state.tagColors = items.map(function (item, index) {
      if (item.isOther) return '#94a3b8';
      return CFS_CONST.TAG_COLORS[index % CFS_CONST.TAG_COLORS.length];
    });
    if (state.selectedTag >= items.length) state.selectedTag = -1;

    if (legend) {
      legend.textContent = '';
      items.forEach(function (item, index) {
        const button = createElement('button', 'cfs-legend-item');
        button.type = 'button';
        button.title = item.tag + ': ' + formatNumber(item.count) + ' задач (' + item.percent + '%)';
        button.setAttribute('aria-pressed', state.selectedTag === index ? 'true' : 'false');
        const swatch = createElement('span', 'cfs-legend-swatch');
        swatch.style.backgroundColor = state.tagColors[index];
        const label = createElement('span', 'cfs-legend-label', item.isOther ? 'другие' : item.tag);
        const count = createElement('span', 'cfs-legend-count', formatNumber(item.count));
        button.append(swatch, label, count);
        button.addEventListener('click', function () {
          state.selectedTag = state.selectedTag === index ? -1 : index;
          updateTagsSelection();
          button.setAttribute('aria-pressed', state.selectedTag === index ? 'true' : 'false');
        });
        button.addEventListener('mouseenter', function () {
          if (!state.tagsChart) return;
          state.tagsChart.setActiveElements([{ datasetIndex: 0, index: index }]);
          state.tagsChart.update('none');
        });
        button.addEventListener('mouseleave', function () {
          if (!state.tagsChart) return;
          state.tagsChart.setActiveElements([]);
          state.tagsChart.update('none');
        });
        legend.append(button);
      });
    }

    if (!chartLibAvailable()) {
      if (note) note.textContent = 'Библиотека графиков не загрузилась. Перезагрузите страницу.';
      return;
    }

    const canvas = byRole('tags-canvas');
    if (!state.tagsChart) {
      state.tagsChart = createTagsChart(canvas);
    }
    const chart = state.tagsChart;
    chart.data.labels = items.map(function (item) { return item.isOther ? 'другие' : item.tag; });
    chart.data.datasets[0].data = items.map(function (item) { return item.count; });
    state.tagColors = items.map(function (item, index) {
      if (item.isOther) return '#94a3b8';
      return CFS_CONST.TAG_COLORS[index % CFS_CONST.TAG_COLORS.length];
    });
    chart.data.datasets[0].backgroundColor = state.tagColors.slice();
    updateChartTheme(chart);
    chart.update();

    if (note) {
      let text = 'У задачи может быть несколько тегов; проценты считаются от числа задач с тегами. ';
      if (stats.tags.untaggedAtcoder > 0) {
        text += formatNumber(stats.tags.untaggedAtcoder) + ' ' +
          plural(stats.tags.untaggedAtcoder, 'задача AtCoder не имеет', 'задачи AtCoder не имеют', 'задач AtCoder не имеют') +
          ' тегов в архиве AtCoder Problems.';
      }
      note.textContent = text;
    }
    updateTagsSelection();
  }

  function renderRecent() {
    if (!state.host || !state.stats) return;
    const items = state.stats.recent || [];
    const list = byRole('recent');
    const empty = byRole('recent-empty');
    setText('recent-count', formatNumber(items.length));
    if (!list) return;
    list.textContent = '';
    if (empty) empty.hidden = items.length > 0;

    for (const item of items) {
      const li = createElement('li', 'cfs-recent-item');
      const badge = createElement(
        'span',
        'cfs-source-badge ' + (item.source === 'atcoder' ? 'cfs-source-badge--atcoder' : 'cfs-source-badge--cf'),
        item.source === 'atcoder' ? 'AT' : 'CF'
      );
      const main = createElement('div', 'cfs-recent-main');
      const url = safeUrl(item.url);
      const name = url
        ? createElement('a', 'cfs-recent-name', item.name)
        : createElement('span', 'cfs-recent-name', item.name);
      if (url) {
        name.href = url;
        name.target = '_blank';
        name.rel = 'noopener noreferrer';
      }
      if (item.originalName && item.originalName !== item.name) {
        name.title = 'В тренировке: ' + item.originalName;
      }

      const meta = createElement('div', 'cfs-recent-meta');
      if (item.source === 'atcoder') {
        meta.append(document.createTextNode('AtCoder'));
      } else {
        meta.append(document.createTextNode('Codeforces'));
      }
      if (item.rating != null) {
        meta.append(document.createTextNode(' · рейтинг ' + formatNumber(item.rating)));
      }
      if (item.difficulty != null) {
        meta.append(document.createTextNode(' · сложность ' + formatNumber(item.difficulty)));
      }
      const originalUrl = safeUrl(item.originalUrl);
      if (originalUrl) {
        meta.append(document.createTextNode(' · '));
        const original = createElement('a', null, 'оригинал ↗');
        original.href = originalUrl;
        original.target = '_blank';
        original.rel = 'noopener noreferrer';
        original.title = item.originalName || 'Оригинальная задача в тренировке';
        meta.append(original);
      }
      const date = formatSolvedDate(item.solvedAt);
      if (date) {
        meta.append(document.createTextNode(' · ' + date));
      }

      main.append(name, meta);
      li.append(badge, main);
      list.append(li);
    }
  }

  function renderMatching() {
    if (!state.host || !state.stats) return;
    const stats = state.stats;
    const total = stats.totalSolved || 0;
    const strategies = stats.diagnostics.strategies || {};
    const matchedCount = (stats.sourceCounts.codeforces || 0) + (stats.sourceCounts.atcoder || 0);
    const matchRate = total ? Math.round((matchedCount / total) * 100) : 0;

    setText('match-rate', matchRate + '%');
    setText('legend-cf', formatNumber(stats.sourceCounts.codeforces));
    setText('legend-atcoder', formatNumber(stats.sourceCounts.atcoder));
    setText('legend-other', formatNumber(stats.sourceCounts.other));

    const barCf = byRole('bar-cf');
    const barAtCoder = byRole('bar-atcoder');
    const barOther = byRole('bar-other');
    if (barCf) barCf.style.width = (total ? stats.percent.codeforces : 0) + '%';
    if (barAtCoder) barAtCoder.style.width = (total ? stats.percent.atcoder : 0) + '%';
    if (barOther) barOther.style.width = (total ? stats.percent.other : 0) + '%';

    const mapping = {
      'contest-id': strategies['contest-id'] || 0,
      'exact-name': strategies['exact-name'] || 0,
      'fuzzy-name': (strategies['fuzzy-name'] || 0) + (strategies['fuzzy-tags'] || 0),
      'atcoder-exact-name': strategies['atcoder-exact-name'] || 0,
      none: strategies.none || 0,
    };
    Object.keys(mapping).forEach(function (key) {
      const node = state.host.querySelector('[data-match="' + key + '"]');
      if (node) node.textContent = formatNumber(mapping[key]);
    });

    const details = byRole('unmatched-details');
    const count = byRole('unmatched-count');
    const list = byRole('unmatched-list');
    const examples = stats.diagnostics.unmatchedExamples || [];
    if (count) count.textContent = formatNumber(mapping.none);
    if (details) details.hidden = mapping.none === 0;
    if (list) {
      list.textContent = '';
      for (const example of examples) {
        const url = safeUrl(example.url);
        const node = url
          ? createElement('a', null, example.name)
          : createElement('span', null, example.name);
        if (url) {
          node.href = url;
          node.target = '_blank';
          node.rel = 'noopener noreferrer';
        }
        node.title = example.reason || '';
        list.append(node);
      }
      if (examples.length && mapping.none > examples.length) {
        list.append(createElement('span', null, '…и ещё ' + formatNumber(mapping.none - examples.length)));
      }
    }

    const note = byRole('diag-note');
    if (note) {
      const archives = stats.archives;
      let text =
        'Архивы: CF ' + formatNumber(archives.codeforces.count) +
        ' · AtCoder ' + formatNumber(archives.atcoder.count) + '. ' +
        'AtCoder-задачи не имеют тегов в архиве AtCoder Problems, поэтому не входят в диаграмму тегов.';
      if (stats.training.unmatched > 0) {
        const count = stats.training.unmatched;
        text += ' ' + formatNumber(count) + ' ' +
          plural(count, 'задача из тренировок не найдена', 'задачи из тренировок не найдены', 'задач из тренировок не найдены') +
          ' в архивах — обычно это внешние задачи ICPC/олимпиад, у которых нет рейтинга и тегов Codeforces.';
      }
      note.textContent = text;
    }
  }

  function renderSummary() {
    const stats = state.stats;
    const total = stats.totalSolved || 0;
    setText('stat-total', formatNumber(total));
    setText('stat-total-sub', total
      ? plural(total, 'уникальная задача', 'уникальные задачи', 'уникальных задач')
      : 'пока нет решённых задач');

    setText('stat-cf', formatNumber(stats.sourceCounts.codeforces));
    setText('stat-cf-sub', total
      ? stats.percent.codeforces + '% от всех'
      : 'архив CF');

    setText('stat-training', formatNumber(stats.training.total));
    if (stats.training.total) {
      setText('stat-training-sub', 'сопоставлено ' + formatNumber(stats.training.matched) +
        ' из ' + formatNumber(stats.training.total));
    } else {
      setText('stat-training-sub', 'нет задач из gym');
    }

    if (!stats.archives.atcoder.enabled) {
      setText('stat-atcoder', '—');
      setText('stat-atcoder-sub', 'выключено в настройках');
    } else if (stats.archives.atcoder.error) {
      setText('stat-atcoder', formatNumber(stats.sourceCounts.atcoder));
      setText('stat-atcoder-sub', 'архив недоступен');
    } else {
      setText('stat-atcoder', formatNumber(stats.sourceCounts.atcoder));
      setText('stat-atcoder-sub', total
        ? stats.percent.atcoder + '% от всех'
        : 'по архиву AtCoder');
    }

    setText('stat-rating', stats.cfRating.max == null ? '—' : formatNumber(stats.cfRating.max));
    setText('stat-rating-sub', stats.cfRating.avg == null
      ? 'нет задач с рейтингом'
      : 'средний ' + formatNumber(stats.cfRating.avg));
  }

  function renderWarnings() {
    const container = byRole('warnings');
    if (!container) return;
    container.textContent = '';
    const warnings = state.stats && Array.isArray(state.stats.warnings) ? state.stats.warnings : [];
    if (!warnings.length) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    for (const warning of warnings) {
      const node = createElement('div', 'cfs-warning', warning);
      container.append(node);
    }
  }

  function renderCacheStatus() {
    if (!state.host || !state.stats) return;
    const stats = state.stats;
    const node = byRole('cache-status');
    if (!node) return;
    const fromCache = stats.performance && stats.performance.statusFromCache;
    const source = stats.performance && stats.performance.statusSource;
    let text;
    if (source === 'html') {
      text = (fromCache ? 'HTML-кэш' : 'HTML') + ' · ' + formatRelative(stats.fetchedAt);
    } else if (stats.isStale) {
      text = 'кэш · ' + formatRelative(stats.fetchedAt);
    } else if (fromCache) {
      text = 'кэш · ' + formatRelative(stats.fetchedAt);
    } else {
      text = 'обновлено ' + formatRelative(stats.fetchedAt);
    }
    node.textContent = text;
    node.classList.toggle('is-stale', !!stats.isStale);
    node.title = 'Данные от ' + formatDateTime(stats.fetchedAt) +
      (source === 'html' && stats.performance
        ? ' · HTML, страниц: ' + (stats.performance.scrapePages || 0)
        : '') +
      (stats.performance ? ' · ' + stats.performance.elapsedMs + ' мс' : '');
  }

  function renderFooter() {
    if (!state.host || !state.stats) return;
    const stats = state.stats;
    setText('version', 'v' + (stats.version || CFS_CONST.VERSION));
    const footer = byRole('footer-cache');
    if (footer) {
      const cf = stats.archives.codeforces.fetchedAt
        ? 'CF-архив ' + formatRelative(stats.archives.codeforces.fetchedAt)
        : 'CF-архив не загружен';
      const atcoder = stats.archives.atcoder.enabled
        ? (stats.archives.atcoder.fetchedAt
          ? 'AtCoder-архив ' + formatRelative(stats.archives.atcoder.fetchedAt)
          : 'AtCoder-архив не загружен')
        : 'AtCoder выключен';
      footer.textContent = cf + ' · ' + atcoder;
      footer.title = 'CF: ' + formatDateTime(stats.archives.codeforces.fetchedAt) +
        ' · AtCoder: ' + formatDateTime(stats.archives.atcoder.fetchedAt);
    }
  }

  function renderStats() {
    if (!state.host || !state.stats) return;
    state.selectedTag = -1;
    state.host.dataset.state = 'ready';
    const body = byRole('body');
    const skeleton = byRole('skeleton');
    const error = byRole('error');
    const progress = byRole('progress-text');
    const progressBox = byRole('progress');
    if (body) body.hidden = false;
    if (skeleton) skeleton.hidden = true;
    if (error) error.hidden = true;
    if (progress) progress.textContent = '';
    if (progressBox) progressBox.hidden = true;

    renderSummary();
    renderWarnings();
    renderCacheStatus();
    renderRatingSection();
    renderTagsSection();
    renderRecent();
    renderMatching();
    renderFooter();
    const subtitle = byRole('subtitle');
    if (subtitle) {
      subtitle.textContent = 'Статистика @' + state.handle + ' по архивам Codeforces и AtCoder';
    }
    if (state.host) state.host.setAttribute('aria-busy', 'false');
    requestAnimationFrame(function () {
      if (state.ratingChart) state.ratingChart.resize();
      if (state.tagsChart) state.tagsChart.resize();
    });
  }

  function finishLoading() {
    state.loading = false;
    if (!state.host) return;
    const refresh = state.host.querySelector('.cfs-refresh');
    if (refresh) {
      refresh.disabled = false;
      refresh.classList.remove('is-spinning');
    }
    state.host.setAttribute('aria-busy', 'false');
    const progress = byRole('progress-text');
    if (progress) progress.textContent = '';
    const progressBox = byRole('progress');
    if (progressBox) progressBox.hidden = true;
  }

  function showLoading(force) {
    if (!state.host) return;
    state.loading = true;
    state.lastError = null;
    state.host.dataset.state = 'loading';
    state.host.setAttribute('aria-busy', 'true');
    const body = byRole('body');
    const skeleton = byRole('skeleton');
    const error = byRole('error');
    const warnings = byRole('warnings');
    const progress = byRole('progress-text');
    const progressBox = byRole('progress');
    const refresh = state.host.querySelector('.cfs-refresh');
    if (body) body.hidden = true;
    if (skeleton) skeleton.hidden = false;
    if (error) error.hidden = true;
    if (progressBox) progressBox.hidden = false;
    if (warnings) {
      warnings.hidden = true;
      warnings.textContent = '';
    }
    if (progress) progress.textContent = force ? 'Обновляю данные…' : 'Начинаю сбор статистики…';
    if (refresh) {
      refresh.disabled = true;
      refresh.classList.add('is-spinning');
    }
    const cache = byRole('cache-status');
    if (cache) {
      cache.textContent = force ? 'обновляю…' : 'загружаю…';
      cache.classList.remove('is-stale');
    }
  }

  function errorMessage(error) {
    const code = error && error.code;
    const retryMinutes = error && error.retryAfterMs
      ? Math.max(1, Math.ceil(error.retryAfterMs / 60000))
      : 0;
    let message;
    switch (code) {
      case 'HANDLE_NOT_FOUND':
        message = 'Пользователь @' + state.handle + ' не найден в Codeforces API. ' +
          'Возможно, это организация или API временно недоступен.';
        break;
      case 'INVALID_HANDLE':
        message = 'Codeforces API не принял имя пользователя. Проверьте профиль.';
        break;
      case 'RATE_LIMITED':
        message = 'Codeforces ограничил частоту запросов.' +
          (retryMinutes ? ' Повторите примерно через ' + retryMinutes + ' мин.' : ' Подождите немного и повторите.');
        break;
      case 'CLOUDFLARE':
        message = 'Codeforces временно включил защиту Cloudflare. Подождите несколько минут и повторите.';
        break;
      case 'TIMEOUT':
        message = 'Не дождались ответа от расширения. Попробуйте обновить статистику ещё раз.';
        break;
      case 'NETWORK':
        message = 'Не удалось связаться с API. Проверьте интернет-соединение и повторите.';
        break;
      case 'EXTENSION_UNAVAILABLE':
        message = 'Фоновый скрипт расширения недоступен. Перезагрузите страницу.';
        break;
      case 'RUNTIME':
        message = 'Расширение было обновлено или перезагружено. Перезагрузите страницу.';
        break;
      default:
        message = 'Не удалось получить статистику. ' +
          'Попробуйте повторить запрос; если ошибка повторяется — проверьте настройки.';
        break;
    }
    if (error && error.message && !/Extension context invalidated/i.test(error.message)) {
      // Technical detail is intentionally understated, but useful for reports.
      message += ' (' + error.message + ')';
    }
    return message;
  }

  function showError(error) {
    state.lastError = error;
    state.loading = false;
    if (!state.host) return;
    const skeleton = byRole('skeleton');
    const errorBox = byRole('error');
    const body = byRole('body');
    const warnings = byRole('warnings');
    const progress = byRole('progress-text');
    const progressBox = byRole('progress');
    if (skeleton) skeleton.hidden = true;
    if (errorBox) errorBox.hidden = false;
    if (warnings) warnings.hidden = true;
    if (progress) progress.textContent = '';
    if (progressBox) progressBox.hidden = true;
    if (body) body.hidden = !state.stats;
    const title = byRole('error-title');
    const text = byRole('error-text');
    if (title) title.textContent = state.stats ? 'Не удалось обновить данные' : 'Не удалось загрузить статистику';
    if (text) text.textContent = errorMessage(error);
    const cache = byRole('cache-status');
    if (cache) {
      cache.textContent = 'ошибка';
      cache.classList.add('is-stale');
    }
    const refresh = state.host.querySelector('.cfs-refresh');
    if (refresh) {
      refresh.disabled = false;
      refresh.classList.remove('is-spinning');
    }
    state.host.dataset.state = state.stats ? 'ready' : 'error';
    state.host.setAttribute('aria-busy', 'false');
  }

  function sendMessage(message, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage)) {
        reject(makeError('EXTENSION_UNAVAILABLE', 'chrome.runtime.sendMessage is unavailable'));
        return;
      }
      let settled = false;
      const timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(makeError('TIMEOUT', 'The background worker did not respond in time'));
      }, timeoutMs || MESSAGE_TIMEOUT_MS);

      try {
        chrome.runtime.sendMessage(message, function (response) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const lastError = chrome.runtime && chrome.runtime.lastError;
          if (lastError) {
            reject(makeError('RUNTIME', lastError.message || 'runtime.lastError'));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(makeError('RUNTIME', error.message || String(error)));
      }
    });
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  const SCRAPE_DEFAULT_CONFIG = {
    htmlScraping: true,
    maxScrapePages: 180,
    scrapeDelayMs: 600,
    cacheTtlMs: 15 * 60 * 1000,
    pageSize: 30,
  };
  const SCRAPE_TIME_LIMIT_MS = 150000;

  async function getScrapeConfig() {
    try {
      const response = await sendMessage({ type: CFS_CONST.MSG.GET_SCRAPE_CONFIG }, 10000);
      if (response && response.ok && response.data) {
        return Object.assign({}, SCRAPE_DEFAULT_CONFIG, response.data);
      }
    } catch (error) {
      console.warn('[CF Stats+] Could not load scrape settings', error);
    }
    return SCRAPE_DEFAULT_CONFIG;
  }

  async function getScrapeCache(handle) {
    try {
      const response = await sendMessage({
        type: CFS_CONST.MSG.GET_SCRAPE_CACHE,
        handle,
      }, 10000);
      if (response && response.ok && response.data) return response.data;
    } catch (error) {
      console.warn('[CF Stats+] Could not read HTML scrape cache', error);
    }
    return { data: null, fetchedAt: 0, fresh: false };
  }

  function saveScrapeCache(handle, payload) {
    sendMessage({
      type: CFS_CONST.MSG.SAVE_SCRAPE_CACHE,
      handle,
      data: payload,
    }, 10000).catch(function (error) {
      console.warn('[CF Stats+] Could not save HTML scrape cache', error);
    });
  }

  function fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs || 20000);
    return fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'follow',
      headers: { Accept: 'text/html,application/xhtml+xml' },
      signal: controller.signal,
    }).finally(function () {
      clearTimeout(timer);
    });
  }

  function parseRetryAfter(value) {
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(60000, Math.round(seconds * 1000));
    }
    const when = Date.parse(value);
    if (Number.isFinite(when)) return Math.min(60000, Math.max(0, when - Date.now()));
    return 0;
  }

  /**
   * Fetches one submissions page with bounded retries.
   *
   * 404 is a normal end of pagination and is returned immediately. 403/429,
   * 5xx, network errors, timeouts and Cloudflare interstitials are retried with
   * exponential backoff (respecting Retry-After). Only after all attempts are
   * exhausted does the caller mark the scrape as partial.
   */
  async function fetchSubmissionPage(url, onRetry) {
    const maxAttempts = 5;
    let backoff = 2500;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response;
      try {
        response = await fetchWithTimeout(url, 20000);
      } catch (error) {
        const reason = error && error.name === 'AbortError' ? 'timeout' : 'network';
        if (attempt >= maxAttempts) {
          return { ok: false, reason, attempts: attempt };
        }
        const wait = Math.min(30000, backoff + Math.floor(Math.random() * 400));
        if (onRetry) onRetry(reason, attempt, wait);
        await delay(wait);
        backoff = Math.min(15000, backoff * 2);
        continue;
      }

      if (response.status === 404) {
        return { ok: false, end: true, reason: 'end', attempts: attempt };
      }

      if (!response.ok) {
        const status = response.status;
        const retryable = status === 403 || status === 408 || status === 425 ||
          status === 429 || status >= 500;
        if (!retryable || attempt >= maxAttempts) {
          return { ok: false, reason: 'http-' + status, status, attempts: attempt };
        }
        const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
        const wait = Math.min(30000, Math.max(backoff, retryAfter)) +
          Math.floor(Math.random() * 400);
        if (onRetry) onRetry('http-' + status, attempt, wait);
        await delay(wait);
        backoff = Math.min(15000, backoff * 2);
        continue;
      }

      let html;
      try {
        html = await response.text();
      } catch (error) {
        if (attempt >= maxAttempts) {
          return { ok: false, reason: 'network', attempts: attempt };
        }
        const wait = Math.min(30000, backoff + Math.floor(Math.random() * 400));
        if (onRetry) onRetry('network', attempt, wait);
        await delay(wait);
        backoff = Math.min(15000, backoff * 2);
        continue;
      }

      if (CFS_SCRAPE.looksLikeChallenge(html)) {
        if (attempt >= maxAttempts) {
          return { ok: false, reason: 'cloudflare', attempts: attempt };
        }
        const wait = Math.min(30000, backoff + Math.floor(Math.random() * 400));
        if (onRetry) onRetry('cloudflare', attempt, wait);
        await delay(wait);
        backoff = Math.min(15000, backoff * 2);
        continue;
      }

      return { ok: true, html, attempts: attempt, retries: attempt - 1 };
    }

    return { ok: false, reason: 'network', attempts: maxAttempts };
  }

  function isCurrentLoad(seq, requestedHandle) {
    return seq === state.loadSeq && !!state.host && state.handle === requestedHandle;
  }

  /**
   * Collects accepted submissions from Codeforces submission HTML pages.
   *
   * The page may be visible only with the user's cookies (private groups), so
   * this deliberately runs in the content script on the Codeforces origin with
   * credentials: 'same-origin'. Every non-OK/404/empty/challenge response ends
   * the loop without throwing; already parsed rows are returned.
   */
  async function scrapeSubmissions(handle, config, seq, requestedHandle, progress) {
    const startedAt = Date.now();
    const solved = new Map();
    let pages = 0;
    let totalRows = 0;
    let accepted = 0;
    let stopReason = 'end';
    let partial = false;
    let truncated = false;
    let lastSignature = '';
    let detectedPageSize = 0;
    let retries = 0;
    let pageDelay = 0;

    const maxPages = Math.max(1, Math.min(180, Number(config.maxScrapePages) || 180));
    pageDelay = Math.max(100, Math.min(2000, Number(config.scrapeDelayMs) || 600));

    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      if (!isCurrentLoad(seq, requestedHandle)) {
        throw makeError('CANCELLED', 'Scrape was cancelled');
      }
      if (Date.now() - startedAt > SCRAPE_TIME_LIMIT_MS) {
        stopReason = 'timeout';
        partial = solved.size > 0;
        break;
      }

      if (progress) {
        progress('Загружаю посылки: страница ' + pageNumber +
          (solved.size ? ' · найдено ' + formatNumber(solved.size) + ' задач' : '') + '…');
      }

      const url = CFS_SCRAPE.pageUrl(location.origin, handle, pageNumber);
      const page = await fetchSubmissionPage(url, function (reason, attempt, wait) {
        if (!progress) return;
        const label = reason === 'network' ? 'сеть'
          : (reason === 'timeout' ? 'таймаут'
            : (reason === 'cloudflare' ? 'проверка Cloudflare' : reason));
        progress('Страница ' + pageNumber + ' не загрузилась (' + label +
          '). Повтор ' + attempt + '/3 через ' + Math.max(1, Math.round(wait / 1000)) +
          ' с…');
      });

      if (!page.ok) {
        if (page.end) {
          stopReason = 'end';
        } else {
          stopReason = page.reason;
          partial = pages > 0;
        }
        break;
      }

      retries += page.retries || 0;
      if (page.retries) {
        // A rate limit usually means 300 ms is too aggressive for this profile.
        pageDelay = Math.max(pageDelay, 1200);
      }
      const html = page.html;

      const parsed = CFS_SCRAPE.parseSubmissionsHtml(html, url);
      if (!parsed.hasTable || parsed.rows === 0) {
        stopReason = 'end';
        break;
      }
      if (pageNumber === 1) detectedPageSize = parsed.rows;

      const firstId = (html.match(/data-submission-id=["']?(\d+)/) || [])[1] || '';
      const signature = parsed.rows + ':' + firstId;
      if (pageNumber > 1 && signature === lastSignature) {
        stopReason = 'duplicate-page';
        partial = solved.size > 0;
        break;
      }
      lastSignature = signature;

      pages = pageNumber;
      totalRows += parsed.rows;
      accepted += parsed.accepted;
      for (const problem of parsed.solved) {
        const key = problem.group
          ? 'group:' + (problem.url || CFS_NORMALIZE.normalizeTitle(problem.name))
          : (problem.contestId != null && problem.index
            ? 'id:' + problem.contestId + ':' + problem.index
            : 'name:' + CFS_NORMALIZE.normalizeTitle(problem.name));
        if (!solved.has(key)) solved.set(key, problem);
      }

      if (progress) {
        progress('Страница ' + pageNumber + ': посылок ' + formatNumber(totalRows) +
          ', найдено задач ' + formatNumber(solved.size) + '…');
      }

      // Same termination signal as the reference userscript: Codeforces renders
      // a → link only when a next submissions page exists.
      if (parsed.hasPagination && !parsed.hasNextPage) {
        stopReason = 'end';
        break;
      }

      // Pages are queried in fixed slices. A short page is the last one; do not
      // waste a request (which sometimes returns 403 instead of 404).
      if (detectedPageSize > 0 && parsed.rows < detectedPageSize) {
        stopReason = 'end';
        break;
      }

      if (pageNumber === maxPages) {
        truncated = true;
        stopReason = 'limit';
        break;
      }
      await delay(pageDelay + Math.floor(Math.random() * 150));
    }

    const solvedList = Array.from(solved.values());
    const meta = {
      source: 'html',
      fetchedAt: Date.now(),
      pages,
      totalRows,
      accepted,
      complete: stopReason === 'end' && !truncated,
      partial: partial && solvedList.length > 0,
      truncated,
      stopReason,
      retries,
      elapsedMs: Date.now() - startedAt,
      fromCache: false,
    };

    return { solved: solvedList, meta };
  }

  async function load(force) {
    if (!state.host || !state.handle || state.loading) return;
    const seq = ++state.loadSeq;
    const requestedHandle = state.handle;
    showLoading(!!force);
    try {
      let scraped = null;
      let scrapeMeta = null;
      const config = await getScrapeConfig();

      if (!isCurrentLoad(seq, requestedHandle)) return;

      if (config.htmlScraping && typeof CFS_SCRAPE !== 'undefined') {
        const cache = await getScrapeCache(requestedHandle);
        if (!isCurrentLoad(seq, requestedHandle)) return;

        if (!force && cache.fresh && cache.data && Array.isArray(cache.data.solved)) {
          scraped = cache.data.solved;
          scrapeMeta = Object.assign({}, cache.data.meta || {}, {
            fromCache: true,
            fetchedAt: cache.fetchedAt || Date.now(),
          });
          const progress = byRole('progress-text');
          if (progress) progress.textContent = 'Использую кэш HTML-посылок…';
        } else {
          const result = await scrapeSubmissions(
            requestedHandle,
            config,
            seq,
            requestedHandle,
            function (message) {
              if (!isCurrentLoad(seq, requestedHandle)) return;
              const progress = byRole('progress-text');
              if (progress) progress.textContent = message;
            }
          );
          if (!isCurrentLoad(seq, requestedHandle)) return;
          if (result.solved.length > 0 || result.meta.pages > 0) {
            scraped = result.solved;
            scrapeMeta = result.meta;
            // Never cache a partial scrape: the next profile open should retry
            // the missing pages instead of showing the same truncated history.
            if (!result.meta.partial) {
              saveScrapeCache(requestedHandle, { solved: result.solved, meta: result.meta });
            }
          } else if (cache.data && Array.isArray(cache.data.solved) && cache.data.solved.length > 0) {
            // The HTML pages are blocked, but a previous successful pass is
            // still more complete than the public API (it may contain groups).
            scraped = cache.data.solved;
            scrapeMeta = Object.assign({}, cache.data.meta || {}, {
              fromCache: true,
              stale: true,
              fetchedAt: cache.fetchedAt || Date.now(),
              stopReason: 'stale-cache',
            });
          }
        }
      }

      if (!isCurrentLoad(seq, requestedHandle)) return;
      const progress = byRole('progress-text');
      if (progress) progress.textContent = 'Загружаю архивы и считаю статистику…';

      const message = {
        type: CFS_CONST.MSG.GET_STATS,
        handle: requestedHandle,
        force: !!force,
      };
      if (scraped !== null) {
        message.scraped = scraped;
        message.scrapeMeta = scrapeMeta;
      }

      const response = await sendMessage(message, MESSAGE_TIMEOUT_MS);

      if (!isCurrentLoad(seq, requestedHandle)) return;
      if (!response) throw makeError('NO_RESPONSE', 'Empty response from background');
      if (!response.ok) {
        const details = response.error || {};
        throw makeError(details.code || 'UNKNOWN', details.message || 'Background error', {
          retryAfterMs: details.retryAfterMs || 0,
          httpStatus: details.httpStatus || 0,
        });
      }
      state.stats = response.data;
      finishLoading();
      renderStats();
    } catch (error) {
      if (error && error.code === 'CANCELLED') return;
      if (!isCurrentLoad(seq, requestedHandle)) return;
      finishLoading();
      showError(error);
    }
  }

  function openSettings() {
    sendMessage({ type: CFS_CONST.MSG.OPEN_OPTIONS }, 5000).catch(function () {
      // The options page may still be openable from the toolbar menu.
    });
  }

  function toggleCollapsed() {
    if (!state.host) return;
    const collapsed = !state.host.classList.contains('is-collapsed');
    state.host.classList.toggle('is-collapsed', collapsed);
    const button = state.host.querySelector('.cfs-collapse');
    if (button) {
      button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      button.setAttribute('aria-label', collapsed ? 'Развернуть статистику' : 'Свернуть статистику');
    }
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch (error) {
      // localStorage can be unavailable in hardened browser modes.
    }
    if (!collapsed) {
      requestAnimationFrame(function () {
        if (state.ratingChart) state.ratingChart.resize();
        if (state.tagsChart) state.tagsChart.resize();
      });
    }
  }

  function restoreCollapsed() {
    if (!state.host) return;
    let collapsed = false;
    try {
      collapsed = localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch (error) {
      collapsed = false;
    }
    if (!collapsed) return;
    state.host.classList.add('is-collapsed');
    const button = state.host.querySelector('.cfs-collapse');
    if (button) {
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-label', 'Развернуть статистику');
    }
  }

  function bindEvents() {
    if (!state.host) return;
    const refresh = state.host.querySelector('.cfs-refresh');
    if (refresh) refresh.addEventListener('click', function () { load(true); });
    const settings = state.host.querySelector('.cfs-settings');
    if (settings) settings.addEventListener('click', openSettings);
    const collapse = state.host.querySelector('.cfs-collapse');
    if (collapse) collapse.addEventListener('click', toggleCollapsed);
    const retry = byRole('retry');
    if (retry) retry.addEventListener('click', function () { load(true); });
    state.host.querySelectorAll('.cfs-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        const source = tab.getAttribute('data-source');
        if (!source || source === state.activeTab) return;
        state.activeTab = source;
        state.selectedTag = -1;
        renderRatingSection();
      });
    });
  }

  function updateProgress(message) {
    if (!state.host || !state.loading || !message) return;
    if (message.handle && state.handle &&
        String(message.handle).toLowerCase() !== state.handle.toLowerCase()) return;
    const text = byRole('progress-text');
    if (text && message.message) text.textContent = message.message;
  }

  function removePanel() {
    state.loadSeq += 1;
    document.querySelectorAll('.cfs-profile-userbox').forEach(function (node) {
      node.classList.remove('cfs-profile-userbox');
    });
    if (state.ratingChart) {
      state.ratingChart.destroy();
      state.ratingChart = null;
    }
    if (state.tagsChart) {
      state.tagsChart.destroy();
      state.tagsChart = null;
    }
    const existing = document.getElementById(HOST_ID);
    if (existing) existing.remove();
    state.host = null;
    state.handle = null;
    state.stats = null;
    state.loading = false;
    state.selectedTag = -1;
    state.tagItems = [];
    state.tagColors = [];
    state.activeTab = 'cf';
  }

  async function init() {
    const token = ++state.initToken;
    const handle = parseProfileHandle();
    if (!handle) {
      removePanel();
      return;
    }
    const existing = document.getElementById(HOST_ID);
    if (
      existing &&
      state.host === existing &&
      state.handle &&
      state.handle.toLowerCase() === handle.toLowerCase()
    ) {
      return;
    }

    removePanel();
    const anchor = await waitForAnchor(12000);
    if (token !== state.initToken) return;
    if (!anchor) {
      console.warn('[CF Stats+] Could not find the Codeforces profile anchor.');
      return;
    }
    const currentHandle = parseProfileHandle();
    if (!currentHandle || currentHandle.toLowerCase() !== handle.toLowerCase()) return;

    const insertion = resolveInsertionPoint(anchor);
    const pageContent = document.getElementById('pageContent');
    const profileUserbox = anchor.userbox ||
      (pageContent && pageContent.querySelector('.userbox')) ||
      document.querySelector('.userbox');
    if (profileUserbox) profileUserbox.classList.add('cfs-profile-userbox');
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.dataset.handle = handle;
    // Parse the static template without innerHTML; no dynamic data is ever
    // interpolated here. Problem names and handles are inserted as text nodes.
    const templateDocument = new DOMParser().parseFromString(TEMPLATE, 'text/html');
    while (templateDocument.body.firstChild) {
      host.appendChild(templateDocument.body.firstChild);
    }
    if (insertion.mode === 'after' && insertion.node.parentNode) {
      insertion.node.insertAdjacentElement('afterend', host);
    } else {
      insertion.node.prepend(host);
    }

    state.host = host;
    state.handle = handle;
    state.stats = null;
    state.activeTab = 'cf';
    state.selectedTag = -1;
    applyTheme();
    restoreCollapsed();
    bindEvents();

    const subtitle = byRole('subtitle');
    if (subtitle) subtitle.textContent = 'Статистика @' + handle + ' по архивам Codeforces и AtCoder';
    setText('version', 'v' + CFS_CONST.VERSION);
    const cache = byRole('cache-status');
    if (cache) cache.textContent = 'загрузка…';

    load(false);
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (message) {
      if (message && message.type === CFS_CONST.MSG.PROGRESS) {
        updateProgress(message);
      }
    });
  }

  let chartResizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(chartResizeTimer);
    chartResizeTimer = setTimeout(function () {
      if (state.ratingChart) state.ratingChart.resize();
      if (state.tagsChart) state.tagsChart.resize();
    }, 160);
  });

  let lastUrlKey = location.pathname + location.search;
  setInterval(function () {
    const key = location.pathname + location.search;
    if (key === lastUrlKey) return;
    lastUrlKey = key;
    state.initToken += 1;
    removePanel();
    init();
  }, 900);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
