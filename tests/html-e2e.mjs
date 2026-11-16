import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  launchBrowser,
  openPage,
  waitForCondition,
  evaluate,
  sleep,
} from './lib/browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distChrome = path.join(root, 'dist', 'chrome');
const handle = 'test_user';
const requestedPages = [];
let passed = 0;
const failures = [];

function check(name, condition, details) {
  if (condition) {
    passed += 1;
    console.log('  ok  ' + name);
  } else {
    failures.push(name);
    console.error('  FAIL ' + name + (details ? '\n       ' + details : ''));
  }
}

function row(id, href, label, verdict) {
  return `<tr data-submission-id="${id}">
    <td>${id}</td><td>01.01.2026</td><td><a href="/profile/${handle}">${handle}</a></td>
    <td><a href="${href}">${label}</a></td><td>C++23</td>
    <td class="status-verdict-cell">${verdict}</td><td>15 ms</td><td>256 KB</td>
  </tr>`;
}

function submissionsPage(rows) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Submissions</title></head><body>
    <table class="status-frame-datatable">
      <thead><tr><th>#</th><th>When</th><th>Who</th><th>Problem</th><th>Lang</th><th>Verdict</th><th>Time</th><th>Memory</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
  </body></html>`;
}

const PAGE_ONE = submissionsPage([
  row(1, '/contest/4/problem/A', 'A - Watermelon', 'Accepted'),
  row(2, '/contest/4/problem/A', 'A. Watermelon', 'Полное решение'),
  row(3, '/group/abc/contest/999999/problem/C', 'C - Внешняя задача', 'Полное решение'),
  row(4, '/contest/1/problem/A', 'A. Theatre Square', 'Wrong answer'),
  row(5, '/group/abc/contest/999999/problem/E', 'E - Rejected', 'Неправильный ответ'),
]);

const PAGE_TWO = submissionsPage([
  row(6, '/contest/1/problem/A', 'A. Theatre Square', 'Полное решение'),
  row(7, '/group/abc/contest/999998/problem/D', 'D - Ещё задача', 'Accepted'),
  row(8, '/group/abc/contest/999998/problem/D', 'D - Ещё задача', 'Accepted'),
]);

const PARTIAL_PAGE_ONE = submissionsPage([
  row(9, '/contest/4/problem/A', 'A. Watermelon', 'Accepted'),
]);

function startServer() {
  const profileHtml = fs.readFileSync(path.join(root, 'tests', 'e2e', 'profile.html'), 'utf8');
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/profile/')) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(profileHtml);
      return;
    }
    const match = /^\/submissions\/([^/]+)\/page\/(\d+)$/.exec(url.pathname);
    if (match) {
      const requestedHandle = decodeURIComponent(match[1]);
      const pageNumber = Number(match[2]);
      if (requestedHandle === 'partial_user') {
        requestedPages.push('partial-' + pageNumber);
        if (pageNumber === 1) {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          response.end(PARTIAL_PAGE_ONE);
          return;
        }
        response.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<h1>403 Forbidden</h1>');
        return;
      }
      requestedPages.push(pageNumber);
      if (pageNumber === 1) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(PAGE_ONE);
        return;
      }
      if (pageNumber === 2) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(PAGE_TWO);
        return;
      }
      response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<h1>404 Not Found</h1>');
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        url: 'http://127.0.0.1:' + address.port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function panelSnapshot(page) {
  return evaluate(page, `(() => {
    const panel = document.getElementById('cf-stats-plus');
    const text = (role) => {
      const node = panel.querySelector('[data-role="' + role + '"]');
      return node ? node.textContent.trim() : '';
    };
    const num = (role) => Number(text(role).replace(/[^\\d]/g, '')) || 0;
    return {
      state: panel.dataset.state,
      total: num('stat-total'),
      cf: num('stat-cf'),
      atcoder: num('stat-atcoder'),
      training: num('stat-training'),
      trainingSub: text('stat-training-sub'),
      unmatched: text('unmatched-count'),
      warnings: Array.from(panel.querySelectorAll('.cfs-warning')).map((n) => n.textContent.trim()),
      cacheStatus: text('cache-status'),
      legend: panel.querySelectorAll('.cfs-legend-item').length,
      bodyVisible: !panel.querySelector('[data-role="body"]').hidden
    };
  })()`);
}

async function main() {
  if (!fs.existsSync(path.join(distChrome, 'manifest.json'))) {
    throw new Error('dist/chrome is missing. Run "npm run build" first.');
  }

  const tempRoot = path.join(root, 'tests', '.tmp');
  const extDir = path.join(tempRoot, 'html-e2e-' + Date.now());
  fs.mkdirSync(tempRoot, { recursive: true });
  fs.cpSync(distChrome, extDir, { recursive: true });
  const manifestPath = path.join(extDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.content_scripts[0].matches = ['http://127.0.0.1/*', 'http://localhost/*'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const server = await startServer();
  const browser = await launchBrowser({ width: 1280, height: 1700, extensionPath: extDir });
  let page = null;
  try {
    const opened = await openPage(browser, server.url + '/profile/' + handle, {
      viewport: { width: 1280, height: 1700 },
    });
    page = opened.page;
    await waitForCondition(page,
      'document.documentElement.dataset.cfsState === "ready" || document.documentElement.dataset.cfsState === "error"',
      180000, 250);

    const first = await panelSnapshot(page);
    console.log('\nHTML scrape snapshot:', JSON.stringify(first, null, 2));
    console.log('  requested pages:', requestedPages.join(', '));

    check('panel renders from HTML submissions', first.state === 'ready', first.state);
    check('Accepted and Полное решение are both counted', first.total === 4, String(first.total));
    check('two problems matched to the CF archive', first.cf === 2, String(first.cf));
    check('two private/group problems are kept as training', first.training === 2, String(first.training));
    check('two group problems stay outside the archive', first.unmatched === '2', first.unmatched);
    check('404 ends pagination without a fatal warning', first.warnings.length === 0,
      JSON.stringify(first.warnings));
    check('page 1, page 2 and the terminating 404 were requested',
      requestedPages.join(',') === '1,2,3', requestedPages.join(','));
    check('cache badge shows HTML source', /HTML/i.test(first.cacheStatus), first.cacheStatus);
    check('UI body is visible', first.bodyVisible === true);

    await sleep(500);
    page.close();
    page = null;

    // Second load: the HTML cache should avoid all submission-page requests.
    const secondOpened = await openPage(browser, server.url + '/profile/' + handle, {
      viewport: { width: 1280, height: 1700 },
    });
    page = secondOpened.page;
    await waitForCondition(page,
      'document.documentElement.dataset.cfsState === "ready" || document.documentElement.dataset.cfsState === "error"',
      60000, 200);
    const second = await panelSnapshot(page);
    console.log('  second snapshot:', JSON.stringify(second, null, 2));
    console.log('  requested pages after reload:', requestedPages.join(', '));
    check('second load uses the HTML cache', requestedPages.join(',') === '1,2,3',
      requestedPages.join(','));
    check('second load shows the HTML cache badge', /HTML-кэш/i.test(second.cacheStatus),
      second.cacheStatus);
    check('second load keeps the same totals', second.total === first.total &&
      second.cf === first.cf && second.training === first.training,
      JSON.stringify({ first, second }));

    page.close();
    page = null;
    const partialOpened = await openPage(browser, server.url + '/profile/partial_user', {
      viewport: { width: 1280, height: 1700 },
    });
    page = partialOpened.page;
    await waitForCondition(page,
      'document.documentElement.dataset.cfsState === "ready" || document.documentElement.dataset.cfsState === "error"',
      60000, 200);
    const partial = await panelSnapshot(page);
    console.log('  partial snapshot:', JSON.stringify(partial, null, 2));
    check('403 does not crash the widget and keeps partial data',
      partial.state === 'ready' && partial.total === 1, JSON.stringify(partial));
    check('403 produces a non-fatal partial warning',
      partial.warnings.some((warning) => /остановился|неполными/i.test(warning)),
      JSON.stringify(partial.warnings));
    check('403 is followed by no further submission page requests',
      requestedPages.includes('partial-1') && requestedPages.includes('partial-2'),
      requestedPages.join(','));

    const relevantErrors = opened.errors.filter((text) => !/40[34]|favicon/i.test(text));
    check('no page JS errors during HTML scraping', relevantErrors.length === 0,
      relevantErrors.join(' | '));
  } finally {
    if (page) page.close();
    await browser.close();
    await server.close();
    try { fs.rmSync(extDir, { recursive: true, force: true }); } catch (error) { /* ignore */ }
  }

  console.log('\nHTML scrape E2E: ' + passed + ' checks passed, ' + failures.length + ' failed.');
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error('\nHTML scrape E2E failed:', error);
  process.exit(1);
});
