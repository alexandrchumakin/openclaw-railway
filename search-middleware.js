// Middleware between OpenClaw and cursor-api-proxy
// Intercepts chat completions, detects search intent, injects DuckDuckGo results with page content
const http = require('http');
const { StringDecoder } = require('string_decoder');

const PORT = parseInt(process.env.SEARCH_MIDDLEWARE_PORT || '8766');
const CURSOR_PROXY_PORT = parseInt(process.env.CURSOR_PROXY_PORT || '8765');
const SEARCH_PORT = parseInt(process.env.SEARCH_PROXY_PORT || '9876');
const DEFAULT_MODEL = process.env.PRIMARY_MODEL_ID || 'claude-opus-4-8-thinking-max';

// Payload size limits to avoid E2BIG spawn errors in cursor-api-proxy
// Linux arg+env limit is ~128KB; keep well under to leave room for command line + env vars
const MAX_PAGE_CHARS_SEARCH = 1500;   // per search result page
const MAX_PAGE_CHARS_DIRECT = 2500;   // per user-provided URL
const MAX_SEARCH_CONTEXT = 15000;     // total injected search context chars
const MAX_PAYLOAD_BYTES = 80000;      // total JSON payload forwarded to proxy
const MAX_IMAGE_DESCRIBE_CHARS = 200; // placeholder text when image is stripped
const MAX_REQUEST_BODY = 200 * 1024 * 1024; // 200MB — accept large image uploads before stripping
const RESPONSE_TIMEOUT_MS = parseInt(process.env.RESPONSE_TIMEOUT_MS || '450000');
const RESPONSE_IDLE_TIMEOUT_MS = parseInt(process.env.RESPONSE_IDLE_TIMEOUT_MS || '300000');
const SEARCH_REQUEST_TIMEOUT_MS = parseInt(process.env.SEARCH_REQUEST_TIMEOUT_MS || '10000');
const ENRICHMENT_TIMEOUT_MS = parseInt(process.env.ENRICHMENT_TIMEOUT_MS || '30000');
const WHATSAPP_READ_ONLY = parseBooleanEnv(process.env.WHATSAPP_READ_ONLY, true);

function parseBooleanEnv(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function createAbortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function getLocalJson(path, { signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError('Request was cancelled'));
      return;
    }

    let finished = false;
    let request = null;
    let response = null;
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
    const cancel = (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      response?.destroy();
      request?.destroy();
      reject(error);
    };
    const onAbort = () => cancel(createAbortError('Request was cancelled'));
    const timer = setTimeout(() => {
      cancel(new Error(`Local search request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });

    request = http.get(`http://127.0.0.1:${SEARCH_PORT}${path}`, (res) => {
      response = res;
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          finish(new Error(`Local search service returned HTTP ${res.statusCode}`));
          return;
        }
        try {
          finish(null, JSON.parse(data));
        } catch (error) {
          finish(error);
        }
      });
      res.on('error', (error) => finish(error));
    });
    request.on('error', (error) => finish(error));
  });
}

function searchDDG(query, signal) {
  return getLocalJson(`/search?q=${encodeURIComponent(query)}&count=3`, {
    signal,
    timeoutMs: SEARCH_REQUEST_TIMEOUT_MS,
  });
}

// Fetch page content via search-proxy's Playwright browser endpoint.
async function fetchPage(url, maxChars = 4000, signal) {
  try {
    const data = await getLocalJson(`/fetch?url=${encodeURIComponent(url)}&maxChars=${maxChars}`, {
      signal,
      timeoutMs: 15000,
    });
    return data.content || '';
  } catch (error) {
    return '';
  }
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
  const { stream = true, model = DEFAULT_MODEL, earlyHeaders = false, keepaliveTimer = null } = options;
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

// Deduplication segments text at stable boundaries (sentence punctuation
// followed by whitespace, or a newline) computed over the accumulated text —
// never at network chunk edges — so the same content always produces the same
// segments no matter how it was streamed. Kept text is emitted verbatim, so
// URLs, newlines, and spacing survive untouched.
//
// Cursor's thinking model duplicates whole BLOCKS (often with an interstitial
// paragraph between the copies), while legitimate answers may repeat a single
// line (code separators, list rows, refrains). To drop the former without
// eating the latter, a previously seen segment is dropped only once a run is
// confirmed: a duplicate followed by another duplicate of at least
// DEDUP_MIN_SEGMENT_CHARS starts a run, and the run then drops every
// consecutive duplicate until novel text appears. An isolated duplicate is
// emitted unchanged.
const DEDUP_MIN_SEGMENT_CHARS = 15;
const SENTENCE_ENDINGS = '.!?。';

function isSpaceChar(ch) {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
}

function createStreamDeduper({ onSkip } = {}) {
  let buffer = '';
  let cursor = 0;
  const seen = new Set();
  let dropRun = false;
  let pending = null; // isolated duplicate held back until the next segment confirms or refutes a run
  let removed = 0;

  function skip(count) {
    removed += count;
    for (let i = 0; i < count; i++) onSkip?.();
  }

  // End (exclusive, incl. trailing whitespace) of the next complete segment,
  // or -1 if more data is needed. Unless `final`, a segment only closes once a
  // non-whitespace character follows its trailing whitespace, so a chunk
  // boundary can never split a sentence, a URL, or a whitespace run.
  function findSegmentEnd(final) {
    for (let i = cursor; i < buffer.length; i++) {
      const ch = buffer[i];
      let sepStart = -1;
      if (ch === '\n') {
        sepStart = i;
      } else if (SENTENCE_ENDINGS.includes(ch)) {
        if (i + 1 < buffer.length && isSpaceChar(buffer[i + 1])) sepStart = i + 1;
        else if (i + 1 === buffer.length) return final ? buffer.length : -1;
        else continue;
      } else {
        continue;
      }
      let sepEnd = sepStart;
      while (sepEnd < buffer.length && isSpaceChar(buffer[sepEnd])) sepEnd++;
      if (sepEnd < buffer.length || final) return sepEnd;
      return -1;
    }
    return final && cursor < buffer.length ? buffer.length : -1;
  }

  // A truncated stream tail that is a strict prefix of an already-seen
  // segment is the beginning of another duplicate copy, not novel text.
  function isPrefixOfSeen(key) {
    for (const existing of seen) {
      if (existing.length > key.length && existing.startsWith(key)) return true;
    }
    return false;
  }

  function classify(segment, atEof) {
    const key = segment.replace(/\s+/g, ' ').trim();
    if (!key) {
      if (dropRun) return '';
      if (pending) {
        pending.text += segment;
        return '';
      }
      return segment;
    }

    if (!seen.has(key)) {
      if (atEof && key.length >= DEDUP_MIN_SEGMENT_CHARS && isPrefixOfSeen(key)) {
        skip(1);
        return '';
      }
      seen.add(key);
      dropRun = false;
      if (pending) {
        const held = pending.text;
        pending = null;
        return held + segment;
      }
      return segment;
    }

    if (dropRun) {
      skip(1);
      return '';
    }
    if (pending) {
      if (key.length >= DEDUP_MIN_SEGMENT_CHARS) {
        // Two consecutive duplicates, confirmed by a full sentence: a repeated block.
        pending = null;
        dropRun = true;
        skip(2);
        return '';
      }
      const held = pending.text;
      pending = { text: segment, key };
      return held;
    }
    pending = { text: segment, key };
    return '';
  }

  function drain(final) {
    let output = '';
    let end;
    while ((end = findSegmentEnd(final)) >= 0) {
      const segment = buffer.slice(cursor, end);
      const atEof = final && end === buffer.length;
      cursor = end;
      output += classify(segment, atEof);
    }
    return output;
  }

  return {
    push(text) {
      if (!text) return '';
      buffer += text;
      return drain(false);
    },
    flush() {
      let output = drain(true);
      if (pending) {
        // An unresolved trailing duplicate: a repeated full sentence at the
        // very end is model stutter; a short repeat is likely legitimate.
        if (pending.key.length >= DEDUP_MIN_SEGMENT_CHARS) skip(1);
        else output += pending.text;
        pending = null;
      }
      return output;
    },
    // Drop everything not yet emitted (used when the stream is cut early
    // because the model started repeating itself wholesale).
    discard() {
      cursor = buffer.length;
      pending = null;
    },
    removedCount() {
      return removed;
    },
  };
}

// Robust deduplication for buffered (non-streaming) responses
function deduplicateText(text) {
  if (!text || text.length < 60) return text;

  // An exactly doubled answer can lack whitespace after sentence punctuation
  // entirely (e.g. CJK text), where segment dedup never fires — catch the
  // anchored immediate repeat first.
  for (let blockLen = Math.floor(text.length * 0.3); blockLen <= Math.floor(text.length * 0.55); blockLen++) {
    const block = text.substring(0, blockLen);
    const rest = text.substring(blockLen);
    const checkLen = Math.min(100, Math.floor(block.length * 0.4));
    if (checkLen > 20 && rest.trimStart().startsWith(block.substring(0, checkLen).trimStart())) {
      console.log(`[search-middleware] Dedup: block repeat found at char ${blockLen}`);
      return text.substring(0, blockLen).trim();
    }
  }

  const deduper = createStreamDeduper();
  const output = deduper.push(text) + deduper.flush();
  if (deduper.removedCount() > 0) {
    console.log(`[search-middleware] Dedup: removed ${deduper.removedCount()} duplicate sentences`);
  }
  return output;
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
    let responseFinished = false;
    let downstreamClosed = false;
    let responseTimer = null;
    let idleTimer = null;
    let proxyReq = null;
    let proxyResRef = null;
    const requestController = new AbortController();

    res.once('finish', () => { responseFinished = true; });
    res.once('close', () => {
      if (responseFinished) return;
      downstreamClosed = true;
      requestController.abort();
      clearResponseTimers();
      clearKeepalive();
      if (proxyReq) {
        console.log('[search-middleware] Downstream disconnected; aborting upstream request');
        abortUpstream();
      }
    });

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
          armTotalTimer();
          const userText = extractUserText(rawContent);
          console.log(`[search-middleware] Extracted user text (${userText.length} chars)`);

          const query = detectSearchIntent(userText);

          // Extract URLs mentioned directly by the user
          const userUrls = extractUrls(userText);
          if (userUrls.length > 0) {
            console.log(`[search-middleware] User mentioned ${userUrls.length} URL(s)`);
          }

          if (query || userUrls.length > 0) {
            if (query) console.log('[search-middleware] Search detected');
            const enrichmentController = new AbortController();
            const abortEnrichment = () => enrichmentController.abort();
            requestController.signal.addEventListener('abort', abortEnrichment, { once: true });
            const enrichmentTimer = setTimeout(() => {
              console.log('[search-middleware] Enrichment deadline reached; using available snippets');
              enrichmentController.abort();
            }, ENRICHMENT_TIMEOUT_MS);
            try {
              // Fetch user-mentioned URLs directly via Playwright (in parallel with search)
              const [directResults, searchResponse] = await Promise.all([
                userUrls.length > 0 ? Promise.all(userUrls.slice(0, 3).map(async (url) => {
                  const content = await fetchPage(url, MAX_PAGE_CHARS_DIRECT, enrichmentController.signal);
                  return {
                    title: `Page: ${url}`,
                    url,
                    description: content
                      ? 'Directly fetched from user-provided URL'
                      : 'User-provided URL (live fetch returned no content this time)',
                    pageContent: content,
                  };
                })) : Promise.resolve([]),
                query
                  ? searchDDG(query, enrichmentController.signal).catch((error) => {
                      // A failed DDG search must not discard directly fetched
                      // user URLs — degrade to an empty result list instead.
                      if (error?.name !== 'AbortError') {
                        console.error('[search-middleware] DDG search unavailable, continuing without search results:', error.message);
                      }
                      return { web: { results: [] } };
                    })
                  : Promise.resolve({ web: { results: [] } }),
              ]);
              if (requestController.signal.aborted) return;

              const webResults = searchResponse?.web?.results || [];

              // Fetch content from search results via Playwright (skip URLs already fetched directly)
              const fetchedUrls = new Set(userUrls);
              const searchToFetch = webResults.filter(r => !fetchedUrls.has(r.url));

              const enrichedSearch = await Promise.all(searchToFetch.slice(0, 3).map(async (result) => {
                const content = await fetchPage(
                  result.url,
                  MAX_PAGE_CHARS_SEARCH,
                  enrichmentController.signal,
                );
                return { ...result, pageContent: content };
              }));
              if (requestController.signal.aborted) return;

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

                const fetchedCount = allResults.filter(r => r.pageContent).length;
                const guidance = fetchedCount > 0
                  ? 'IMPORTANT: Entries above that include "Page content" were fetched successfully using a real Chrome browser. Do NOT say you cannot access these sites. Use the page content to answer with specific details like prices, product names, and links. Always cite source URLs. Entries without page content could not be loaded this time — do not invent their contents.'
                  : 'NOTE: Live page loads returned no content this time; only the titles and snippets above are available. Use them if helpful, be transparent that fresh page content could not be retrieved, and do not invent details.';
                messages.splice(messages.length - 1, 0, {
                  role: 'system',
                  content: `${label}:\n\n${searchContext}\n\n${guidance}`
                });
                payload.messages = messages;
                body = JSON.stringify(payload);
                console.log(`[search-middleware] Injected ${usedResults} results (${allResults.filter(r => r.pageContent).length} with page content), context: ${searchContext.length} chars`);
              }
            } catch(e) {
              if (!requestController.signal.aborted) {
                console.error('[search-middleware] Search enrichment unavailable:', e.message);
              }
            } finally {
              clearTimeout(enrichmentTimer);
              requestController.signal.removeEventListener('abort', abortEnrichment);
            }
          } else {
            console.log(`[search-middleware] No search intent detected`);
          }
        }
      } catch(e) {
        console.error('[search-middleware] Parse error:', e.message);
      }
    }

    armTotalTimer();

    if (requestController.signal.aborted || downstreamClosed || res.destroyed) {
      clearKeepalive();
      return;
    }

    // Trim payload if too large to avoid E2BIG spawn error in cursor-api-proxy
    if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES && req.method === 'POST' && req.url.includes('/chat/completions')) {
      try {
        const payload = JSON.parse(body);
        const messages = payload.messages || [];
        const payloadBytes = () => Buffer.byteLength(JSON.stringify(payload));

        // Strip images again in case new ones appeared
        stripImages(messages);

        // Phase 1: Drop older conversation messages (keep first system + last 3)
        while (messages.length > 4 && payloadBytes() > MAX_PAYLOAD_BYTES) {
          messages.splice(1, 1);
        }
        // Phase 2: Truncate long content in all but the last message
        if (payloadBytes() > MAX_PAYLOAD_BYTES) {
          for (let i = 0; i < messages.length - 1; i++) {
            if (typeof messages[i].content === 'string' && messages[i].content.length > 1500) {
              messages[i].content = messages[i].content.substring(0, 1500) + '\n[...truncated]';
            }
          }
        }
        // Phase 3: If STILL too large, truncate the last message too
        if (payloadBytes() > MAX_PAYLOAD_BYTES) {
          const last = messages[messages.length - 1];
          if (typeof last.content === 'string' && last.content.length > 3000) {
            last.content = last.content.substring(0, 3000) + '\n[...truncated]';
          }
        }
        // Phase 4: Nuclear option — keep only system + last user message
        if (payloadBytes() > MAX_PAYLOAD_BYTES && messages.length > 2) {
          const first = messages[0];
          const last = messages[messages.length - 1];
          messages.length = 0;
          messages.push(first, last);
        }

        payload.messages = messages;
        body = JSON.stringify(payload);
        if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) {
          finishHttpError(413, 'Request remains too large after safe context trimming.', 'payload_too_large');
          return;
        }
        console.log(`[search-middleware] Trimmed payload to ${Buffer.byteLength(body)} bytes (${messages.length} messages)`);
      } catch(e) {
        console.error('[search-middleware] Payload trim error:', e.message);
      }
    }

    // Forward to cursor-api-proxy — stream SSE with sentence-level dedup.
    // Keep timeout and cancellation active until the response body finishes;
    // cursor-api-proxy sends headers before the Cursor child produces output.
    const isChat = req.method === 'POST' && req.url.includes('/chat/completions');

    function clearKeepalive() {
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
    }

    function clearResponseTimers() {
      if (responseTimer) clearTimeout(responseTimer);
      if (idleTimer) clearTimeout(idleTimer);
      responseTimer = null;
      idleTimer = null;
    }

    function abortUpstream() {
      if (proxyResRef && !proxyResRef.destroyed) proxyResRef.destroy();
      if (proxyReq && !proxyReq.destroyed) proxyReq.destroy();
    }

    function finishSseError(message, code = 'cursor_proxy_error') {
      if (responseFinished || downstreamClosed) return;
      responseFinished = true;
      clearResponseTimers();
      clearKeepalive();
      const event = JSON.stringify({ error: { message, code, type: 'api_error' } });
      res.end(`data: ${event}\n\ndata: [DONE]\n\n`);
    }

    function finishHttpError(statusCode, message, type) {
      if (responseFinished || downstreamClosed) return;
      responseFinished = true;
      clearResponseTimers();
      clearKeepalive();
      if (earlyHeaders) {
        const event = JSON.stringify({ error: { message, code: type, type: 'api_error' } });
        res.end(`data: ${event}\n\ndata: [DONE]\n\n`);
      } else if (!res.headersSent) {
        res.writeHead(statusCode, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message, type } }));
      } else {
        res.destroy();
      }
    }

    function timeoutResponse(kind) {
      if (responseFinished || downstreamClosed) return;
      const isIdle = kind === 'idle';
      const timeoutSeconds = Math.ceil(
        (isIdle ? RESPONSE_IDLE_TIMEOUT_MS : RESPONSE_TIMEOUT_MS) / 1000,
      );
      const message = isIdle
        ? `Cursor response produced no data for ${timeoutSeconds} seconds.`
        : `Cursor response timed out after ${timeoutSeconds} seconds.`;
      console.log(`[search-middleware] ${message} Aborting upstream request`);
      finishHttpError(504, `${message} Please try again.`, isIdle ? 'idle_timeout' : 'timeout');
      requestController.abort();
      abortUpstream();
    }

    function armTotalTimer() {
      if (!responseTimer) {
        responseTimer = setTimeout(() => timeoutResponse('total'), RESPONSE_TIMEOUT_MS);
      }
    }

    function armIdleTimer() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => timeoutResponse('idle'), RESPONSE_IDLE_TIMEOUT_MS);
    }

    proxyReq = http.request({
      hostname: '127.0.0.1',
      port: CURSOR_PROXY_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, 'content-length': Buffer.byteLength(body), host: `127.0.0.1:${CURSOR_PROXY_PORT}` },
    }, (proxyRes) => {
      proxyResRef = proxyRes;
      armIdleTimer();
      if (responseFinished || downstreamClosed) {
        proxyRes.destroy();
        return;
      }

      if (!isChat) {
        if (!earlyHeaders) res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.on('data', armIdleTimer);
        proxyRes.on('end', () => {
          responseFinished = true;
          clearResponseTimers();
          clearKeepalive();
        });
        proxyRes.on('error', (error) => {
          finishHttpError(502, `Cursor proxy response failed: ${error.message}`, 'upstream_error');
        });
        proxyRes.pipe(res);
        return;
      }

      const isSSE = proxyRes.headers['content-type']?.includes('text/event-stream');

      if (isSSE) {
        // Send headers if not sent early.
        if (!earlyHeaders) {
          const headers = { ...proxyRes.headers };
          delete headers['content-length'];
          headers['transfer-encoding'] = 'chunked';
          res.writeHead(proxyRes.statusCode, headers);
        }

        // Parse content deltas and pass them through the chunk-independent
        // deduper; emitted text is verbatim upstream text minus duplicates.
        let received = '';
        const deduper = createStreamDeduper({
          onSkip: () => console.log('[search-middleware] Streaming dedup: skipped duplicate sentence'),
        });
        let stopped = false;
        let sseLineBuf = '';
        // Decode across chunk boundaries — a TCP boundary can fall inside a
        // multibyte UTF-8 character.
        const sseDecoder = new StringDecoder('utf8');

        function emitDelta(text) {
          if (stopped || !text) return;
          const event = JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] });
          res.write(`data: ${event}\n\n`);
        }

        function finishSseSuccess() {
          if (stopped || responseFinished || downstreamClosed) return;
          if (!received.trim()) {
            stopped = true;
            finishSseError(
              'Cursor proxy returned an empty streaming response.',
              'invalid_upstream_response',
            );
            return;
          }
          emitDelta(deduper.flush());
          stopped = true;
          responseFinished = true;
          clearResponseTimers();
          clearKeepalive();
          res.end('data: [DONE]\n\n');
        }

        function handleUpstreamError(error) {
          if (stopped || responseFinished || downstreamClosed) return;
          emitDelta(deduper.flush());
          stopped = true;
          finishSseError(
            String(error?.message || 'Cursor CLI request failed.'),
            String(error?.code || 'cursor_cli_error'),
          );
        }

        proxyRes.on('data', (chunk) => {
          if (stopped) return;
          armIdleTimer();
          sseLineBuf += sseDecoder.write(chunk);

          let newlineIndex;
          while ((newlineIndex = sseLineBuf.indexOf('\n')) >= 0) {
            const line = sseLineBuf.substring(0, newlineIndex).trim();
            sseLineBuf = sseLineBuf.substring(newlineIndex + 1);
            if (!line || !line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.error) {
                handleUpstreamError(parsed.error);
                abortUpstream();
                return;
              }
              const delta = parsed.choices?.[0]?.delta?.content || '';
              if (delta) {
                received += delta;
                emitDelta(deduper.push(delta));
              }
            } catch (error) {
              console.log(`[search-middleware] Ignoring malformed upstream SSE frame: ${error.message}`);
            }
          }

          if (received.length > 300) {
            for (let blockLen = Math.floor(received.length * 0.3); blockLen <= Math.floor(received.length * 0.55); blockLen++) {
              const block = received.substring(0, blockLen);
              const rest = received.substring(blockLen);
              const checkLen = Math.min(100, Math.floor(block.length * 0.4));
              if (checkLen > 20 && rest.trimStart().startsWith(block.substring(0, checkLen).trimStart())) {
                console.log(`[search-middleware] Streaming dedup: block repeat at char ${blockLen}, stopping`);
                // The unemitted tail is mid-duplicate — flushing it would leak
                // a truncated fragment of the repeated copy.
                deduper.discard();
                finishSseSuccess();
                abortUpstream();
                return;
              }
            }
          }
        });

        proxyRes.on('end', finishSseSuccess);
        proxyRes.on('error', (error) => {
          handleUpstreamError({ message: `Cursor proxy response failed: ${error.message}`, code: 'upstream_error' });
        });
      } else {
        // Buffer JSON responses. A streaming caller can still receive a JSON
        // upstream error, so translate it into an SSE error event.
        const responseChunks = [];
        let responseData = '';
        proxyRes.on('data', (chunk) => {
          armIdleTimer();
          responseChunks.push(chunk);
        });
        proxyRes.on('end', () => {
          responseData = Buffer.concat(responseChunks).toString('utf8');
          let parsed;
          try {
            parsed = JSON.parse(responseData);
            const content = parsed.choices?.[0]?.message?.content || '';
            const deduped = deduplicateText(content);
            if (deduped.length < content.length) {
              console.log(`[search-middleware] Deduplicated JSON (${content.length} -> ${deduped.length} chars)`);
              parsed.choices[0].message.content = deduped;
              responseData = JSON.stringify(parsed);
            }
          } catch (error) {
            parsed = null;
          }

          const responseContent = parsed?.choices?.[0]?.message?.content;
          if (
            !earlyHeaders
            && proxyRes.statusCode >= 200
            && proxyRes.statusCode < 300
            && (typeof responseContent !== 'string' || !responseContent.trim())
          ) {
            finishHttpError(
              502,
              'Cursor proxy returned an empty or invalid response.',
              'invalid_upstream_response',
            );
            return;
          }

          if (earlyHeaders) {
            if (parsed?.error) {
              finishSseError(
                String(parsed.error.message || 'Cursor proxy request failed.'),
                String(parsed.error.code || parsed.error.type || 'cursor_proxy_error'),
              );
            } else if (parsed?.choices?.[0]?.message?.content) {
              const event = JSON.stringify({ choices: [{ index: 0, delta: { content: parsed.choices[0].message.content } }] });
              responseFinished = true;
              clearResponseTimers();
              clearKeepalive();
              res.end(`data: ${event}\n\ndata: [DONE]\n\n`);
            } else {
              finishSseError('Cursor proxy returned a non-streaming invalid response.', 'invalid_upstream_response');
            }
            return;
          }

          responseFinished = true;
          clearResponseTimers();
          clearKeepalive();
          const headers = { ...proxyRes.headers };
          delete headers['transfer-encoding'];
          headers['content-length'] = Buffer.byteLength(responseData);
          res.writeHead(proxyRes.statusCode, headers);
          res.end(responseData);
        });
        proxyRes.on('error', (error) => {
          finishHttpError(502, `Cursor proxy response failed: ${error.message}`, 'upstream_error');
        });
      }
    });

    proxyReq.on('error', (error) => {
      if (responseFinished || downstreamClosed) return;
      finishHttpError(502, `Cursor proxy request failed: ${error.message}`, 'proxy_error');
    });

    armIdleTimer();
    proxyReq.end(body);
  });
}

http.createServer(handleRequest).listen(PORT, '127.0.0.1', () => {
  console.log(`Search middleware listening on 127.0.0.1:${PORT} -> cursor-proxy:${CURSOR_PROXY_PORT} (WHATSAPP_READ_ONLY=${WHATSAPP_READ_ONLY})`);
});
