/**
 * Optional Firefox E2E smoke test.
 *
 * Uses web-ext (via npx) to install a temporary copy of dist/firefox in a
 * headless Firefox, opens a local profile page, and waits for the page to POST
 * the rendered panel snapshot back to the test server. This verifies the
 * Firefox MV3 background.scripts path, content script, network permissions and
 * the shared UI without WebDriver.
 *
 * Run: npm run test:firefox
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sleep, startStaticServer } from './lib/browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distFirefox = path.join(root, 'dist', 'firefox');
const firefoxPath = process.env.CFS_FIREFOX_PATH ||
  'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const handle = process.env.CFS_E2E_HANDLE || 'tourist';
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

function killTree(processHandle) {
  if (!processHandle || processHandle.killed) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(processHandle.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      processHandle.kill('SIGTERM');
    }
  } catch (error) {
    try { processHandle.kill(); } catch (killError) { /* ignore */ }
  }
}

async function main() {
  if (!fs.existsSync(path.join(distFirefox, 'manifest.json'))) {
    throw new Error('dist/firefox is missing. Run "npm run build" first.');
  }
  if (!fs.existsSync(firefoxPath)) {
    throw new Error('Firefox was not found. Set CFS_FIREFOX_PATH. Tried: ' + firefoxPath);
  }

  const tempRoot = path.join(root, 'tests', '.tmp');
  const extDir = path.join(tempRoot, 'firefox-e2e-' + Date.now());
  fs.mkdirSync(tempRoot, { recursive: true });
  fs.cpSync(distFirefox, extDir, { recursive: true });
  const manifestPath = path.join(extDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.content_scripts[0].matches = ['http://127.0.0.1/*', 'http://localhost/*'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  let reportResolve;
  let reportReject;
  const reportPromise = new Promise((resolve, reject) => {
    reportResolve = resolve;
    reportReject = reject;
  });
  const timeout = setTimeout(() => {
    reportReject(new Error('Firefox did not report a rendered panel within 150 seconds'));
  }, 150000);

  const server = await startStaticServer(root, {
    profilePath: '/tests/e2e/profile.html',
    reportPath: '/report',
    onReport: (payload) => {
      clearTimeout(timeout);
      reportResolve(payload);
    },
  });

  const url = server.url + '/profile/' + handle + '?report=1';
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const args = [
    '--yes', 'web-ext', 'run',
    '--source-dir', extDir,
    '--firefox', process.platform === 'win32' ? '"' + firefoxPath + '"' : firefoxPath,
    '--start-url', url,
    '--no-reload',
    '--pref', 'browser.shell.checkDefaultBrowser=false',
    '--pref', 'browser.startup.homepage_override.mstone=ignore',
  ];
  console.log('Launching headless Firefox via web-ext…');
  console.log('  URL:', url);
  const runner = spawn(npx, args, {
    cwd: root,
    env: Object.assign({}, process.env, {
      MOZ_HEADLESS: '1',
      MOZ_DISABLE_CONTENT_SANDBOX: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  let output = '';
  let earlyExitTimer = null;
  runner.stdout.on('data', (chunk) => { output += chunk.toString(); });
  runner.stderr.on('data', (chunk) => { output += chunk.toString(); });
  runner.on('error', (error) => {
    output += '\nspawn error: ' + error.message;
  });

  const earlyExit = new Promise((resolve, reject) => {
    earlyExitTimer = setTimeout(() => reject(new Error('Firefox report timeout')), 155000);
    runner.on('exit', (code) => {
      reject(new Error('web-ext exited early with code ' + code + '\n' + output.slice(-4000)));
    });
  });
  earlyExit.catch(function () { /* handled by the race / finally */ });

  try {
    const snapshot = await Promise.race([reportPromise, earlyExit]);
    clearTimeout(earlyExitTimer);
    console.log('\nFirefox snapshot:');
    console.log(JSON.stringify({
      state: snapshot.state,
      total: snapshot.total,
      cf: snapshot.cf,
      atcoder: snapshot.atcoder,
      training: snapshot.training,
      warnings: snapshot.warnings,
      warningText: snapshot.warningText,
      errorText: snapshot.errorText,
      panelWidth: snapshot.panelWidth,
      cacheStatus: snapshot.cacheStatus,
      pageErrors: snapshot.pageErrors,
    }, null, 2));
    check('Firefox loads the MV3 background and content script', snapshot.state === 'ready', snapshot.state);
    check('Firefox aggregates real submissions', snapshot.total > 100, String(snapshot.total));
    check('Firefox matches the CF archive', snapshot.cf > 0, String(snapshot.cf));
    check('Firefox panel is rendered', snapshot.panelWidth > 800, String(snapshot.panelWidth));
    check('Firefox rating chart canvas is rendered', snapshot.ratingCanvas &&
      snapshot.ratingCanvas.width > 300, JSON.stringify(snapshot.ratingCanvas));
    check('Firefox tag donut canvas is rendered', snapshot.tagsCanvas &&
      snapshot.tagsCanvas.width > 100, JSON.stringify(snapshot.tagsCanvas));
    check('Firefox has no page errors', !snapshot.pageErrors || snapshot.pageErrors.length === 0,
      JSON.stringify(snapshot.pageErrors));
    check('Firefox reports no fatal extension error', !snapshot.errorText, snapshot.errorText);
  } finally {
    clearTimeout(earlyExitTimer);
    clearTimeout(timeout);
    killTree(runner);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await server.close();
    try {
      fs.rmSync(extDir, { recursive: true, force: true });
    } catch (error) {
      // under tests/.tmp; safe to leave
    }
  }

  console.log('\nFirefox E2E: ' + passed + ' checks passed, ' + failures.length + ' failed.');
  if (failures.length) {
    console.error('\nweb-ext output (tail):\n' + output.slice(-4000));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('\nFirefox E2E failed:', error);
  process.exit(1);
});
