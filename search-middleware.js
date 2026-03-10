// Middleware between OpenClaw and cursor-api-proxy
// Intercepts chat completions, detects search intent, injects DuckDuckGo results
const http = require('http');
const { chromium } = require('playwright');

const PORT = parseInt(process.env.SEARCH_MIDDLEWARE_PORT || '8766');
const CURSOR_PROXY_PORT = 8765;
const SEARCH_PORT = 9876;

// Shared browser instance (lazy-initialized)
let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    }).then(b => {
      console.log('[search-middleware] Chromium browser launched');
      return b;
    }).catch(e => {
      console.error('[search-middleware] Failed to launch browser:', e.message);
      browserPromise = null;
      return null;
    });
  }
  return browserPromise;
}

// Pre-launch browser on startup
getBrowser();

function searchDDG(query) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${SEARCH_PORT}/search?q=${encodeURIComponent(query)}&count=5`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function fetchPage(url, maxChars = 2000) {
  const browser = await getBrowser();
  if (!browser) return '';

  let page;
  try {
    page = await browser.newPage();
    page.setDefaultTimeout(6000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 6000 });
    // Brief wait for JS-rendered content
    await page.waitForTimeout(1500);
    const text = await page.evaluate(() => document.body?.innerText || '');
    return text.replace(/\s+/g, ' ').trim().substring(0, maxChars);
  } catch (e) {
    console.error(`[search-middleware] Playwright fetch failed for ${url}: ${e.message}`);
    return '';
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// Extract actual user text from OpenClaw's metadata wrapper
function extractUserText(content) {
  if (!content) return '';
  // OpenClaw wraps messages with multiple metadata blocks:
  // "Conversation info (untrusted metadata):\n```json\n{...}\n```\n\nSender (untrusted metadata):\n```json\n{...}\n```\nActual message"
  // Find the LAST closing ``` and take everything after it
  let lastIdx = -1;
  let searchFrom = 0;
  while (true) {
    const idx = content.indexOf('```', searchFrom);
    if (idx === -1) break;
    lastIdx = idx;
    searchFrom = idx + 3;
  }
  if (lastIdx > 10) {
    return content.substring(lastIdx + 3).trim();
  }
  return content;
}

function detectSearchIntent(text) {
  if (!text || text.length < 3) return null;
  const lower = text.toLowerCase();

  // Only skip search for very short conversational messages
  const skipPatterns = [
    /^(hi|hello|hey|thanks|thank you|ok|yes|no|bye|good|great|cool|nice|lol|haha)\b/i,
    /^(привет|спасибо|да|нет|ок|хорошо|пока)\b/i,
    /^(hoi|bedankt|ja|nee|doei)\b/i,
  ];
  if (skipPatterns.some(p => p.test(lower)) && text.length < 30) return null;

  // Skip if it's a translation request
  if (/^(translate|vertaal|переведи)/i.test(lower)) return null;

  // Search for everything else that looks like a question or info request
  // This is intentionally aggressive — better to search too much than too little
  return text;
}

async function handleRequest(req, res) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    console.log(`[search-middleware] ${req.method} ${req.url} (${body.length} bytes)`);

    // Only intercept chat completions POST
    if (req.method === 'POST' && req.url.includes('/chat/completions')) {
      try {
        const payload = JSON.parse(body);
        const messages = payload.messages || [];
        const lastMsg = messages[messages.length - 1];

        if (lastMsg && lastMsg.role === 'user') {
          const rawContent = typeof lastMsg.content === 'string' ? lastMsg.content :
            (Array.isArray(lastMsg.content) ? lastMsg.content.map(c => c.text || '').join(' ') : '');

          // Extract actual user text from OpenClaw metadata wrapper
          const userText = extractUserText(rawContent);
          console.log(`[search-middleware] Extracted user text: "${userText.substring(0, 150)}"`);

          const query = detectSearchIntent(userText);

          if (query) {
            console.log(`[search-middleware] Search detected: "${query.substring(0, 100)}"`);
            try {
              const results = await searchDDG(query);
              const webResults = results?.web?.results || [];
              if (webResults.length > 0) {
                // Fetch content from top 3 pages (with 8s total timeout)
                const enrichedResults = await Promise.race([
                  Promise.all(webResults.slice(0, 3).map(async (r) => {
                    try {
                      const content = await fetchPage(r.url, 2000);
                      return { ...r, pageContent: content };
                    } catch(e) {
                      return { ...r, pageContent: '' };
                    }
                  })),
                  new Promise(resolve => setTimeout(() => {
                    console.log('[search-middleware] Page fetch timeout (8s), using snippets only');
                    resolve(webResults.slice(0, 3).map(r => ({ ...r, pageContent: '' })));
                  }, 8000))
                ]);

                const searchContext = enrichedResults.map((r, i) => {
                  let entry = `[${i+1}] ${r.title}\n    URL: ${r.url}\n    ${r.description}`;
                  if (r.pageContent) {
                    entry += `\n    Page content:\n    ${r.pageContent.substring(0, 2000)}`;
                  }
                  return entry;
                }).join('\n\n');

                // Add remaining results without page content
                const remaining = webResults.slice(3).map((r, i) =>
                  `[${i+4}] ${r.title}\n    URL: ${r.url}\n    ${r.description}`
                ).join('\n\n');

                const fullContext = remaining ? searchContext + '\n\n' + remaining : searchContext;

                messages.splice(messages.length - 1, 0, {
                  role: 'system',
                  content: `Web search results for "${query.substring(0, 80)}" (with page content from top results):\n\n${fullContext}\n\nUse these search results AND the page content to give a detailed, helpful answer. Include specific details like prices, product names, and links. Always cite source URLs.`
                });
                payload.messages = messages;
                body = JSON.stringify(payload);
                console.log(`[search-middleware] Injected ${webResults.length} results (${enrichedResults.filter(r => r.pageContent).length} with page content)`);
              }
            } catch(e) {
              console.error('[search-middleware] Search error:', e.message);
            }
          } else {
            console.log(`[search-middleware] No search intent detected`);
          }
        }
      } catch(e) {
        console.error('[search-middleware] Parse error:', e.message);
      }
    }

    // Forward to cursor-api-proxy, buffer and deduplicate response
    const isChat = req.method === 'POST' && req.url.includes('/chat/completions');
    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: CURSOR_PROXY_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, 'content-length': Buffer.byteLength(body), host: `127.0.0.1:${CURSOR_PROXY_PORT}` },
    }, (proxyRes) => {
      if (!isChat) {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
        return;
      }

      // Buffer full response to deduplicate
      let responseData = '';
      proxyRes.on('data', c => responseData += c);
      proxyRes.on('end', () => {
        try {
          if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
            // Parse SSE events, collect content and track where duplicate starts
            const lines = responseData.split('\n');
            let fullContent = '';
            let events = [];
            for (const line of lines) {
              if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                  const chunk = JSON.parse(line.slice(6));
                  const delta = chunk.choices?.[0]?.delta?.content || '';
                  events.push({ line, content: delta });
                  fullContent += delta;
                } catch(e) {
                  events.push({ line, content: '' });
                }
              }
            }

            // Detect duplicate: if second half repeats first half
            let cutAfterChars = fullContent.length;
            if (fullContent.length > 100) {
              const half = Math.floor(fullContent.length / 2);
              const first = fullContent.substring(0, half);
              const second = fullContent.substring(half);
              if (first.length > 50 && second.startsWith(first.substring(0, Math.min(200, first.length)))) {
                cutAfterChars = half;
                console.log(`[search-middleware] Deduplicated SSE (${fullContent.length} -> ${cutAfterChars} chars)`);
              }
            }

            // Rebuild SSE stream, cutting off at dedup point
            let charsSent = 0;
            let output = '';
            for (const evt of events) {
              if (charsSent >= cutAfterChars && evt.content) break;
              output += evt.line + '\n\n';
              charsSent += evt.content.length;
            }
            output += 'data: [DONE]\n\n';

            const headers = { ...proxyRes.headers };
            delete headers['content-length'];
            headers['transfer-encoding'] = 'chunked';
            res.writeHead(proxyRes.statusCode, headers);
            res.end(output);
          } else {
            // Non-streaming JSON response
            try {
              const json = JSON.parse(responseData);
              let content = json.choices?.[0]?.message?.content || '';
              if (content.length > 100) {
                const half = Math.floor(content.length / 2);
                const first = content.substring(0, half);
                const second = content.substring(half);
                if (first.length > 50 && second.startsWith(first.substring(0, Math.min(200, first.length)))) {
                  console.log(`[search-middleware] Deduplicated JSON response`);
                  json.choices[0].message.content = first;
                  responseData = JSON.stringify(json);
                }
              }
            } catch(e) {}
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            res.end(responseData);
          }
        } catch(e) {
          console.error('[search-middleware] Response error:', e.message);
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          res.end(responseData);
        }
      });
    });
    proxyReq.on('error', (e) => {
      res.writeHead(502);
      res.end('Proxy error: ' + e.message);
    });
    proxyReq.end(body);
  });
}

http.createServer(handleRequest).listen(PORT, '127.0.0.1', () => {
  console.log(`Search middleware listening on 127.0.0.1:${PORT} -> cursor-proxy:${CURSOR_PROXY_PORT}`);
});
