// wa-link.js - WhatsApp status page
// Shows linking status at /wa-link. QR scanning is done locally via wa-local-link.js
// because WhatsApp blocks WebSocket connections from cloud provider IPs.

const http = require('http');
const fs = require('fs');
const url = require('url');

const PORT = 9877;
const CREDS_PATH = '/root/.openclaw/credentials/whatsapp/default/creds.json';

function getAuthToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json', 'utf8'));
    return cfg.gateway?.auth?.token || '';
  } catch { return ''; }
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  if (!parsed.pathname.startsWith('/wa-link')) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const token = getAuthToken();
  if (token && parsed.query.token !== token) {
    res.writeHead(401, { 'Content-Type': 'text/html' });
    res.end('<html><body style="font-family:sans-serif;text-align:center;padding:50px"><h1>401</h1><p>Add ?token=AUTH_TOKEN</p></body></html>');
    return;
  }

  const linked = fs.existsSync(CREDS_PATH);
  res.writeHead(200, { 'Content-Type': 'text/html' });

  if (linked) {
    res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#f0fff0">
      <h1 style="color:#2d7d2d">WhatsApp Linked</h1>
      <p>Credentials found. The gateway should be connected.</p>
    </body></html>`);
  } else {
    res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:30px;max-width:600px;margin:0 auto">
      <h1>WhatsApp Not Linked</h1>
      <p>WhatsApp blocks connections from cloud IPs, so QR scanning must be done locally.</p>
      <h2>Setup Steps</h2>
      <ol style="text-align:left">
        <li>On your local machine, in the project directory:<br><code>npm install @whiskeysockets/baileys pino</code></li>
        <li>Run: <code>node wa-local-link.js</code></li>
        <li>Scan the QR code with WhatsApp</li>
        <li>Copy the base64 output</li>
        <li>In Railway dashboard &rarr; Variables &rarr; add:<br><code>WHATSAPP_CREDS = &lt;paste base64&gt;</code></li>
        <li>Railway auto-redeploys with credentials</li>
      </ol>
    </body></html>`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const linked = fs.existsSync(CREDS_PATH);
  console.log(`[wa-link] Status page on port ${PORT} — ${linked ? 'WhatsApp linked' : 'not linked yet'}`);
});
