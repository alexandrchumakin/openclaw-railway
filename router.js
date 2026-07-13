// Public HTTP/WebSocket entry point for OpenClaw.
const http = require('http');
const net = require('net');

const PORT = parseInt(process.env.PORT || '8080');
const OPENCLAW_PORT = parseInt(process.env.OPENCLAW_PORT || '18789');

function proxyHeaders(req) {
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost';
  return {
    ...req.headers,
    'x-forwarded-proto': 'https',
    'x-forwarded-host': publicDomain,
    'x-forwarded-for': clientIp || '127.0.0.1',
  };
}

const server = http.createServer((req, res) => {
  // WhatsApp QR code linking page
  if (req.url.startsWith('/wa-link')) {
    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: 9877,
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

  // Everything else -> OpenClaw
  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: OPENCLAW_PORT,
    path: req.url,
    method: req.method,
    headers: proxyHeaders(req),
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => { res.writeHead(502); res.end(e.message); });
  req.pipe(proxyReq);
});

// WebSocket upgrades -> OpenClaw (with debug logging for Android pairing)
server.on('upgrade', (req, socket, head) => {
  const ua = req.headers['user-agent'] || '';
  const isAndroid = ua.includes('okhttp');

  const proxy = net.createConnection(OPENCLAW_PORT, '127.0.0.1', () => {
    proxy.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      proxy.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i+1]}\r\n`);
    }
    // Inject proxy headers so OpenClaw knows this is a proxied HTTPS connection
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost';
    proxy.write(`X-Forwarded-Proto: https\r\n`);
    proxy.write(`X-Forwarded-Host: ${publicDomain}\r\n`);
    if (clientIp) proxy.write(`X-Forwarded-For: ${clientIp}\r\n`);
    proxy.write('\r\n');
    if (head.length) proxy.write(head);

    if (isAndroid) {
      // Log first WS messages for Android to debug pairing
      let proxyBuf = Buffer.alloc(0);
      let clientBuf = Buffer.alloc(0);
      let debugDone = false;
      const logOnce = (dir, chunk) => {
        if (debugDone) return;
        // After HTTP upgrade, WS frames are binary. Log first text frames.
        const str = chunk.toString('utf8', 0, Math.min(chunk.length, 2000));
        // Look for JSON in the frame data
        const jsonMatch = str.match(/\{[^]*\}/);
        if (jsonMatch) {
          console.log(`[ws-debug] ${dir}: ${jsonMatch[0].substring(0, 500)}`);
        }
      };
      proxy.on('data', (chunk) => { logOnce('GW->APP', chunk); socket.write(chunk); });
      socket.on('data', (chunk) => { logOnce('APP->GW', chunk); proxy.write(chunk); });
      setTimeout(() => { debugDone = true; }, 10000);
    } else {
      socket.pipe(proxy).pipe(socket);
    }
  });
  proxy.on('error', () => socket.end());
  socket.on('error', () => proxy.end());
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Router listening on 0.0.0.0:${PORT} -> OpenClaw:${OPENCLAW_PORT}`);
});
