// Web search + page fetch proxy using DuckDuckGo HTML + Playwright
// Provides Brave Search API-compatible endpoint for OpenClaw
// Also provides /fetch?url= endpoint for on-demand page fetching via real browser
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
let chromium = null;

// Shared browser instance (lazy-initialized)
let browserPromise = null;
const CHROME_REMOTE_DEBUG_URL = process.env.CHROME_REMOTE_DEBUG_URL || '';
const DEFAULT_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PORT = parseInt(process.env.SEARCH_PROXY_PORT || '9876');
const HTML_TIMEOUT_MS = parseInt(process.env.HTML_TIMEOUT_MS || '10000');
const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const parsedPageLimit = parseInt(process.env.MAX_CONCURRENT_PAGES || '4');
const MAX_CONCURRENT_PAGES = Number.isInteger(parsedPageLimit) && parsedPageLimit > 0
  ? parsedPageLimit
  : 4;
let activePages = 0;
const pageWaiters = [];

function createAbortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function getChromium() {
  if (!chromium) ({ chromium } = require('playwright'));
  return chromium;
}

function safeUrlForLog(value) {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch (error) {
    return '[invalid URL]';
  }
}

function isPrivateIp(value) {
  const address = value.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (net.isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224;
  }
  if (net.isIP(address) === 6) {
    const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    const mappedHex = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const high = parseInt(mappedHex[1], 16);
      const low = parseInt(mappedHex[2], 16);
      return isPrivateIp(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    const first = parseInt(address.split(':')[0] || '0', 16);
    return address === '::'
      || address === '::1'
      || first === 0
      || (first & 0xfe00) === 0xfc00
      || (first & 0xffc0) === 0xfe80
      || (first & 0xff00) === 0xff00;
  }
  return true;
}

function isBlockedHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
    || normalized.endsWith('.internal')
    || normalized === 'metadata.google.internal';
}

async function isPublicHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    return false;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || isBlockedHostname(parsed.hostname)) {
    return false;
  }
  if (net.isIP(parsed.hostname)) return !isPrivateIp(parsed.hostname);

  try {
    const addresses = await dns.promises.lookup(parsed.hostname, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every(({ address }) => !isPrivateIp(address));
  } catch (error) {
    return false;
  }
}

function acquirePageSlot(signal) {
  if (signal?.aborted) return Promise.reject(createAbortError('Page fetch was cancelled'));
  if (activePages < MAX_CONCURRENT_PAGES) {
    activePages += 1;
    return Promise.resolve(releasePageSlot);
  }

  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, onAbort: null };
    waiter.onAbort = () => {
      const index = pageWaiters.indexOf(waiter);
      if (index >= 0) pageWaiters.splice(index, 1);
      reject(createAbortError('Page fetch was cancelled'));
    };
    signal?.addEventListener('abort', waiter.onAbort, { once: true });
    pageWaiters.push(waiter);
  });
}

function releasePageSlot() {
  activePages = Math.max(0, activePages - 1);
  while (pageWaiters.length > 0) {
    const waiter = pageWaiters.shift();
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    if (waiter.signal?.aborted) continue;
    activePages += 1;
    waiter.resolve(releasePageSlot);
    break;
  }
}

function launchLocalChromium() {
  return getChromium().launch({
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled'
    ],
  }).then(b => {
    console.log('[search-proxy] Local Chromium launched');
    return b;
  });
}

async function connectBrowser() {
  if (CHROME_REMOTE_DEBUG_URL) {
    try {
      const browser = await getChromium().connectOverCDP(CHROME_REMOTE_DEBUG_URL);
      console.log(`[search-proxy] Connected to Chrome via CDP: ${CHROME_REMOTE_DEBUG_URL}`);
      return browser;
    } catch (e) {
      console.error(`[search-proxy] CDP connect failed (${CHROME_REMOTE_DEBUG_URL}): ${e.message}`);
      console.log('[search-proxy] Falling back to local Chromium launch');
    }
  }
  return launchLocalChromium();
}

function getBrowser() {
  if (!browserPromise) {
    browserPromise = connectBrowser().then(b => {
      if (b && typeof b.on === 'function') {
        b.on('disconnected', () => {
          console.error('[search-proxy] Browser disconnected; will reconnect on next request');
          browserPromise = null;
        });
      }
      return b;
    }).catch(e => {
      console.error('[search-proxy] Failed to launch browser:', e.message);
      browserPromise = null;
      return null;
    });
  }
  return browserPromise;
}

async function createPage(browser) {
  const existingContexts = typeof browser.contexts === 'function' ? browser.contexts() : [];
  if (existingContexts.length > 0) {
    const page = await existingContexts[0].newPage();
    return { page, contextToClose: null };
  }

  const context = await browser.newContext({
    userAgent: DEFAULT_UA,
    locale: 'nl-NL',
  });
  const page = await context.newPage();
  return { page, contextToClose: context };
}

async function fetchPageWithBrowser(url, maxChars = 6000, signal) {
  if (signal?.aborted) return '';

  let page;
  let contextToClose = null;
  let releaseSlot = null;
  const closePageOnAbort = () => { page?.close().catch(() => {}); };
  signal?.addEventListener('abort', closePageOnAbort, { once: true });
  try {
    if (!await isPublicHttpUrl(url)) {
      console.error(`[search-proxy] Blocked non-public URL: ${safeUrlForLog(url)}`);
      return '';
    }
    releaseSlot = await acquirePageSlot(signal);
    const browser = await getBrowser();
    if (!browser) return '';
    const created = await createPage(browser);
    page = created.page;
    contextToClose = created.contextToClose;
    const hostnameSafety = new Map();
    await page.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      let parsed;
      try {
        parsed = new URL(requestUrl);
      } catch (error) {
        await route.abort('blockedbyclient');
        return;
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        await route.continue();
        return;
      }
      let safe = hostnameSafety.get(parsed.hostname);
      if (safe === undefined) {
        safe = await isPublicHttpUrl(requestUrl);
        hostnameSafety.set(parsed.hostname, safe);
      }
      if (safe) await route.continue();
      else await route.abort('blockedbyclient');
    });
    if (signal?.aborted) throw createAbortError('Page fetch was cancelled');
    page.setDefaultTimeout(30000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    // Wait for JS-rendered content
    await page.waitForTimeout(3000);
    const text = await page.evaluate(() => document.body?.innerText || '');
    return text.replace(/\s+/g, ' ').trim().substring(0, maxChars);
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error(`[search-proxy] Playwright fetch failed for ${safeUrlForLog(url)}: ${e.message}`);
    }
    return '';
  } finally {
    signal?.removeEventListener('abort', closePageOnAbort);
    if (page) await page.close().catch(() => {});
    if (contextToClose) await contextToClose.close().catch(() => {});
    releaseSlot?.();
  }
}

function fetchHTML(url, { signal, redirects = 0 } = {}) {
  if (signal?.aborted) return Promise.reject(createAbortError('HTML fetch was cancelled'));
  if (redirects > MAX_REDIRECTS) return Promise.reject(new Error('Too many redirects'));

  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (error) {
      reject(new Error('Invalid search URL'));
      return;
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      reject(new Error('Unsupported search URL protocol'));
      return;
    }

    let finished = false;
    let request;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => {
      if (finished) return;
      finished = true;
      cleanup();
      request?.destroy();
      reject(createAbortError('HTML fetch was cancelled'));
    };
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      cleanup();
      request?.destroy();
      reject(new Error(`HTML fetch timed out after ${HTML_TIMEOUT_MS}ms`));
    }, HTML_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });

    const mod = parsedUrl.protocol === 'https:' ? https : http;
    request = mod.get(parsedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, parsedUrl).toString();
        res.resume();
        finished = true;
        cleanup();
        fetchHTML(redirectUrl, { signal, redirects: redirects + 1 }).then(resolve, reject);
        return;
      }
      let data = '';
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_HTML_BYTES) {
          res.destroy();
          finish(new Error('HTML response exceeded size limit'));
          return;
        }
        data += chunk;
      });
      res.on('end', () => finish(null, data));
      res.on('error', (error) => finish(error));
    });
    request.on('error', (error) => finish(error));
  });
}

async function searchDDG(query, count = 5, signal) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchHTML(url, { signal });
  const results = [];
  const regex = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = regex.exec(html)) && results.length < count) {
    const href = decodeURIComponent(match[1].replace(/.*uddg=/, '').replace(/&.*/, ''));
    const title = match[2].replace(/<[^>]+>/g, '').trim();
    const snippet = match[3].replace(/<[^>]+>/g, '').trim();
    // Filter out DDG ad tracking URLs and non-http results
    if (href.startsWith('http') && !href.includes('duckduckgo.com/y.js')) {
      results.push({ title, url: href, description: snippet });
    }
  }
  return results;
}

const server = http.createServer(async (req, res) => {
  // Fetch a single URL via Playwright browser: GET /fetch?url=<encoded-url>&maxChars=6000
  if (req.method === 'GET' && req.url.startsWith('/fetch')) {
    const controller = new AbortController();
    const abortOnDisconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', abortOnDisconnect);
    const params = new URL(req.url, 'http://localhost').searchParams;
    const url = params.get('url');
    if (!url) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'missing url parameter' }));
    }
    const maxChars = parseInt(params.get('maxChars') || '6000');
    console.log(`[search-proxy] Fetching URL via browser: ${safeUrlForLog(url)}`);
    try {
      const content = await fetchPageWithBrowser(url, maxChars, controller.signal);
      if (controller.signal.aborted) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url, content, length: content.length }));
    } catch (e) {
      if (controller.signal.aborted) return;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    } finally {
      res.removeListener('close', abortOnDisconnect);
    }
    return;
  }

  // Handle both /search and /res/v1/web/search (Brave API format)
  if (req.method === 'GET' && (req.url.startsWith('/search') || req.url.startsWith('/res/v1/web/search'))) {
    const controller = new AbortController();
    const abortOnDisconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', abortOnDisconnect);
    const params = new URL(req.url, 'http://localhost').searchParams;
    const q = params.get('q');
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'missing q parameter' }));
    }
    try {
      const results = await searchDDG(q, parseInt(params.get('count') || '5'), controller.signal);
      if (controller.signal.aborted) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        web: { results: results.map(r => ({ title: r.title, url: r.url, description: r.description })) }
      }));
    } catch (e) {
      if (controller.signal.aborted) return;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    } finally {
      res.removeListener('close', abortOnDisconnect);
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

if (require.main === module) {
  getBrowser();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Search proxy listening on http://127.0.0.1:${PORT}`);
  });
}

module.exports = {
  isBlockedHostname,
  isPrivateIp,
  isPublicHttpUrl,
};
