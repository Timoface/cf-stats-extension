/**
 * Safe parser for Codeforces submission HTML pages.
 *
 * Used by the content script because the public API does not expose
 * submissions made inside private groups. The parser never throws on a 404,
 * login page or Cloudflare challenge: it simply reports zero rows / a stop
 * reason and leaves the already collected data intact.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./normalize.js'), require('./constants.js'));
  } else {
    root.CFS_SCRAPE = factory(root.CFS_NORMALIZE, root.CFS_CONST);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (NORMALIZE, CONST) {
  'use strict';

  const ACCEPTED_VERDICTS = new Set([
    'accepted',
    'полное решение',
    'принято',
    'ok',
  ]);

  function cleanWhitespace(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function isAcceptedVerdict(value) {
    return ACCEPTED_VERDICTS.has(cleanWhitespace(value).toLowerCase());
  }

  function cleanProblemName(value) {
    return cleanWhitespace(NORMALIZE.stripIndexPrefix(cleanWhitespace(value)));
  }

  function parseProblemHref(href, baseUrl) {
    if (!href) return { contestId: null, index: '', url: null };
    let url;
    try {
      url = new URL(String(href), baseUrl || 'https://codeforces.com');
    } catch (error) {
      return { contestId: null, index: '', url: null, group: false };
    }
    // A private-group contest id is NOT an official Codeforces contest id.
    // Exposing it as contestId would let the matcher hit an unrelated official
    // problem with the same numeric id. Keep only the problem index and match
    // group tasks by title.
    if (/^\/group\//i.test(url.pathname)) {
      const groupContest = /\/group\/[^/]+\/contest\/[^/]+\/problem\/([^/?#]+)/i.exec(url.pathname);
      const groupProblem = /\/group\/[^/]+\/problem\/([^/?#]+)/i.exec(url.pathname);
      return {
        contestId: null,
        index: groupContest ? decodeURIComponent(groupContest[1])
          : (groupProblem ? decodeURIComponent(groupProblem[1]) : ''),
        url: url.href,
        group: true,
      };
    }
    const patterns = [
      /\/contest\/(\d+)\/problem\/([^/?#]+)/i,
      /\/gym\/(\d+)\/problem\/([^/?#]+)/i,
      /\/problemset\/problem\/(\d+)\/([^/?#]+)/i,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(url.pathname);
      if (match) {
        return {
          contestId: Number(match[1]),
          index: decodeURIComponent(match[2]),
          url: url.href,
          group: false,
        };
      }
    }
    return { contestId: null, index: '', url: url.href, group: false };
  }

  /**
   * @param {Document} doc parsed submissions page
   * @param {string} baseUrl page URL (for resolving relative hrefs)
   * @returns {{rows:number, solved:Array, accepted:number, hasTable:boolean}}
   */
  function parseSubmissionsDocument(doc, baseUrl) {
    if (!doc) return { rows: 0, solved: [], accepted: 0, hasTable: false };
    const table = doc.querySelector('table.status-frame-datatable');
    if (!table) return { rows: 0, solved: [], accepted: 0, hasTable: false };

    let rows = Array.from(table.querySelectorAll('tr[data-submission-id]'));
    if (!rows.length) {
      rows = Array.from(table.querySelectorAll('tr')).filter(function (row) {
        return row.querySelector('.status-verdict-cell');
      });
    }

    const solved = new Map();
    let accepted = 0;
    for (const row of rows) {
      const verdictCell = row.querySelector('.status-verdict-cell') ||
        row.querySelector('td:nth-child(6)');
      const verdict = verdictCell ? cleanWhitespace(verdictCell.textContent) : '';
      if (!isAcceptedVerdict(verdict)) continue;

      let link = row.querySelector('td:nth-child(4) a');
      if (!link) {
        link = Array.from(row.querySelectorAll('a[href]')).find(function (anchor) {
          return /\/problem\//i.test(anchor.getAttribute('href') || '');
        });
      }
      if (!link) continue;

      const name = cleanProblemName(link.textContent);
      if (!name) continue;
      const meta = parseProblemHref(link.getAttribute('href'), baseUrl || doc.baseURI);
      accepted += 1;
      const key = meta.group
        ? 'group:' + (meta.url || NORMALIZE.normalizeTitle(name))
        : (meta.contestId != null && meta.index
          ? 'id:' + meta.contestId + ':' + meta.index
          : 'name:' + NORMALIZE.normalizeTitle(name));
      if (!solved.has(key)) {
        solved.set(key, {
          name,
          contestId: meta.contestId,
          index: meta.index,
          url: meta.url,
          group: !!meta.group,
        });
      }
    }

    return {
      rows: rows.length,
      solved: Array.from(solved.values()),
      accepted,
      hasTable: true,
    };
  }

  function parseSubmissionsHtml(html, baseUrl) {
    if (!html || typeof DOMParser === 'undefined') {
      return { rows: 0, solved: [], accepted: 0, hasTable: false };
    }
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    return parseSubmissionsDocument(doc, baseUrl);
  }

  function looksLikeChallenge(html) {
    const text = cleanWhitespace(html).slice(0, 20000).toLowerCase();
    return /just a moment|cf-chl|attention required|выполнение проверки безопасности|security verification|checking your browser/.test(text);
  }

  function pageUrl(origin, handle, page) {
    return String(origin || 'https://codeforces.com') +
      '/submissions/' + encodeURIComponent(handle) + '/page/' + page;
  }

  return {
    ACCEPTED_VERDICTS,
    SCRAPE_PAGE_SIZE: CONST.SCRAPE_PAGE_SIZE,
    cleanWhitespace,
    isAcceptedVerdict,
    cleanProblemName,
    parseProblemHref,
    parseSubmissionsDocument,
    parseSubmissionsHtml,
    looksLikeChallenge,
    pageUrl,
  };
});
