const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');


const ROOT = path.resolve(__dirname, '..');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function startMiddleware(proxyPort, overrides = {}) {
  return new Promise(async (resolve, reject) => {
    const portServer = http.createServer();
    const middlewarePort = await listen(portServer);
    await close(portServer);

    const child = spawn(process.execPath, ['search-middleware.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        CURSOR_PROXY_PORT: String(proxyPort),
        SEARCH_MIDDLEWARE_PORT: String(middlewarePort),
        SEARCH_PROXY_PORT: '1',
        RESPONSE_TIMEOUT_MS: '2000',
        RESPONSE_IDLE_TIMEOUT_MS: '1000',
        ...overrides,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes('Search middleware listening')) {
        child.stdout.off('data', onData);
        resolve({ child, middlewarePort, output: () => output });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!output.includes('Search middleware listening')) {
        reject(new Error(`middleware exited with ${code}: ${output}`));
      }
    });
  });
}

function requestMiddleware(port, options = {}) {
  const { stream = true, content = 'hi' } = options;
  const body = JSON.stringify({
    model: 'claude-opus-4-8-thinking-max',
    stream,
    messages: [{ role: 'user', content }],
  });

  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (response) => {
      let responseBody = '';
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: responseBody,
      }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

function startAbortableRequest(port, content) {
  const body = JSON.stringify({
    model: 'claude-opus-4-8-thinking-max',
    stream: true,
    messages: [{ role: 'user', content }],
  });
  const request = http.request({
    hostname: '127.0.0.1',
    port,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
  });
  request.on('error', () => {});
  request.end(body);
  return request;
}

test('forwards upstream SSE errors instead of returning an empty success', async (t) => {
  const proxy = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"error":{"message":"synthetic failure","code":"cursor_cli_error"}}\n\ndata: [DONE]\n\n');
  });
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const middleware = await startMiddleware(proxyPort);
  t.after(() => middleware.child.kill('SIGTERM'));

  const response = await requestMiddleware(middleware.middlewarePort);

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /"error"/);
  assert.match(response.body, /synthetic failure/);
  assert.match(response.body, /cursor_cli_error/);
  assert.match(response.body, /data: \[DONE\]/);
});

test('idle timeout closes the stalled upstream response and reports an SSE error', async (t) => {
  let upstreamClosedResolve;
  const upstreamClosed = new Promise((resolve) => { upstreamClosedResolve = resolve; });
  const proxy = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    response.once('close', upstreamClosedResolve);
  });
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const middleware = await startMiddleware(proxyPort, {
    RESPONSE_IDLE_TIMEOUT_MS: '150',
    RESPONSE_TIMEOUT_MS: '2000',
  });
  t.after(() => middleware.child.kill('SIGTERM'));

  const response = await requestMiddleware(middleware.middlewarePort);

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /idle_timeout/);
  assert.match(response.body, /no data for 1 seconds/);
  await Promise.race([
    upstreamClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('upstream was not cancelled')), 1000)),
  ]);
});

test('empty upstream SSE is reported as an invalid response', async (t) => {
  const proxy = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: [DONE]\n\n');
  });
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const middleware = await startMiddleware(proxyPort);
  t.after(() => middleware.child.kill('SIGTERM'));

  const response = await requestMiddleware(middleware.middlewarePort);

  assert.match(response.body, /invalid_upstream_response/);
  assert.match(response.body, /empty streaming response/);
});

test('successful upstream SSE still emits content and DONE', async (t) => {
  const proxy = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"choices":[{"index":0,"delta":{"content":"HEALTH_OK"}}]}\n\ndata: [DONE]\n\n');
  });
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const middleware = await startMiddleware(proxyPort);
  t.after(() => middleware.child.kill('SIGTERM'));

  const response = await requestMiddleware(middleware.middlewarePort);

  assert.match(response.body, /HEALTH_OK/);
  assert.match(response.body, /data: \[DONE\]/);
  assert.doesNotMatch(response.body, /"error"/);
});

test('total timeout is reported before the outer OpenClaw budget', async (t) => {
  const proxy = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
  });
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const middleware = await startMiddleware(proxyPort, {
    RESPONSE_IDLE_TIMEOUT_MS: '2000',
    RESPONSE_TIMEOUT_MS: '150',
  });
  t.after(() => middleware.child.kill('SIGTERM'));

  const response = await requestMiddleware(middleware.middlewarePort);

  assert.match(response.body, /"code":"timeout"/);
  assert.match(response.body, /timed out after 1 seconds/);
});

test('total timeout includes search enrichment and cancels it before Cursor starts', async (t) => {
  let cursorRequests = 0;
  const proxy = http.createServer((request, response) => {
    cursorRequests += 1;
    request.resume();
    response.writeHead(500).end();
  });
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  let searchClosedResolve;
  const searchClosed = new Promise((resolve) => { searchClosedResolve = resolve; });
  const search = http.createServer((request, response) => {
    request.resume();
    response.once('close', searchClosedResolve);
  });
  const searchPort = await listen(search);
  t.after(() => close(search));

  const middleware = await startMiddleware(proxyPort, {
    SEARCH_PROXY_PORT: String(searchPort),
    ENRICHMENT_TIMEOUT_MS: '2000',
    RESPONSE_IDLE_TIMEOUT_MS: '2000',
    RESPONSE_TIMEOUT_MS: '150',
  });
  t.after(() => middleware.child.kill('SIGTERM'));

  const response = await requestMiddleware(middleware.middlewarePort, {
    content: 'what is the current weather?',
  });

  assert.match(response.body, /"code":"timeout"/);
  await Promise.race([
    searchClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('search was not cancelled')), 1000)),
  ]);
  assert.equal(cursorRequests, 0);
});

test('non-streaming response recomputes content-length after deduplication', async (t) => {
  const repeated = 'This is a sufficiently long sentence. '.repeat(4).trim();
  const upstreamBody = JSON.stringify({
    choices: [{ message: { role: 'assistant', content: repeated }, finish_reason: 'stop' }],
  });
  const proxy = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(upstreamBody),
    });
    response.end(upstreamBody);
  });
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const middleware = await startMiddleware(proxyPort);
  t.after(() => middleware.child.kill('SIGTERM'));

  const response = await requestMiddleware(middleware.middlewarePort, { stream: false });

  assert.equal(Number(response.headers['content-length']), Buffer.byteLength(response.body));
  assert.ok(response.body.length < upstreamBody.length);
});

test('non-streaming empty success is reported as an invalid upstream response', async (t) => {
  const upstreamBody = JSON.stringify({
    choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
  });
  const proxy = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(upstreamBody);
  });
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const middleware = await startMiddleware(proxyPort);
  t.after(() => middleware.child.kill('SIGTERM'));

  const response = await requestMiddleware(middleware.middlewarePort, { stream: false });

  assert.equal(response.statusCode, 502);
  assert.match(response.body, /invalid_upstream_response/);
  assert.match(response.body, /empty or invalid response/);
});

test('UTF-8 payload limit trims multibyte input before forwarding', async (t) => {
  let forwardedBytes = 0;
  const upstreamBody = JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'trimmed safely' }, finish_reason: 'stop' }],
  });
  const proxy = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      forwardedBytes = Buffer.concat(chunks).length;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(upstreamBody);
    });
  });
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const middleware = await startMiddleware(proxyPort);
  t.after(() => middleware.child.kill('SIGTERM'));

  const response = await requestMiddleware(middleware.middlewarePort, {
    stream: false,
    content: `translate ${'界'.repeat(70_000)}`,
  });

  assert.equal(response.statusCode, 200);
  assert.ok(forwardedBytes <= 80_000, `forwarded ${forwardedBytes} bytes`);
});

function extractStreamedText(sseBody) {
  return [...sseBody.matchAll(/^data: (\{.*\})$/gm)]
    .map((match) => {
      try { return JSON.parse(match[1]).choices?.[0]?.delta?.content || ''; } catch { return ''; }
    })
    .join('');
}

function sseFrame(content) {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
}

// Writes each piece as a separate delayed socket write so the middleware
// receives real chunk boundaries instead of one coalesced TCP segment.
function writeFramesSeparately(response, pieces, gapMs = 25) {
  let index = 0;
  const writeNext = () => {
    if (index < pieces.length) {
      response.write(pieces[index++]);
      setTimeout(writeNext, gapMs);
    } else {
      response.end('data: [DONE]\n\n');
    }
  };
  writeNext();
}

test('failed DDG search still injects directly fetched user URLs', async (t) => {
  let forwardedBody = '';
  const proxy = http.createServer((request, response) => {
    let chunks = '';
    request.on('data', (chunk) => { chunks += chunk; });
    request.on('end', () => {
      forwardedBody = chunks;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"choices":[{"index":0,"delta":{"content":"Вот свежие новости из nos.nl за сегодня."}}]}\n\ndata: [DONE]\n\n');
    });
  });
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const search = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/search') {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'DDG unavailable' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ url: url.searchParams.get('url'), content: 'LIVE NEWS BODY', length: 14 }));
  });
  const searchPort = await listen(search);
  t.after(() => close(search));

  const middleware = await startMiddleware(proxyPort, {
    SEARCH_PROXY_PORT: String(searchPort),
    RESPONSE_TIMEOUT_MS: '5000',
    RESPONSE_IDLE_TIMEOUT_MS: '5000',
  });
  t.after(() => middleware.child.kill('SIGTERM'));

  const response = await requestMiddleware(middleware.middlewarePort, {
    content: 'сводка новостей https://news.example.com/today',
  });

  assert.match(response.body, /свежие новости/);
  assert.ok(forwardedBody.includes('LIVE NEWS BODY'), 'directly fetched page content was not injected');
});

test('streaming dedup drops a repeated block after interstitial text without mangling URLs', async (t) => {
  const briefing = 'Погода — Weesp\n'
    + 'Свежую сводку сейчас подтянуть не вышло — не хочу давать цифры наугад.\n'
    + 'Быстрый просмотр: wttr.in/Weesp\n'
    + 'Новости\n'
    + 'Актуальные заголовки на этот раз недоступны. Напрямую: nos.nl\n';
  const note = 'Note: switching modes could help future briefings come through complete.\n';
  // Copy 1 is chunked mid-URL, copy 2 arrives whole — dedup must be identical
  // either way. Frames are written as separate delayed socket writes so the
  // chunk boundary actually reaches the middleware.
  const splitAt = briefing.indexOf('wttr.') + 'wttr.'.length;
  const deltas = [briefing.slice(0, splitAt), briefing.slice(splitAt), note, briefing];
  const proxy = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    writeFramesSeparately(response, deltas.map(sseFrame));
  });
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const middleware = await startMiddleware(proxyPort);
  t.after(() => middleware.child.kill('SIGTERM'));

  const response = await requestMiddleware(middleware.middlewarePort);
  const text = extractStreamedText(response.body);

  assert.ok(text.includes('wttr.in/Weesp'), 'URL must survive chunk boundaries intact');
  assert.ok(!text.includes('wttr. in'), 'no whitespace may be injected into a URL');
  const marker = 'Свежую сводку сейчас подтянуть не вышло';
  const first = text.indexOf(marker);
  assert.ok(first >= 0, 'first copy must be emitted');
  assert.equal(text.indexOf(marker, first + 1), -1, 'repeated block must be deduplicated');
  assert.ok(text.includes('Note: switching modes'), 'novel interstitial text must be kept');
});

test('non-duplicated streaming output is forwarded verbatim', async (t) => {
  const parts = ['Первая строка\nБыстрый просмотр: wttr.', 'in/Weesp\nВторая строка. Конец!'];
  const proxy = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    writeFramesSeparately(response, parts.map(sseFrame));
  });
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const middleware = await startMiddleware(proxyPort);
  t.after(() => middleware.child.kill('SIGTERM'));

  const response = await requestMiddleware(middleware.middlewarePort);

  assert.equal(extractStreamedText(response.body), parts.join(''));
});

test('legitimately repeated lines inside one response are preserved', async (t) => {
  const reply = 'Вот скрипт:\n'
    + '```\n'
    + 'print("----------------")\n'
    + 'print(header)\n'
    + 'print("----------------")\n'
    + '```\n'
    + 'Готово.';
  // Chunked awkwardly so segment boundaries never align with delta boundaries.
  const deltas = [];
  for (let i = 0; i < reply.length; i += 13) deltas.push(reply.slice(i, i + 13));
  const proxy = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    writeFramesSeparately(response, deltas.map(sseFrame), 5);
  });
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const middleware = await startMiddleware(proxyPort);
  t.after(() => middleware.child.kill('SIGTERM'));

  const response = await requestMiddleware(middleware.middlewarePort);

  assert.equal(extractStreamedText(response.body), reply);
});

test('a TCP boundary inside a multibyte character does not corrupt the stream', async (t) => {
  const content = 'Привет, это тест дедупликации в стриме.';
  const frame = Buffer.from(sseFrame(content), 'utf8');
  // Split on a UTF-8 continuation byte inside the Cyrillic payload.
  let splitAt = -1;
  for (let i = Math.floor(frame.length / 2); i < frame.length; i++) {
    if ((frame[i] & 0xc0) === 0x80) { splitAt = i; break; }
  }
  assert.ok(splitAt > 0, 'test setup: no multibyte character found');
  const proxy = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    writeFramesSeparately(response, [frame.subarray(0, splitAt), frame.subarray(splitAt)]);
  });
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const middleware = await startMiddleware(proxyPort);
  t.after(() => middleware.child.kill('SIGTERM'));

  const response = await requestMiddleware(middleware.middlewarePort);
  const text = extractStreamedText(response.body);

  assert.equal(text, content);
  assert.ok(!text.includes('�'), 'no replacement characters allowed');
});

test('disconnect during search cancels enrichment and never starts Cursor', async (t) => {
  let cursorRequests = 0;
  const proxy = http.createServer((request, response) => {
    cursorRequests += 1;
    request.resume();
    response.writeHead(500).end();
  });
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  let searchStartedResolve;
  const searchStarted = new Promise((resolve) => { searchStartedResolve = resolve; });
  let searchClosedResolve;
  const searchClosed = new Promise((resolve) => { searchClosedResolve = resolve; });
  const search = http.createServer((request, response) => {
    request.resume();
    searchStartedResolve();
    response.once('close', searchClosedResolve);
  });
  const searchPort = await listen(search);
  t.after(() => close(search));

  const middleware = await startMiddleware(proxyPort, {
    SEARCH_PROXY_PORT: String(searchPort),
    ENRICHMENT_TIMEOUT_MS: '2000',
  });
  t.after(() => middleware.child.kill('SIGTERM'));

  const request = startAbortableRequest(middleware.middlewarePort, 'what is the current weather?');
  await searchStarted;
  request.destroy();

  await Promise.race([
    searchClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('search request was not cancelled')), 1000)),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(cursorRequests, 0);
});
