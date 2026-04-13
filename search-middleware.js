// Middleware between OpenClaw and cursor-api-proxy
// Intercepts chat completions, detects search intent, injects DuckDuckGo results with page content
const http = require('http');

const PORT = parseInt(process.env.SEARCH_MIDDLEWARE_PORT || '8766');
const CURSOR_PROXY_PORT = 8765;
const SEARCH_PORT = 9876;

// Payload size limits to avoid E2BIG spawn errors in cursor-api-proxy
// Linux arg+env limit is ~128KB; keep well under to leave room for command line + env vars
const MAX_PAGE_CHARS_SEARCH = 1500;   // per search result page
const MAX_PAGE_CHARS_DIRECT = 2500;   // per user-provided URL
const MAX_SEARCH_CONTEXT = 15000;     // total injected search context chars
const MAX_PAYLOAD_BYTES = 80000;      // total JSON payload forwarded to proxy
const MAX_IMAGE_DESCRIBE_CHARS = 200; // placeholder text when image is stripped
const MAX_REQUEST_BODY = 200 * 1024 * 1024; // 200MB — accept large image uploads before stripping
const RESPONSE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — abort if cursor-api-proxy hangs
const WHATSAPP_READ_ONLY = parseBooleanEnv(process.env.WHATSAPP_READ_ONLY, true);

function parseBooleanEnv(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

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

// Extract only the OpenClaw metadata wrapper prefix (before the real user text)
function extractMetadataPrefix(content) {
  if (!content || typeof content !== 'string') return '';
  let lastIdx = -1;
  let searchFrom = 0;
  while (true) {
    const idx = content.indexOf('```', searchFrom);
    if (idx === -1) break;
    lastIdx = idx;
    searchFrom = idx + 3;
  }
  if (lastIdx > 10) {
    return content.substring(0, lastIdx + 3);
  }
  return '';
}

// Detect WhatsApp channel from OpenClaw's metadata wrapper only (not user text)
function isWhatsAppWrappedMessage(content) {
  const prefix = extractMetadataPrefix(content);
  if (!prefix) return false;
  return /\bwhatsapp\b/i.test(prefix)
    || /"channel"\s*:\s*"whatsapp"/i.test(prefix)
    || /"source"\s*:\s*"whatsapp"/i.test(prefix)
    || /"platform"\s*:\s*"whatsapp"/i.test(prefix);
}

function isWhatsAppRequest(payload, rawContent) {
  if (isWhatsAppWrappedMessage(rawContent)) return true;
  const text = JSON.stringify(payload || {});
  if (!text) return false;
  return /"channel"\s*:\s*"whatsapp"/i.test(text)
    || /"source"\s*:\s*"whatsapp"/i.test(text)
    || /"platform"\s*:\s*"whatsapp"/i.test(text);
}

function sendReadOnlyNoReply(res, options = {}) {
  const { stream = true, model = 'cursor-proxy/claude-4.6-opus-max-thinking', earlyHeaders = false, keepaliveTimer = null } = options;
  if (keepaliveTimer) clearInterval(keepaliveTimer);

  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-readonly-${Date.now()}`;

  if (stream !== false) {
    if (!earlyHeaders) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
      });
    }
    const startChunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    };
    const stopChunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
    res.write(`data: ${JSON.stringify(startChunk)}\n\n`);
    res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
    res.end('data: [DONE]\n\n');
    return;
  }

  const response = {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(response));
}

// Strip base64 images from multimodal messages — Cursor CLI is text-only, images cause E2BIG
function stripImages(messages) {
  let stripped = 0;
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      msg.content = msg.content.map(part => {
        if (part.type === 'image_url' || part.type === 'image') {
          stripped++;
          return { type: 'text', text: '[Image attached by user — describe what you see if context allows]' };
        }
        // Inline base64 in text parts (some clients embed data:image/... in text)
        if (part.type === 'text' && part.text && part.text.includes('data:image/')) {
          stripped++;
          part.text = part.text.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[base64 image removed]');
        }
        return part;
      });
      // Flatten to string if only text parts remain
      const texts = msg.content.filter(p => p.type === 'text').map(p => p.text);
      if (texts.length === msg.content.length) {
        msg.content = texts.join('\n');
      }
    }
    // Also check string content for embedded base64
    if (typeof msg.content === 'string' && msg.content.includes('data:image/')) {
      stripped++;
      msg.content = msg.content.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[base64 image removed]');
    }
  }
  if (stripped > 0) console.log(`[search-middleware] Stripped ${stripped} image(s) from payload`);
  return messages;
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

// Robust deduplication: detects repeated blocks at any split point (used for non-streaming JSON)
function deduplicateText(text) {
  if (!text || text.length < 60) return text;

  // Strategy 1: Find any position where a block of text is immediately repeated
  for (let blockLen = Math.floor(text.length * 0.3); blockLen <= Math.floor(text.length * 0.55); blockLen++) {
    const block = text.substring(0, blockLen);
    const rest = text.substring(blockLen);
    const checkLen = Math.min(100, Math.floor(block.length * 0.4));
    if (checkLen > 20 && rest.trimStart().startsWith(block.substring(0, checkLen).trimStart())) {
      console.log(`[search-middleware] Dedup: block repeat found at char ${blockLen}`);
      return text.substring(0, blockLen).trim();
    }
  }

  // Strategy 2: Split into sentences/segments, remove consecutive and near-consecutive duplicates
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
  let bodySize = 0;
  let aborted = false;
  req.on('data', c => {
    bodySize += c.length;
    if (bodySize > MAX_REQUEST_BODY) {
      if (!aborted) {
        aborted = true;
        console.log(`[search-middleware] Request body too large (${(bodySize / 1024 / 1024).toFixed(1)}MB), rejecting`);
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Request body too large (max 200MB)', type: 'payload_too_large' } }));
        req.destroy();
      }
      return;
    }
    body += c;
  });
  req.on('end', async () => {
    if (aborted) return;
    console.log(`[search-middleware] ${req.method} ${req.url} (${body.length} bytes)`);

    // Track whether we sent early SSE headers (for streaming chat requests)
    let earlyHeaders = false;
    let keepaliveTimer = null;

    // Only intercept chat completions POST
    if (req.method === 'POST' && req.url.includes('/chat/completions')) {
      try {
        const payload = JSON.parse(body);
        const messages = payload.messages || [];

        // Strip images early — Cursor CLI can't handle base64, and they cause E2BIG
        stripImages(messages);

        // For streaming requests, send SSE headers immediately to prevent client timeout
        // during the search/fetch phase (which can take 15-30s)
        if (payload.stream !== false) {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
          });
          earlyHeaders = true;
          keepaliveTimer = setInterval(() => {
            if (!res.writableEnded) res.write(': keepalive\n\n');
          }, 5000);
        }

        const lastMsg = messages[messages.length - 1];

        if (lastMsg && lastMsg.role === 'user') {
          const rawContent = typeof lastMsg.content === 'string' ? lastMsg.content :
            (Array.isArray(lastMsg.content) ? lastMsg.content.map(c => c.text || '').join(' ') : '');

          // WhatsApp read-only mode: never send LLM-generated replies back to WhatsApp chats/DMs
          if (WHATSAPP_READ_ONLY && isWhatsAppRequest(payload, rawContent)) {
            console.log('[search-middleware] WhatsApp read-only mode: suppressing assistant reply');
            sendReadOnlyNoReply(res, {
              stream: payload.stream,
              model: payload.model,
              earlyHeaders,
              keepaliveTimer,
            });
            return;
          }

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

              let fetchRaceTimer;
              const enrichedSearch = await Promise.race([
                Promise.all(searchToFetch.slice(0, 3).map(async (r) => {
                  try {
                    const content = await fetchPage(r.url, MAX_PAGE_CHARS_SEARCH);
                    return { ...r, pageContent: content };
                  } catch(e) {
                    return { ...r, pageContent: '' };
                  }
                })).then(results => { clearTimeout(fetchRaceTimer); return results; }),
                new Promise(resolve => {
                  fetchRaceTimer = setTimeout(() => {
                    console.log('[search-middleware] Page fetch timeout (30s), using snippets only');
                    resolve(searchToFetch.map(r => ({ ...r, pageContent: '' })));
                  }, 30000);
                })
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

        // Strip images again in case new ones appeared
        stripImages(messages);

        // Phase 1: Drop older conversation messages (keep first system + last 3)
        while (messages.length > 4 && JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) {
          messages.splice(1, 1);
        }
        // Phase 2: Truncate long content in all but the last message
        if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) {
          for (let i = 0; i < messages.length - 1; i++) {
            if (typeof messages[i].content === 'string' && messages[i].content.length > 1500) {
              messages[i].content = messages[i].content.substring(0, 1500) + '\n[...truncated]';
            }
          }
        }
        // Phase 3: If STILL too large, truncate the last message too
        if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) {
          const last = messages[messages.length - 1];
          if (typeof last.content === 'string' && last.content.length > 3000) {
            last.content = last.content.substring(0, 3000) + '\n[...truncated]';
          }
        }
        // Phase 4: Nuclear option — keep only system + last user message
        if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES && messages.length > 2) {
          const first = messages[0];
          const last = messages[messages.length - 1];
          messages.length = 0;
          messages.push(first, last);
        }

        payload.messages = messages;
        body = JSON.stringify(payload);
        console.log(`[search-middleware] Trimmed payload to ${body.length} bytes (${messages.length} messages)`);
      } catch(e) {
        console.error('[search-middleware] Payload trim error:', e.message);
      }
    }

    // Forward to cursor-api-proxy — stream SSE with sentence-level dedup
    const isChat = req.method === 'POST' && req.url.includes('/chat/completions');
    let responseTimedOut = false;
    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: CURSOR_PROXY_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, 'content-length': Buffer.byteLength(body), host: `127.0.0.1:${CURSOR_PROXY_PORT}` },
    }, (proxyRes) => {
      clearTimeout(responseTimer);
      if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
      if (responseTimedOut) return;

      if (!isChat) {
        if (!earlyHeaders) res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
        return;
      }

      const isSSE = proxyRes.headers['content-type']?.includes('text/event-stream') || earlyHeaders;

      if (isSSE) {
        // Send headers if not sent early
        if (!earlyHeaders) {
          const headers = { ...proxyRes.headers };
          delete headers['content-length'];
          headers['transfer-encoding'] = 'chunked';
          res.writeHead(proxyRes.statusCode, headers);
        }

        // Streaming response with sentence-level dedup
        // Parse content deltas, buffer at sentence boundaries, skip duplicate sentences
        let received = '';      // All text content received from upstream
        let flushedLen = 0;     // Offset into `received` up to which we've flushed
        let seenSentences = new Set();
        let stopped = false;
        let sseLineBuf = '';    // Buffer for partial SSE lines across chunks

        res.on('close', () => { stopped = true; });

        function emitDelta(text) {
          if (stopped || !text) return;
          const evt = JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] });
          res.write(`data: ${evt}\n\n`);
        }

        function flushSentences(flush) {
          if (stopped) return;
          const pending = received.substring(flushedLen);
          if (!pending) return;

          // Find last sentence boundary: punctuation followed by whitespace or end of string
          let lastEnd = -1;
          for (let i = pending.length - 1; i >= 0; i--) {
            if ('.!?。'.includes(pending[i]) && (i === pending.length - 1 || /\s/.test(pending[i + 1]))) {
              lastEnd = i; break;
            }
            if (pending[i] === '\n') { lastEnd = i; break; }
          }

          if (lastEnd < 0 && !flush) return; // No complete sentence yet, wait for more data

          const toProcess = lastEnd >= 0 ? pending.substring(0, lastEnd + 1) : pending;

          // Split into sentences at punctuation + whitespace boundaries
          const sentences = toProcess.split(/(?<=[.!?。])\s+/);
          let output = '';

          for (const s of sentences) {
            const trimmed = s.trim();
            if (!trimmed) continue;
            if (trimmed.length < 15) { output += s + ' '; continue; } // Short fragments pass through
            if (seenSentences.has(trimmed)) {
              console.log(`[search-middleware] Streaming dedup: skipped duplicate sentence`);
              continue;
            }
            seenSentences.add(trimmed);
            output += s + ' ';
          }

          if (output.trim()) emitDelta(output);
          flushedLen += toProcess.length;
          // Skip leading whitespace in remaining buffer
          while (flushedLen < received.length && received[flushedLen] === ' ') flushedLen++;
        }

        proxyRes.on('data', (chunk) => {
          if (stopped) return;
          sseLineBuf += chunk.toString();

          // Process complete SSE lines (handle partial lines across chunks)
          let nlIdx;
          while ((nlIdx = sseLineBuf.indexOf('\n')) >= 0) {
            const line = sseLineBuf.substring(0, nlIdx).trim();
            sseLineBuf = sseLineBuf.substring(nlIdx + 1);
            if (!line) continue;
            if (line === 'data: [DONE]') continue; // We send our own [DONE]
            if (line.startsWith('data: ')) {
              try {
                const parsed = JSON.parse(line.slice(6));
                const delta = parsed.choices?.[0]?.delta?.content || '';
                if (delta) received += delta;
              } catch(e) {}
            }
          }

          flushSentences(false);

          // Block-level repeat detection (catch large repeated blocks)
          if (received.length > 300) {
            for (let blockLen = Math.floor(received.length * 0.3); blockLen <= Math.floor(received.length * 0.55); blockLen++) {
              const block = received.substring(0, blockLen);
              const rest = received.substring(blockLen);
              const checkLen = Math.min(100, Math.floor(block.length * 0.4));
              if (checkLen > 20 && rest.trimStart().startsWith(block.substring(0, checkLen).trimStart())) {
                console.log(`[search-middleware] Streaming dedup: block repeat at char ${blockLen}, stopping`);
                stopped = true;
                res.end('\ndata: [DONE]\n\n');
                return;
              }
            }
          }
        });

        proxyRes.on('end', () => {
          if (!stopped) {
            flushSentences(true); // Flush remaining buffered content
            res.end('data: [DONE]\n\n');
          }
        });
      } else {
        // Non-streaming JSON response — buffer and deduplicate fully
        let responseData = '';
        proxyRes.on('data', c => responseData += c);
        proxyRes.on('end', () => {
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
          if (!earlyHeaders) res.writeHead(proxyRes.statusCode, proxyRes.headers);
          res.end(responseData);
        });
      }
    });
    proxyReq.on('error', (e) => {
      if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
      clearTimeout(responseTimer);
      if (responseTimedOut) return;
      if (earlyHeaders) {
        // Already sent 200 SSE headers — send error as SSE event
        const errEvt = JSON.stringify({ choices: [{ index: 0, delta: { content: '\n\n[Error: ' + e.message + ']' }, finish_reason: 'stop' }] });
        res.end(`data: ${errEvt}\n\ndata: [DONE]\n\n`);
      } else if (!res.headersSent) {
        res.writeHead(502);
        res.end('Proxy error: ' + e.message);
      }
    });

    // 10-minute response timeout — abort if cursor-api-proxy hangs
    const responseTimer = setTimeout(() => {
      responseTimedOut = true;
      proxyReq.destroy();
      if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
      console.log('[search-middleware] Response timeout (10 min), aborting request');
      if (earlyHeaders) {
        const errEvt = JSON.stringify({ choices: [{ index: 0, delta: { content: '\n\n[Error: Response timed out. Please try again.]' }, finish_reason: 'stop' }] });
        res.end(`data: ${errEvt}\n\ndata: [DONE]\n\n`);
      } else if (!res.headersSent) {
        res.writeHead(504, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: { message: 'Response timed out after 10 minutes. Please try again.', type: 'timeout' }
        }));
      }
    }, RESPONSE_TIMEOUT_MS);

    proxyReq.end(body);
  });
}

http.createServer(handleRequest).listen(PORT, '127.0.0.1', () => {
  console.log(`Search middleware listening on 127.0.0.1:${PORT} -> cursor-proxy:${CURSOR_PROXY_PORT} (WHATSAPP_READ_ONLY=${WHATSAPP_READ_ONLY})`);
});
