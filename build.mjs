import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');

function rm(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copy(source, destination) {
  fs.cpSync(source, destination, { recursive: true });
}

function ensureFile(file) {
  if (!fs.existsSync(file)) throw new Error('Missing build input: ' + file);
}

function collectManifestFiles(manifest) {
  const files = new Set();
  const add = (value) => {
    if (typeof value === 'string') files.add(value.replace(/^\//, ''));
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

function validateDist(browser) {
  const folder = path.join(dist, browser);
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
  for (const file of collectManifestFiles(manifest)) {
    const target = path.join(folder, file);
    if (!fs.existsSync(target)) {
      throw new Error(browser + ': manifest references missing file ' + file);
    }
  }
  if (manifest.manifest_version !== 3) {
    throw new Error(browser + ': not Manifest V3');
  }
  console.log('  ' + browser + ': manifest + ' + collectManifestFiles(manifest).length + ' referenced files OK');
}

function directorySize(folder) {
  let total = 0;
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const target = path.join(folder, entry.name);
    if (entry.isDirectory()) total += directorySize(target);
    else total += fs.statSync(target).size;
  }
  return total;
}

rm(dist);
for (const folder of ['chrome', 'firefox']) {
  fs.mkdirSync(path.join(dist, folder), { recursive: true });
}

for (const input of ['src', 'icons', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  ensureFile(path.join(root, input));
  copy(path.join(root, input), path.join(dist, 'chrome', input));
  copy(path.join(root, input), path.join(dist, 'firefox', input));
}

copy(path.join(root, 'manifest.json'), path.join(dist, 'chrome', 'manifest.json'));
copy(path.join(root, 'manifest.firefox.json'), path.join(dist, 'firefox', 'manifest.json'));

console.log('Build output:');
validateDist('chrome');
validateDist('firefox');
console.log('  chrome:  ' + (directorySize(path.join(dist, 'chrome')) / 1024).toFixed(1) + ' KiB');
console.log('  firefox: ' + (directorySize(path.join(dist, 'firefox')) / 1024).toFixed(1) + ' KiB');

if (process.platform === 'win32') {
  try {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(root, 'scripts', 'package.ps1'),
    ], { stdio: 'inherit', cwd: root });
  } catch (error) {
    console.warn('ZIP packaging failed (the unpacked builds are still ready): ' + error.message);
    process.exitCode = 0;
  }
} else {
  console.log('  ZIP packaging: run scripts/package.ps1 on Windows or zip dist/chrome and dist/firefox manually.');
}

console.log('\nDone. Load dist/chrome in Chrome or dist/firefox in Firefox.');
