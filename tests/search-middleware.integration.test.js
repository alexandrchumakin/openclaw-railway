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
