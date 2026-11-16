import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  launchBrowser,
  startStaticServer,
  openPage,
  waitForCondition,
  evaluate,
  connectTarget,
  screenshot,
  sleep,
} from './lib/browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distChrome = path.join(root, 'dist', 'chrome');
const handle = process.env.CFS_E2E_HANDLE || 'tourist';
let passed = 0;
const failures = [];

function check(name, condition, details) {
  if (condition) {
    passed += 1;
    console.log('  ok  ' + name);
  } else {
    failures.push({ name, details });
    console.error('  FAIL ' + name + (details ? '\n       ' + details : ''));
  }
}

async function listTargets(browser) {
  return fetch('http://127.0.0.1:' + browser.port + '/json/list').then((response) => response.json());
}

async function getExtensionId(browser) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const targets = await listTargets(browser);
    const worker = targets.find((target) =>
      target.type === 'service_worker' && target.url.endsWith('/src/background.js'));
    if (worker) return { id: new URL(worker.url).host, worker, targets };
    await sleep(250);
  }
  throw new Error('Extension service worker target was not found');
}

async function evaluateWorker(browser, expression) {
  const info = await getExtensionId(browser);
  const cdp = await connectTarget(info.worker.webSocketDebuggerUrl);
  try {
    await cdp.send('Runtime.enable');
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Worker evaluation failed');
    }
    return result.result.value;
  } finally {
    cdp.close();
  }
}

async function main() {
  if (!fs.existsSync(path.join(distChrome, 'manifest.json'))) {
    throw new Error('dist/chrome is missing. Run "npm run build" first.');
  }

  const tempRoot = path.join(root, 'tests', '.tmp');
  const extDir = path.join(tempRoot, 'e2e-ext-' + Date.now());
  fs.mkdirSync(tempRoot, { recursive: true });
  fs.cpSync(distChrome, extDir, { recursive: true });
  const manifestPath = path.join(extDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.content_scripts[0].matches = ['http://127.0.0.1/*', 'http://localhost/*'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  const server = await startStaticServer(root, { profilePath: '/tests/e2e/profile.html' });
  const browser = await launchBrowser({ width: 1280, height: 1700, extensionPath: extDir });
  const pageErrors = [];
  let page = null;

  try {
    const opened = await openPage(browser, server.url + '/profile/' + handle, {
      viewport: { width: 1280, height: 1700 },
    });
    page = opened.page;
    pageErrors.push(...opened.errors);

    console.log('Waiting for real Codeforces/AtCoder data for @' + handle + '…');
    await waitForCondition(
      page,
      '(document.documentElement.dataset.cfsState === "ready" || document.documentElement.dataset.cfsState === "error")',
      150000,
      300
    );
    let snapshot = await evaluate(page, 'window.__e2eSnapshot');
    console.log('\nE2E snapshot:');
    console.log(JSON.stringify(snapshot, null, 2));

    check('real extension injects the panel on the test profile', snapshot.state === 'ready', snapshot.state);
    check('no visible error state', snapshot.errorVisible === false, snapshot.errorText);
    check('real submissions are aggregated', snapshot.total > 100, String(snapshot.total));
    check('CF archive matching produced data', snapshot.cf > 0, String(snapshot.cf));
    check('rating histogram canvas has real dimensions', snapshot.ratingCanvas.width > 300 &&
      snapshot.ratingCanvas.height > 100, JSON.stringify(snapshot.ratingCanvas));
    check('tag donut canvas has real dimensions', snapshot.tagsCanvas.width > 100 &&
      snapshot.tagsCanvas.height > 100, JSON.stringify(snapshot.tagsCanvas));
    check('tag legend is populated', snapshot.legend > 0, String(snapshot.legend));
    check('recent training block is rendered', snapshot.recent >= 0, String(snapshot.recent));
    check('panel is wide in the profile', snapshot.panelWidth > 900, String(snapshot.panelWidth));

    const extension = await getExtensionId(browser);
    console.log('  extension id:', extension.id);

    const cacheInfo = JSON.parse(await evaluateWorker(browser,
      'CFS_STORAGE.getCacheInfo().then(function (info) { return JSON.stringify(info); })'));
    console.log('  cache:', JSON.stringify({
      bytes: cacheInfo.bytesInUse,
      cf: cacheInfo.codeforcesArchive && cacheInfo.codeforcesArchive.count,
      atcoder: cacheInfo.atcoderArchive && cacheInfo.atcoderArchive.count,
      statuses: cacheInfo.statuses,
    }));
    check('background cached the CF archive', cacheInfo.codeforcesArchive &&
      cacheInfo.codeforcesArchive.count > 5000, JSON.stringify(cacheInfo.codeforcesArchive));
    check('background cached the user status', cacheInfo.statuses.length > 0,
      JSON.stringify(cacheInfo.statuses));
    check('background cached AtCoder or reported a warning',
      (cacheInfo.atcoderArchive && cacheInfo.atcoderArchive.count > 5000) || snapshot.warnings > 0,
      JSON.stringify({ atcoder: cacheInfo.atcoderArchive, warnings: snapshot.warningText }));

    // Options page: external scripts, local CSP, real cache info, form save.
    const options = await openPage(browser, 'chrome-extension://' + extension.id + '/src/options.html', {
      viewport: { width: 900, height: 1100 },
    });
    pageErrors.push(...options.errors);
    await waitForCondition(options.page,
      'document.getElementById("settings-form") && document.getElementById("cache-bytes").textContent !== "—"',
      10000, 150);
    const optionsInfo = await evaluate(options.page, `(() => ({
      title: document.title,
      version: document.getElementById('version-badge').textContent,
      delay: document.getElementById('minRequestDelayMs').value,
      cfCache: document.getElementById('cache-cf').textContent,
      profiles: document.getElementById('cache-profiles').textContent,
      hasForm: !!document.getElementById('settings-form'),
      htmlScraping: document.getElementById('htmlScraping').checked,
      maxScrapePages: document.getElementById('maxScrapePages').value
    }))()`);
    console.log('  options:', JSON.stringify(optionsInfo));
    check('options page loads with local scripts', optionsInfo.hasForm === true &&
      optionsInfo.version === 'v2.0.1', JSON.stringify(optionsInfo));
    check('options page exposes HTML scraping controls',
      optionsInfo.htmlScraping === true && Number(optionsInfo.maxScrapePages) === 180,
      JSON.stringify(optionsInfo));
    const optionsShot = await screenshot(options.page, path.join(root, 'docs', 'options.png'));
    console.log('  screenshot:', optionsShot.file, optionsShot.width + 'x' + optionsShot.height);
    check('options page sees the cache written by the worker', optionsInfo.cfCache !== 'нет',
      optionsInfo.cfCache);

    const savedDelay = await evaluate(options.page, `(async () => {
      const input = document.getElementById('minRequestDelayMs');
      input.value = '2300';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('save-top').click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const settings = await CFS_SETTINGS.load();
      input.value = '2100';
      document.getElementById('save-top').click();
      return settings.minRequestDelayMs;
    })()`, { awaitPromise: true });
    check('options form saves settings', savedDelay === 2300, String(savedDelay));
    options.page.close();

    // Second load: status should come from the local cache.
    const second = await openPage(browser, server.url + '/profile/' + handle, {
      viewport: { width: 1280, height: 1700 },
    });
    pageErrors.push(...second.errors);
    await waitForCondition(second.page,
      'document.documentElement.dataset.cfsState === "ready" || document.documentElement.dataset.cfsState === "error"',
      60000, 200);
    const cachedSnapshot = await evaluate(second.page, 'window.__e2eSnapshot');
    console.log('  second load cache status:', cachedSnapshot.cacheStatus);
    check('second load reuses the cached stats', cachedSnapshot.state === 'ready' &&
      cachedSnapshot.total === snapshot.total, JSON.stringify({
        first: snapshot.total,
        second: cachedSnapshot.total,
        status: cachedSnapshot.state,
      }));
    check('second load shows cache status', /кэш/i.test(cachedSnapshot.cacheStatus), cachedSnapshot.cacheStatus);
    second.page.close();
    page.close();
    page = null;

    const relevantErrors = pageErrors.filter((text) =>
      !/favicon/i.test(text) &&
      !/Failed to load resource: the server responded with a status of 404/i.test(text));
    check('no extension console errors', relevantErrors.length === 0, relevantErrors.join(' | '));
  } finally {
    if (page) page.close();
    await browser.close();
    await server.close();
    try {
      fs.rmSync(extDir, { recursive: true, force: true });
    } catch (error) {
      // The profile directory may still be locked for a moment; it is under tests/.tmp.
    }
  }

  console.log('\nE2E: ' + passed + ' checks passed, ' + failures.length + ' failed.');
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error('\nE2E failed:', error);
  process.exit(1);
});
