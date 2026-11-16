import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok  ' + name);
  } catch (error) {
    failures.push({ name, error });
    console.error('  FAIL ' + name + '\n       ' + error.message);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}

function exists(file) {
  return fs.existsSync(path.join(root, file)) && fs.statSync(path.join(root, file)).isFile();
}

const chrome = readJson('manifest.json');
const firefox = readJson('manifest.firefox.json');

function collectManifestFiles(manifest) {
  const files = new Set();
  const add = (value) => {
    if (typeof value === 'string') files.add(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(add);
  };
  add(manifest.icons);
  add(manifest.action && manifest.action.default_icon);
  if (manifest.background) {
    add(manifest.background.service_worker);
    add(manifest.background.scripts);
  }
  add(manifest.options_ui && manifest.options_ui.page);
  for (const script of manifest.content_scripts || []) {
    add(script.js);
    add(script.css);
  }
  return [...files];
}

function validateCommon(manifest, label) {
  assert(manifest.manifest_version === 3, label + ': manifest_version must be 3');
  assert(manifest.name && manifest.name.length <= 75, label + ': invalid name');
  assert(manifest.description && manifest.description.length <= 132, label + ': description must be <=132 chars');
  assert(/^\d+\.\d+\.\d+$/.test(manifest.version), label + ': invalid version');
  assert(Array.isArray(manifest.permissions) && manifest.permissions.includes('storage'),
    label + ': storage permission missing');
  assert(Array.isArray(manifest.host_permissions), label + ': host_permissions missing');
  for (const host of ['https://codeforces.com/*', 'https://kenkoooo.com/*']) {
    assert(manifest.host_permissions.includes(host), label + ': host permission missing ' + host);
  }
  assert(manifest.content_security_policy &&
    /script-src 'self'/.test(manifest.content_security_policy.extension_pages),
    label + ': extension CSP must restrict scripts to self');

  const scripts = manifest.content_scripts || [];
  assert(scripts.length === 1, label + ': expected one content script entry');
  const content = scripts[0];
  assert(Array.isArray(content.matches) && content.matches.some((pattern) => pattern.includes('/profile/*')),
    label + ': profile match pattern missing');
  assert(content.js.includes('src/lib/constants.js'), label + ': constants not loaded in content script');
  assert(content.js.includes('src/vendor/chart.umd.min.js'), label + ': bundled Chart.js missing');
  assert(content.js.includes('src/content.js'), label + ': content.js missing');
  assert(content.css.includes('src/content.css'), label + ': content.css missing');
  assert(content.js.indexOf('src/vendor/chart.umd.min.js') < content.js.indexOf('src/content.js'),
    label + ': Chart.js must load before content.js');

  for (const file of collectManifestFiles(manifest)) {
    assert(exists(file), label + ': referenced file does not exist: ' + file);
  }
}

console.log('Manifest validation');
test('Chrome manifest is a valid MV3 extension manifest', () => {
  validateCommon(chrome, 'Chrome');
  assert(chrome.background && chrome.background.service_worker === 'src/background.js',
    'Chrome: service worker path');
  assert(!chrome.background.type, 'Chrome: service worker must stay classic for importScripts');
  assert(!chrome.browser_specific_settings, 'Chrome: browser_specific_settings must not be present');
});

test('Firefox manifest is a valid MV3 extension manifest', () => {
  validateCommon(firefox, 'Firefox');
  assert(firefox.background && Array.isArray(firefox.background.scripts),
    'Firefox: background.scripts is required (no service worker support guarantee)');
  assert(!firefox.background.service_worker, 'Firefox: service_worker must not be set');
  assert(firefox.background.scripts[firefox.background.scripts.length - 1] === 'src/background.js',
    'Firefox: background.js must load last');
  for (const lib of [
    'src/lib/constants.js',
    'src/lib/normalize.js',
    'src/lib/matcher.js',
    'src/lib/stats.js',
    'src/lib/storage.js',
    'src/lib/settings.js',
    'src/lib/api.js',
  ]) {
    assert(firefox.background.scripts.includes(lib), 'Firefox: missing background dependency ' + lib);
  }
  assert(firefox.browser_specific_settings && firefox.browser_specific_settings.gecko &&
    firefox.browser_specific_settings.gecko.id, 'Firefox: gecko id missing');
});

test('Chrome service worker importScripts list matches real files', () => {
  const source = fs.readFileSync(path.join(root, 'src/background.js'), 'utf8');
  const match = /importScripts\(([\s\S]*?)\);/.exec(source);
  assert(match, 'Chrome: importScripts call not found');
  const paths = [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
  assert(paths.length >= 7, 'Chrome: not all libraries imported');
  for (const relative of paths) {
    const file = path.posix.join('src', relative);
    assert(exists(file), 'Chrome: importScripts target missing: ' + file);
  }
  assert(paths[paths.length - 1] === 'lib/api.js', 'Chrome: api.js must be imported last');
});

test('Chart.js is bundled locally and non-empty', () => {
  const file = path.join(root, 'src/vendor/chart.umd.min.js');
  const stat = fs.statSync(file);
  assert(stat.size > 100000, 'Chart.js bundle is too small');
  const source = fs.readFileSync(file, 'utf8');
  assert(/Chart\.js/i.test(source.substring(0, 2000)), 'Chart.js license header not found');
  assert(!/<script\s+src=["']https?:/i.test(source), 'remote script tag found in bundle');
});

test('Options page references only local scripts and has no inline scripts', () => {
  const html = fs.readFileSync(path.join(root, 'src/options.html'), 'utf8');
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert(scriptTags.length >= 4, 'Options: expected four script tags');
  for (const tag of scriptTags) {
    const attrs = tag[1];
    const body = tag[2].trim();
    assert(/src=/.test(attrs), 'Options: inline script found');
    assert(!/src=["']https?:/i.test(attrs), 'Options: remote script found');
    assert(body === '', 'Options: script tag must be empty');
    const src = /src=["']([^"']+)["']/i.exec(attrs)[1];
    assert(exists('src/' + src), 'Options: script missing ' + src);
  }
  assert(!/<script[^>]+type=["']module["']/i.test(html), 'Options: module scripts are not needed');
});

test('Content and options code does not inject remote scripts', () => {
  for (const file of ['src/content.js', 'src/options.js', 'src/background.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert(!/<script\s+src=["']https?:/i.test(source), file + ': remote script injection');
    assert(!/\beval\s*\(/.test(source), file + ': eval() found');
    assert(!/new\s+Function\s*\(/.test(source), file + ': new Function() found');
  }
});

test('Icons exist with the exact dimensions declared in manifests', () => {
  for (const size of [16, 32, 48, 128]) {
    const file = path.join(root, 'icons/icon' + size + '.png');
    const buffer = fs.readFileSync(file);
    assert(buffer.length > 24, 'icon' + size + ': too small');
    assert(buffer.toString('ascii', 1, 4) === 'PNG', 'icon' + size + ': not a PNG');
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    assert(width === size && height === size, 'icon' + size + ': wrong dimensions ' + width + 'x' + height);
  }
});

test('No duplicate manifest version values across source files', () => {
  const packageFile = path.join(root, 'package.json');
  assert(fs.existsSync(packageFile), 'package.json missing');
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  assert(pkg.version === chrome.version, 'package.json and Chrome manifest versions differ');
  assert(pkg.version === firefox.version, 'package.json and Firefox manifest versions differ');
});

if (failures.length) {
  console.error('\n' + failures.length + ' validation(s) failed, ' + passed + ' passed.');
  process.exit(1);
} else {
  console.log('\nAll ' + passed + ' manifest validations passed.');
}
