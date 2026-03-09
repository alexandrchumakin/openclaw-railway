// Routes incoming requests and injects web search results into LLM calls
const http = require('http');
const net = require('net');

const PORT = parseInt(process.env.PORT || '8080');
const OPENCLAW_PORT = 18789;
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

// Detect if user wants a web search
function detectSearchIntent(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const searchPatterns = [
    /^search\s+(for\s+)?(.+)/i,
    /^find\s+(info|information|out)\s+(about\s+)?(.+)/i,
    /^google\s+(.+)/i,
    /^look\s+up\s+(.+)/i,
    /^what('s| is) (the )?(latest|current|recent|new)\s+(.+)/i,
    /^(latest|current|recent)\s+(news|info|information|updates?)\s+(about|on|for)\s+(.+)/i,
  ];
  for (const p of searchPatterns) {
    const m = text.match(p);
    if (m) return m[m.length - 1];
  }
  // Keywords that suggest search is needed
  if (/(search|find|look up|latest news|current|what happened|who is|where is)/i.test(lower)) {
    return text;
  }
  return null;
}

async function handleChatCompletions(req, res, body) {
  try {
    const payload = JSON.parse(body);
    const messages = payload.messages || [];
    const lastMsg = messages[messages.length - 1];

    if (lastMsg && lastMsg.role === 'user') {
      const content = typeof lastMsg.content === 'string' ? lastMsg.content : '';
      const query = detectSearchIntent(content);

      if (query) {
        try {
          const results = await searchDDG(query);
          const webResults = results?.web?.results || [];
          if (webResults.length > 0) {
            const searchContext = webResults.map((r, i) =>
              `[${i+1}] ${r.title}\n    ${r.url}\n    ${r.description}`
            ).join('\n\n');

            // Inject search results as a system message before the user's message
            const insertIdx = messages.length - 1;
            messages.splice(insertIdx, 0, {
              role: 'system',
              content: `Web search results for "${query}":\n\n${searchContext}\n\nUse these results to answer the user's question. Include source URLs in your response.`
            });
            payload.messages = messages;
          }
        } catch(e) {
          console.error('Search failed:', e.message);
        }
      }
    }

    // Forward modified payload to cursor-api-proxy
    const newBody = JSON.stringify(payload);
    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: 8765,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        ...req.headers,
        'content-length': Buffer.byteLength(newBody),
        host: '127.0.0.1:8765',
      },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (e) => {
      res.writeHead(502);
      res.end('Proxy error: ' + e.message);
    });
    proxyReq.end(newBody);
  } catch(e) {
    // Not JSON or error - just forward as-is
    forwardToOpenclaw(req, res, body);
  }
}

function forwardToOpenclaw(req, res, body) {
  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: OPENCLAW_PORT,
    path: req.url,
    method: req.method,
    headers: req.headers,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => {
    res.writeHead(502);
    res.end('Bad Gateway: ' + e.message);
  });
  if (body) proxyReq.end(body);
  else req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  // Search proxy direct access
  if (req.url.startsWith('/search')) {
    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: SEARCH_PORT,
      path: req.url,
      method: req.method,
      headers: req.headers,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (e) => { res.writeHead(502); res.end(e.message); });
    req.pipe(proxyReq);
    return;
  }

  // Intercept chat completions to inject search results
  if (req.method === 'POST' && req.url.includes('/chat/completions')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => handleChatCompletions(req, res, body));
    return;
  }

  // Everything else -> OpenClaw
  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: OPENCLAW_PORT,
    path: req.url,
    method: req.method,
    headers: req.headers,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => { res.writeHead(502); res.end(e.message); });
  req.pipe(proxyReq);
});

// WebSocket upgrades -> OpenClaw
server.on('upgrade', (req, socket, head) => {
  const proxy = net.createConnection(OPENCLAW_PORT, '127.0.0.1', () => {
    proxy.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      proxy.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i+1]}\r\n`);
    }
    proxy.write('\r\n');
    if (head.length) proxy.write(head);
    socket.pipe(proxy).pipe(socket);
  });
  proxy.on('error', () => socket.end());
  socket.on('error', () => proxy.end());
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Router listening on 0.0.0.0:${PORT} -> OpenClaw:${OPENCLAW_PORT} + Search:${SEARCH_PORT}`);
});
