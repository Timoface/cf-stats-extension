import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
};

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function findEdge() {
  const candidates = [
    process.env.CFS_EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Microsoft Edge / Chrome was not found. Set CFS_EDGE_PATH.');
}

async function waitForUrl(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw new Error('Timed out waiting for ' + url + (lastError ? ' (' + lastError.message + ')' : ''));
}

export async function launchBrowser(options = {}) {
  const edge = findEdge();
  const width = options.width || 1280;
  const height = options.height || 1800;
  const port = options.port || (9400 + Math.floor(Math.random() * 400));
  const userDataDir = path.join(
    os.tmpdir(),
    'cfs-e2e-' + process.pid + '-' + Date.now() + '-' + Math.floor(Math.random() * 1000)
  );
  fs.mkdirSync(userDataDir, { recursive: true });

  const args = [
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userDataDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--metrics-recording-only',
    '--mute-audio',
    '--window-size=' + width + ',' + height,
    '--remote-allow-origins=*',
    '--disable-gpu',
  ];
  if (options.headless !== false) args.push('--headless=new');
  if (options.disableAutomation) args.push('--disable-blink-features=AutomationControlled');
  if (options.acceptLanguage) {
    args.push('--lang=' + options.acceptLanguage);
    args.push('--accept-lang=' + options.acceptLanguage);
  }

  if (options.extensionPath) {
    args.push('--disable-extensions-except=' + options.extensionPath);
    args.push('--load-extension=' + options.extensionPath);
  }
  args.push('about:blank');

  const processHandle = spawn(edge, args, {
    stdio: 'ignore',
    windowsHide: true,
  });
  processHandle.on('error', () => {});

  let version;
  try {
    version = await waitForUrl('http://127.0.0.1:' + port + '/json/version', 20000);
  } catch (error) {
    try { processHandle.kill(); } catch (killError) { /* ignore */ }
    throw error;
  }

  return {
    process: processHandle,
    port,
    userDataDir,
    browserWebSocketUrl: version.webSocketDebuggerUrl,
    async newPage(url) {
      const target = await fetch(
        'http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(url),
        { method: 'PUT' }
      ).then((response) => response.json());
      return connectTarget(target.webSocketDebuggerUrl);
    },
    async close() {
      try {
        const browser = await connectTarget(version.webSocketDebuggerUrl);
        await browser.send('Browser.close');
        browser.close();
      } catch (error) {
        try { processHandle.kill(); } catch (killError) { /* ignore */ }
      }
      await sleep(400);
      try { processHandle.kill(); } catch (error) { /* ignore */ }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          fs.rmSync(userDataDir, { recursive: true, force: true });
          break;
        } catch (error) {
          await sleep(250);
        }
      }
    },
  };
}

export class Cdp {
  constructor(webSocketUrl) {
    this.url = webSocketUrl;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket connect timeout')), 10000);
      this.ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.ws.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error('WebSocket error: ' + (event && event.message ? event.message : 'unknown')));
      };
    });
    this.ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || 'CDP error'));
        else pending.resolve(message.result);
        return;
      }
      if (message.method) {
        const handlers = this.listeners.get(message.method);
        if (handlers) {
          for (const handler of handlers.slice()) handler(message.params);
        }
      }
    };
    return this;
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP connection is closed'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
    return () => {
      const handlers = this.listeners.get(method) || [];
      this.listeners.set(method, handlers.filter((item) => item !== handler));
    };
  }

  waitForEvent(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('Timed out waiting for event ' + method));
      }, timeoutMs);
      const off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  close() {
    this.closed = true;
    try { this.ws.close(); } catch (error) { /* ignore */ }
  }
}

export async function connectTarget(webSocketUrl) {
  const cdp = new Cdp(webSocketUrl);
  await cdp.connect();
  return cdp;
}

export function startStaticServer(root, options = {}) {
  const server = http.createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'POST' && requestUrl.pathname === options.reportPath) {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => {
          body += chunk;
          if (body.length > 1024 * 1024) request.destroy();
        });
        request.on('end', () => {
          let payload = null;
          try { payload = JSON.parse(body); } catch (error) { payload = { raw: body }; }
          if (options.onReport) options.onReport(payload);
          response.writeHead(204);
          response.end();
        });
        return;
      }
      let pathname = decodeURIComponent(requestUrl.pathname);
      if (pathname === '/' || pathname.startsWith('/profile/')) {
        pathname = options.profilePath || '/tests/harness/profile.html';
      }
      const target = path.resolve(root, '.' + pathname);
      if (!target.startsWith(path.resolve(root) + path.sep) && target !== path.resolve(root)) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
      }
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        response.writeHead(404);
        response.end('Not found: ' + pathname);
        return;
      }
      const extension = path.extname(target).toLowerCase();
      response.writeHead(200, {
        'Content-Type': MIME[extension] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(target).pipe(response);
    } catch (error) {
      response.writeHead(500);
      response.end(String(error && error.message));
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(options.port || 0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        port: address.port,
        url: 'http://127.0.0.1:' + address.port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

export async function evaluate(cdp, expression, options = {}) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: options.returnByValue !== false,
    awaitPromise: !!options.awaitPromise,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error('Evaluation failed: ' +
      (result.exceptionDetails.exception && result.exceptionDetails.exception.description ||
        result.exceptionDetails.text));
  }
  return result.result ? result.result.value : undefined;
}

export async function waitForCondition(cdp, expression, timeoutMs = 15000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(cdp, expression);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for: ' + expression + (lastError ? ' (' + lastError.message + ')' : ''));
}

export async function screenshot(cdp, file) {
  const metrics = await cdp.send('Page.getLayoutMetrics');
  const content = metrics.cssContentSize || metrics.contentSize;
  const width = Math.max(1, Math.ceil(content.width));
  const height = Math.max(1, Math.ceil(content.height));
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    fromSurface: true,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  return { file, width, height, bytes: fs.statSync(file).size };
}

export async function openPage(browser, url, options = {}) {
  const page = await browser.newPage('about:blank');
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  const errors = [];
  page.on('Runtime.exceptionThrown', (params) => {
    const details = params.exceptionDetails || {};
    errors.push(details.exception && details.exception.description || details.text || 'exception');
  });
  page.on('Runtime.consoleAPICalled', (params) => {
    if (params.type !== 'error') return;
    const text = (params.args || []).map((arg) => {
      if (arg.value != null) return String(arg.value);
      if (arg.description) return arg.description;
      return arg.type;
    }).join(' ');
    errors.push(text);
  });
  page.on('Log.entryAdded', (params) => {
    if (params.entry && params.entry.level === 'error') {
      errors.push(params.entry.text);
    }
  });

  if (options.viewport) {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: options.viewport.width,
      height: options.viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }
  await page.send('Page.navigate', { url });
  await waitForCondition(page, 'document.readyState === "complete"', 20000);
  return { page, errors };
}
