// Middleware between OpenClaw and cursor-api-proxy
// Intercepts chat completions, detects search intent, injects DuckDuckGo results
const http = require('http');

const PORT = parseInt(process.env.SEARCH_MIDDLEWARE_PORT || '8766');
const CURSOR_PROXY_PORT = 8765;
const SEARCH_PORT = 9876;

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

function detectSearchIntent(text) {
  if (!text || text.length < 5) return null;
  const lower = text.toLowerCase();
  // Explicit search commands
  const explicit = [
    /^search\s+(for\s+)?(.+)/i,
    /^find\s+(info|information|out)\s+(about\s+)?(.+)/i,
    /^google\s+(.+)/i,
    /^look\s+up\s+(.+)/i,
  ];
  for (const p of explicit) {
    const m = text.match(p);
    if (m) return m[m.length - 1];
  }
  // Keywords suggesting search needed
  const keywords = [
    'search', 'latest news', 'current', 'recent', 'today',
    'what happened', 'who won', 'weather', 'price of',
    'how much', 'when is', 'where is', 'найди', 'поищи', 'zoek'
  ];
  if (keywords.some(k => lower.includes(k))) return text;
  return null;
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
          const content = typeof lastMsg.content === 'string' ? lastMsg.content :
            (Array.isArray(lastMsg.content) ? lastMsg.content.map(c => c.text || '').join(' ') : '');
          console.log(`[search-middleware] Last user message: "${content.substring(0, 100)}"`);
          const query = detectSearchIntent(content);

          if (query) {
            console.log(`[search-middleware] Search detected: "${query}"`);
            try {
              const results = await searchDDG(query);
              const webResults = results?.web?.results || [];
              if (webResults.length > 0) {
                const searchContext = webResults.map((r, i) =>
                  `[${i+1}] ${r.title}\n    URL: ${r.url}\n    ${r.description}`
                ).join('\n\n');

                // Insert search results before the last user message
                messages.splice(messages.length - 1, 0, {
                  role: 'system',
                  content: `Web search results for "${query}":\n\n${searchContext}\n\nUse these search results to answer the user's question. Always cite source URLs.`
                });
                payload.messages = messages;
                body = JSON.stringify(payload);
                console.log(`[search-middleware] Injected ${webResults.length} results`);
              }
            } catch(e) {
              console.error('[search-middleware] Search error:', e.message);
            }
          }
        }
      } catch(e) {
        // Not valid JSON, forward as-is
      }
    }

    // Forward to cursor-api-proxy
    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: CURSOR_PROXY_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, 'content-length': Buffer.byteLength(body), host: `127.0.0.1:${CURSOR_PROXY_PORT}` },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
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
