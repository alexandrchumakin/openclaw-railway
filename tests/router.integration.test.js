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

function request(port, requestPath, method = 'GET', body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: body ? { 'content-length': Buffer.byteLength(body) } : {},
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: responseBody }));
    });
    req.once('error', reject);
    req.end(body);
  });
}

async function startRouter(openClawPort) {
  const portServer = http.createServer();
  const routerPort = await listen(portServer);
  await close(portServer);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['router.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(routerPort),
        OPENCLAW_PORT: String(openClawPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes('Router listening')) resolve({ child, routerPort });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!output.includes('Router listening')) reject(new Error(`router exited ${code}: ${output}`));
    });
  });
}

test('public completion and fetch paths stay behind the OpenClaw gateway', async (t) => {
  const received = [];
  const gateway = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ method: req.method, path: req.url, body });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('gateway');
    });
  });
  const gatewayPort = await listen(gateway);
  t.after(() => close(gateway));

  const router = await startRouter(gatewayPort);
  t.after(() => router.child.kill('SIGTERM'));

  const completionBody = JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] });
  const completion = await request(
    router.routerPort,
    '/v1/chat/completions',
    'POST',
    completionBody,
  );
  const fetch = await request(router.routerPort, '/fetch?url=http://127.0.0.1/private');

  assert.equal(completion.statusCode, 200);
  assert.equal(completion.body, 'gateway');
  assert.equal(fetch.statusCode, 200);
  assert.equal(fetch.body, 'gateway');
  assert.deepEqual(received, [
    { method: 'POST', path: '/v1/chat/completions', body: completionBody },
    { method: 'GET', path: '/fetch?url=http://127.0.0.1/private', body: '' },
  ]);
});
