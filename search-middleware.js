// Middleware between OpenClaw and cursor-api-proxy
// Intercepts chat completions, detects search intent, injects DuckDuckGo results with page content
const http = require('http');

const PORT = parseInt(process.env.SEARCH_MIDDLEWARE_PORT || '8766');
const CURSOR_PROXY_PORT = 8765;
const SEARCH_PORT = 9876;

// Payload size limits to avoid E2BIG spawn errors in cursor-api-proxy
const MAX_PAGE_CHARS_SEARCH = 2000;   // per search result page
const MAX_PAGE_CHARS_DIRECT = 3000;   // per user-provided URL
const MAX_SEARCH_CONTEXT = 20000;     // total injected search context chars
const MAX_PAYLOAD_BYTES = 120000;     // total JSON payload forwarded to proxy

function searchDDG(query) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${SEARCH_PORT}/search?q=${encodeURIComponent(query)}&count=3`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Fetch page content via search-proxy's Playwright browser endpoint
function fetchPage(url, maxChars = 4000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(''), 15000);
    http.get(`http://127.0.0.1:${SEARCH_PORT}/fetch?url=${encodeURIComponent(url)}&maxChars=${maxChars}`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const json = JSON.parse(data);
          resolve(json.content || '');
        } catch(e) { resolve(''); }
      });
      res.on('error', () => { clearTimeout(timer); resolve(''); });
    }).on('error', () => { clearTimeout(timer); resolve(''); });
  });
}

// Extract URLs from user text
function extractUrls(text) {
  const urlRegex = /https?:\/\/[^\s,)}\]"']+/gi;
  return (text.match(urlRegex) || []).map(u => u.replace(/[.,;:!?]+$/, ''));
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

// Robust deduplication: detects repeated blocks at any split point
function deduplicateText(text) {
  if (!text || text.length < 60) return text;

  // Strategy 1: Find any position where a block of text is immediately repeated
  // Scan for the earliest repeat: check if text[i..i+len] == text[i+len..i+2*len]
  for (let blockLen = Math.floor(text.length * 0.3); blockLen <= Math.floor(text.length * 0.55); blockLen++) {
    const block = text.substring(0, blockLen);
    const rest = text.substring(blockLen);
    // Check if the rest starts with a significant portion of the block
    const checkLen = Math.min(100, Math.floor(block.length * 0.4));
    if (checkLen > 20 && rest.trimStart().startsWith(block.substring(0, checkLen).trimStart())) {
      console.log(`[search-middleware] Dedup: block repeat found at char ${blockLen}`);
      return text.substring(0, blockLen).trim();
    }
  }

  // Strategy 2: Split into sentences/segments, remove consecutive and near-consecutive duplicates
  // Use a regex that handles missing spaces after punctuation too (e.g., "sentence.Next sentence")
  const segments = text.split(/(?<=[.!?。\n])(?:\s+|(?=[A-ZА-ЯЁ]))/);
  if (segments.length > 2) {
    const unique = [segments[0]];
    const seen = new Set([segments[0].trim()]);
    for (let i = 1; i < segments.length; i++) {
      const s = segments[i].trim();
      if (!s) continue;
      if (!seen.has(s)) {
        unique.push(segments[i]);
        seen.add(s);
      }
    }
    if (unique.length < segments.length * 0.85) {
      console.log(`[search-middleware] Dedup: removed ${segments.length - unique.length} duplicate sentences`);
      return unique.join(' ');
    }
  }

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

          // Extract URLs mentioned directly by the user
          const userUrls = extractUrls(userText);
          if (userUrls.length > 0) {
            console.log(`[search-middleware] User mentioned URLs: ${userUrls.join(', ')}`);
          }

          if (query || userUrls.length > 0) {
            if (query) console.log(`[search-middleware] Search detected: "${query.substring(0, 100)}"`);
            try {
              // Fetch user-mentioned URLs directly via Playwright (in parallel with search)
              const [directResults, searchResponse] = await Promise.all([
                userUrls.length > 0 ? Promise.all(userUrls.slice(0, 3).map(async (url) => {
                  console.log(`[search-middleware] Directly fetching user URL: ${url}`);
                  const content = await fetchPage(url, MAX_PAGE_CHARS_DIRECT);
                  return { title: `Page: ${url}`, url, description: 'Directly fetched from user-provided URL', pageContent: content };
                })) : Promise.resolve([]),
                query ? searchDDG(query) : Promise.resolve({ web: { results: [] } }),
              ]);

              const webResults = searchResponse?.web?.results || [];

              // Fetch content from search results via Playwright (skip URLs already fetched directly)
              const fetchedUrls = new Set(userUrls);
              const searchToFetch = webResults.filter(r => !fetchedUrls.has(r.url));

              const enrichedSearch = await Promise.race([
                Promise.all(searchToFetch.slice(0, 3).map(async (r) => {
                  try {
                    const content = await fetchPage(r.url, MAX_PAGE_CHARS_SEARCH);
                    return { ...r, pageContent: content };
                  } catch(e) {
                    return { ...r, pageContent: '' };
                  }
                })),
                new Promise(resolve => setTimeout(() => {
                  console.log('[search-middleware] Page fetch timeout (30s), using snippets only');
                  resolve(searchToFetch.map(r => ({ ...r, pageContent: '' })));
                }, 30000))
              ]);

              const allResults = [...directResults, ...enrichedSearch];

              if (allResults.length > 0) {
                // Build search context with total size cap
                let searchContext = '';
                let usedResults = 0;
                for (let i = 0; i < allResults.length; i++) {
                  const r = allResults[i];
                  let entry = `[${i+1}] ${r.title}\n    URL: ${r.url}\n    ${r.description}`;
                  if (r.pageContent) {
                    entry += `\n    Page content (fetched via Chrome browser):\n    ${r.pageContent}`;
                  }
                  if (searchContext.length + entry.length > MAX_SEARCH_CONTEXT && usedResults > 0) {
                    console.log(`[search-middleware] Search context capped at ${usedResults} results (${searchContext.length} chars)`);
                    break;
                  }
                  searchContext += (usedResults > 0 ? '\n\n' : '') + entry;
                  usedResults++;
                }

                const label = userUrls.length > 0
                  ? `Fetched pages and search results (via real Chrome browser)`
                  : `Web search results for "${query.substring(0, 80)}" (with page content from browser)`;

                messages.splice(messages.length - 1, 0, {
                  role: 'system',
                  content: `${label}:\n\n${searchContext}\n\nIMPORTANT: All pages above were fetched successfully using a real Chrome browser. Do NOT say you cannot access these sites. Use the page content to answer with specific details like prices, product names, and links. Always cite source URLs.`
                });
                payload.messages = messages;
                body = JSON.stringify(payload);
                console.log(`[search-middleware] Injected ${usedResults} results (${allResults.filter(r => r.pageContent).length} with page content), context: ${searchContext.length} chars`);
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

    // Trim payload if too large to avoid E2BIG spawn error in cursor-api-proxy
    if (body.length > MAX_PAYLOAD_BYTES && req.method === 'POST' && req.url.includes('/chat/completions')) {
      try {
        const payload = JSON.parse(body);
        const messages = payload.messages || [];
        // Keep first message (system prompt) and last 4 messages (recent context),
        // trim from the middle (older conversation history)
        while (messages.length > 5 && JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) {
          messages.splice(1, 1);
        }
        // If still too large, truncate content of remaining messages
        if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) {
          for (let i = 0; i < messages.length - 1; i++) {
            if (typeof messages[i].content === 'string' && messages[i].content.length > 2000) {
              messages[i].content = messages[i].content.substring(0, 2000) + '\n[...truncated]';
            }
          }
        }
        payload.messages = messages;
        body = JSON.stringify(payload);
        console.log(`[search-middleware] Trimmed payload to ${body.length} bytes (${messages.length} messages)`);
      } catch(e) {
        console.error('[search-middleware] Payload trim error:', e.message);
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

            const deduped = deduplicateText(fullContent);
            if (deduped.length < fullContent.length) {
              console.log(`[search-middleware] Deduplicated SSE (${fullContent.length} -> ${deduped.length} chars)`);
              // Rebuild as single-chunk SSE with deduped content
              const sseChunk = JSON.stringify({
                choices: [{ index: 0, delta: { content: deduped }, finish_reason: 'stop' }]
              });
              const output = `data: ${sseChunk}\n\ndata: [DONE]\n\n`;
              const headers = { ...proxyRes.headers };
              delete headers['content-length'];
              headers['transfer-encoding'] = 'chunked';
              res.writeHead(proxyRes.statusCode, headers);
              res.end(output);
            } else {
              // No dedup needed, pass through original events
              let output = '';
              for (const evt of events) {
                output += evt.line + '\n\n';
              }
              output += 'data: [DONE]\n\n';
              const headers = { ...proxyRes.headers };
              delete headers['content-length'];
              headers['transfer-encoding'] = 'chunked';
              res.writeHead(proxyRes.statusCode, headers);
              res.end(output);
            }
          } else {
            // Non-streaming JSON response
            try {
              const json = JSON.parse(responseData);
              let content = json.choices?.[0]?.message?.content || '';
              const deduped = deduplicateText(content);
              if (deduped.length < content.length) {
                console.log(`[search-middleware] Deduplicated JSON (${content.length} -> ${deduped.length} chars)`);
                json.choices[0].message.content = deduped;
                responseData = JSON.stringify(json);
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
