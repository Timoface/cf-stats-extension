import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import {
  launchBrowser,
  startStaticServer,
  openPage,
  waitForCondition,
  evaluate,
  screenshot,
  sleep,
} from './lib/browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(root, 'docs');
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

async function freezeCharts(page) {
  await evaluate(page, `(() => {
    const canvases = document.querySelectorAll('#cf-stats-plus canvas');
    for (const canvas of canvases) {
      const chart = window.Chart && Chart.getChart(canvas);
      if (chart) {
        chart.options.animation = false;
        chart.stop();
        chart.update('none');
      }
    }
    return true;
  })()`);
  await sleep(250);
}

async function main() {
  const server = await startStaticServer(root);
  const browser = await launchBrowser({ width: 1280, height: 1700 });
  let page;
  try {
    const opened = await openPage(browser, server.url + '/profile/demo_user', {
      viewport: { width: 1280, height: 1700 },
    });
    page = opened.page;
    await waitForCondition(page, 'document.documentElement.getAttribute("data-test-ready") === "1"', 20000);
    await sleep(700);

    let snapshot = await evaluate(page, 'window.__cfsTest.snapshot()');
    console.log('\nDesktop snapshot:');
    console.log(JSON.stringify({
      state: snapshot.state,
      handle: snapshot.handle,
      width: snapshot.width,
      height: snapshot.height,
      ratingChart: snapshot.ratingChart,
      tagsChart: snapshot.tagsChart,
      ratingLabels: snapshot.ratingLabels,
      tagSegments: snapshot.tagSegments,
      legendItems: snapshot.legendItems,
      recentItems: snapshot.recentItems,
      errors: snapshot.errors,
    }, null, 2));

    check('panel is injected after the Codeforces userbox', snapshot.panel === true);
    check('panel is inside #pageContent immediately after .userbox', await evaluate(page,
      `(() => {
        const panel = document.getElementById('cf-stats-plus');
        const pageContent = document.getElementById('pageContent');
        const previous = panel.previousElementSibling;
        return !!pageContent && pageContent.contains(panel) &&
          !!previous && previous.classList.contains('userbox');
      })()`));
    check('panel reaches ready state', snapshot.state === 'ready', snapshot.state);
    check('stats body is visible', snapshot.bodyVisible === true);
    check('both Chart.js charts are instantiated', snapshot.ratingChart && snapshot.tagsChart);
    check('CF histogram has 23 buckets', snapshot.ratingLabels === 23, String(snapshot.ratingLabels));
    check('tag donut has top 12 + other', snapshot.tagSegments === 13, String(snapshot.tagSegments));
    check('tag legend is rendered', snapshot.legendItems === 13, String(snapshot.legendItems));
    check('recent training list has 5 items', snapshot.recentItems === 5, String(snapshot.recentItems));
    check('no warning banner for clean data', snapshot.warnings === 0, String(snapshot.warnings));
    check('no page JS errors', snapshot.errors.length === 0, snapshot.errors.join(' | '));
    check('panel is wide on desktop', snapshot.width > 900, String(snapshot.width));
    check('panel is tall enough to contain charts', snapshot.height > 700, String(snapshot.height));
    const gap = await evaluate(page, `(() => {
      const userbox = document.querySelector('.userbox');
      const panel = document.getElementById('cf-stats-plus');
      return {
        gap: Math.round(panel.getBoundingClientRect().top - userbox.getBoundingClientRect().bottom),
        userboxHeight: Math.round(userbox.getBoundingClientRect().height)
      };
    })()`);
    check('no empty native userbox min-height gap before the panel',
      gap.gap >= 0 && gap.gap < 100 && gap.userboxHeight < 300, JSON.stringify(gap));

    await freezeCharts(page);
    const shot = await screenshot(page, path.join(docs, 'screenshot-desktop.png'));
    console.log('  screenshot:', shot.file, shot.width + 'x' + shot.height, shot.bytes + ' bytes');

    await evaluate(page, `window.__cfsStubMode = 'error'; document.querySelector('.cfs-refresh').click()`);
    await sleep(700);
    const errorState = await evaluate(page, `(() => {
      const panel = document.getElementById('cf-stats-plus');
      return {
        errorVisible: !panel.querySelector('[data-role="error"]').hidden,
        errorText: panel.querySelector('[data-role="error-text"]').textContent,
        bodyVisible: !panel.querySelector('[data-role="body"]').hidden,
        cacheStatus: panel.querySelector('[data-role="cache-status"]').textContent
      };
    })()`);
    check('rate-limit error is shown', errorState.errorVisible === true, JSON.stringify(errorState));
    check('rate-limit message includes retry time', /2 мин/.test(errorState.errorText), errorState.errorText);
    check('old stats stay visible on refresh error', errorState.bodyVisible === true, JSON.stringify(errorState));
    check('cache status reports the error', /ошибка/i.test(errorState.cacheStatus), errorState.cacheStatus);

    await evaluate(page, `window.__cfsStubMode = 'normal'; document.querySelector('[data-role="retry"]').click()`);
    await sleep(800);
    const recovered = await evaluate(page, 'window.__cfsTest.snapshot()');
    const errorStillVisible = await evaluate(page,
      '!document.querySelector("#cf-stats-plus [data-role=error]").hidden');
    check('retry recovers the panel', recovered.state === 'ready' && errorStillVisible === false,
      JSON.stringify({ state: recovered.state, errorStillVisible }));

    await evaluate(page, 'window.__cfsTest.switchAtCoder()');
    await sleep(750);
    snapshot = await evaluate(page, 'window.__cfsTest.snapshot()');
    check('AtCoder tab switches the histogram', snapshot.activeTab.includes('AtCoder'), snapshot.activeTab);
    check('AtCoder histogram has 9 buckets', snapshot.ratingLabels === 9, String(snapshot.ratingLabels));
    await freezeCharts(page);
    const atcoderShot = await screenshot(page, path.join(docs, 'screenshot-atcoder.png'));
    console.log('  screenshot:', atcoderShot.file, atcoderShot.width + 'x' + atcoderShot.height);

    await evaluate(page, 'window.__cfsTest.switchCodeforces()');
    await sleep(400);
    await evaluate(page, 'window.__cfsTest.clickTag(0)');
    await sleep(400);
    const tagState = await evaluate(page, `(function () {
      var panel = document.getElementById('cf-stats-plus');
      var selected = panel.querySelector('.cfs-legend-item.is-selected');
      return {
        selected: !!selected,
        selectedText: selected ? selected.innerText.replace(/\\s+/g, ' ').trim() : '',
        centerLabel: panel.querySelector('[data-role="tags-center-label"]').textContent,
        dimmed: panel.querySelectorAll('.cfs-legend-item.is-dimmed').length
      };
    })()`);
    check('tag legend selection is interactive', tagState.selected === true, JSON.stringify(tagState));
    check('tag selection updates the donut center', tagState.centerLabel !== 'задач с тегами', tagState.centerLabel);
    check('non-selected tags are dimmed', tagState.dimmed > 0, String(tagState.dimmed));
    await evaluate(page, 'window.__cfsTest.clickTag(0)');
    await sleep(250);

    await evaluate(page, `document.querySelector('.cfs-collapse').click()`);
    await sleep(200);
    const collapsed = await evaluate(page, `(() => {
      const panel = document.getElementById('cf-stats-plus');
      return {
        class: panel.classList.contains('is-collapsed'),
        bodyDisplay: getComputedStyle(panel.querySelector('[data-role="body"]')).display,
        expanded: panel.querySelector('.cfs-collapse').getAttribute('aria-expanded')
      };
    })()`);
    check('collapse hides the body', collapsed.class === true && collapsed.bodyDisplay === 'none', JSON.stringify(collapsed));
    check('collapse updates aria-expanded', collapsed.expanded === 'false', collapsed.expanded);
    await evaluate(page, `document.querySelector('.cfs-collapse').click()`);
    await sleep(300);

    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 420,
      height: 1500,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(800);
    const mobile = await evaluate(page, `(() => {
      const panel = document.getElementById('cf-stats-plus');
      const rect = panel.getBoundingClientRect();
      const summary = getComputedStyle(panel.querySelector('.cfs-summary')).gridTemplateColumns;
      const canvas = panel.querySelector('[data-role="rating-canvas"]');
      const chart = window.Chart && Chart.getChart(canvas);
      return {
        width: Math.round(rect.width),
        viewport: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        summaryColumns: summary,
        atcoderTabVisible: !panel.querySelector('.cfs-tab[data-source="atcoder"]').hidden,
        canvasWidth: canvas.clientWidth,
        canvasHeight: canvas.clientHeight,
        chartWidth: chart ? chart.width : 0,
        chartHeight: chart ? chart.height : 0,
        lastBar: chart ? chart.data.datasets[0].data[chart.data.datasets[0].data.length - 1] : null
      };
    })()`);
    console.log('  mobile:', JSON.stringify(mobile));
    check('panel fits a 420px viewport', mobile.width <= 420 && mobile.scrollWidth <= mobile.viewport + 1,
      JSON.stringify(mobile));
    check('mobile summary uses two columns', mobile.summaryColumns.split(' ').length === 2,
      mobile.summaryColumns);
    check('rating chart resizes to the mobile card', mobile.canvasWidth > 250 && mobile.chartWidth > 250,
      JSON.stringify(mobile));
    await freezeCharts(page);
    const mobileShot = await screenshot(page, path.join(docs, 'screenshot-mobile.png'));
    console.log('  screenshot:', mobileShot.file, mobileShot.width + 'x' + mobileShot.height);

    page.close();
    page = null;

    const mobileOpened = await openPage(browser, server.url + '/profile/demo_user', {
      viewport: { width: 420, height: 1600 },
    });
    page = mobileOpened.page;
    await waitForCondition(page, 'document.documentElement.getAttribute("data-test-ready") === "1"', 20000);
    await sleep(800);
    const initialMobile = await evaluate(page, `(() => {
      const panel = document.getElementById('cf-stats-plus');
      const rect = panel.getBoundingClientRect();
      const canvas = panel.querySelector('[data-role="rating-canvas"]');
      const chart = window.Chart && Chart.getChart(canvas);
      return {
        width: Math.round(rect.width),
        viewport: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        summaryColumns: getComputedStyle(panel.querySelector('.cfs-summary')).gridTemplateColumns,
        canvasWidth: canvas.clientWidth,
        chartWidth: chart ? chart.width : 0,
        barsWithData: chart ? chart.data.datasets[0].data.filter((value) => value > 0).length : 0,
        errors: window.__errors.slice()
      };
    })()`);
    console.log('  initial mobile:', JSON.stringify(initialMobile));
    check('initial mobile load has a usable chart', initialMobile.canvasWidth > 250 &&
      initialMobile.chartWidth > 250 && initialMobile.barsWithData > 3, JSON.stringify(initialMobile));
    check('initial mobile page has no horizontal overflow', initialMobile.scrollWidth <= initialMobile.viewport + 1,
      JSON.stringify(initialMobile));

    if (opened.errors.length) {
      const relevant = opened.errors.filter((text) => !/favicon/i.test(text));
      check('no console errors during the run', relevant.length === 0, relevant.join(' | '));
    } else {
      check('no console errors during the run', true);
    }
  } finally {
    if (page) page.close();
    await browser.close();
    await server.close();
  }

  console.log('\nUI harness: ' + passed + ' checks passed, ' + failures.length + ' failed.');
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
