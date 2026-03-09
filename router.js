// Routes incoming requests: /search -> search proxy, everything else -> openclaw
const http = require('http');
const net = require('net');

const PORT = parseInt(process.env.PORT || '8080');
const OPENCLAW_PORT = 18789;
const SEARCH_PORT = 9876;

const server = http.createServer((req, res) => {
  const target = req.url.startsWith('/search') ? SEARCH_PORT : OPENCLAW_PORT;
  const proxy = http.request({
    hostname: '127.0.0.1',
    port: target,
    path: req.url,
    method: req.method,
    headers: req.headers,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxy.on('error', (e) => {
    res.writeHead(502);
    res.end('Bad Gateway: ' + e.message);
  });
  req.pipe(proxy);
});

// Handle WebSocket upgrades (for OpenClaw dashboard)
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
