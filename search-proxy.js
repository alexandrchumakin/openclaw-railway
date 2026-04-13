// Web search + page fetch proxy using DuckDuckGo HTML + Playwright
// Provides Brave Search API-compatible endpoint for OpenClaw
// Also provides /fetch?url= endpoint for on-demand page fetching via real browser
const http = require('http');
const https = require('https');
const { chromium } = require('playwright');

// Shared browser instance (lazy-initialized)
let browserPromise = null;
const CHROME_REMOTE_DEBUG_URL = process.env.CHROME_REMOTE_DEBUG_URL || '';
const DEFAULT_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function launchLocalChromium() {
  return chromium.launch({
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
      const browser = await chromium.connectOverCDP(CHROME_REMOTE_DEBUG_URL);
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

// Pre-launch browser on startup
getBrowser();

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

async function fetchPageWithBrowser(url, maxChars = 6000) {
  const browser = await getBrowser();
  if (!browser) return '';

  let page;
  let contextToClose = null;
  try {
    const created = await createPage(browser);
    page = created.page;
    contextToClose = created.contextToClose;
    page.setDefaultTimeout(30000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    // Wait for JS-rendered content
    await page.waitForTimeout(3000);
    const text = await page.evaluate(() => document.body?.innerText || '');
    return text.replace(/\s+/g, ' ').trim().substring(0, maxChars);
  } catch (e) {
    console.error(`[search-proxy] Playwright fetch failed for ${url}: ${e.message}`);
    return '';
  } finally {
    if (page) await page.close().catch(() => {});
    if (contextToClose) await contextToClose.close().catch(() => {});
  }
}

function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHTML(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function searchDDG(query, count = 5) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchHTML(url);
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
    const params = new URL(req.url, 'http://localhost').searchParams;
    const url = params.get('url');
    if (!url) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'missing url parameter' }));
    }
    const maxChars = parseInt(params.get('maxChars') || '6000');
    console.log(`[search-proxy] Fetching URL via browser: ${url}`);
    try {
      const content = await fetchPageWithBrowser(url, maxChars);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url, content, length: content.length }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Handle both /search and /res/v1/web/search (Brave API format)
  if (req.method === 'GET' && (req.url.startsWith('/search') || req.url.startsWith('/res/v1/web/search'))) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const q = params.get('q');
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'missing q parameter' }));
    }
    try {
      const results = await searchDDG(q, parseInt(params.get('count') || '5'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        web: { results: results.map(r => ({ title: r.title, url: r.url, description: r.description })) }
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(9876, '127.0.0.1', () => {
  console.log('Search proxy listening on http://127.0.0.1:9876');
});
