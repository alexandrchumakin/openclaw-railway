// wa-link.js - WhatsApp QR Code Linking Server
// Serves a scannable QR code at /wa-link for WhatsApp linking
// Needed because Railway has no remote shell and log viewer breaks terminal QR codes

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 9877;
const AUTH_DIR = '/root/.openclaw/credentials/whatsapp';

let currentQR = null;
let linkStatus = 'initializing';

function getAuthToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json', 'utf8'));
    return cfg.gateway?.auth?.token || '';
  } catch { return ''; }
}

function isLinked() {
  return fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
}

function html(title, body, refresh) {
  const meta = refresh ? `<meta http-equiv="refresh" content="${refresh}">` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${meta}<title>${title}</title></head>
<body style="font-family:-apple-system,sans-serif;text-align:center;padding:30px;background:#fafafa">${body}</body></html>`;
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (!parsed.pathname.startsWith('/wa-link')) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  // Auth check — require OpenClaw auth token
  const token = getAuthToken();
  if (token && parsed.query.token !== token) {
    res.writeHead(401, { 'Content-Type': 'text/html' });
    res.end(html('Unauthorized', '<h1>401 Unauthorized</h1><p>Add <code>?token=YOUR_AUTH_TOKEN</code> to the URL</p><p style="color:#999">Find token in Deploy Logs: OPENCLAW AUTH TOKEN</p>'));
    return;
  }

  res.setHeader('Content-Type', 'text/html');

  // Already linked
  if (isLinked() && linkStatus === 'connected') {
    res.writeHead(200);
    res.end(html('WhatsApp Linked', '<h1 style="color:#2d7d2d">WhatsApp Linked!</h1><p>Connection established successfully.</p><p>The gateway will use these credentials on next restart.</p>'));
    return;
  }

  // QR code ready — render as image
  if (currentQR) {
    try {
      const QRCode = require('/opt/node_modules/qrcode');
      const dataUrl = await QRCode.toDataURL(currentQR, { width: 400, margin: 2 });
      res.writeHead(200);
      res.end(html('Scan WhatsApp QR', `
        <h1>Scan with WhatsApp</h1>
        <p>Open WhatsApp &rarr; Settings &rarr; Linked Devices &rarr; Link a Device</p>
        <img src="${dataUrl}" style="max-width:400px;border:2px solid #ddd;border-radius:12px;margin:20px 0">
        <p style="color:#888">QR refreshes every ~20s. Page auto-refreshes.</p>
      `, 15));
    } catch (e) {
      res.writeHead(500);
      res.end('QR generation error: ' + e.message);
    }
    return;
  }

  // Waiting
  res.writeHead(200);
  res.end(html('Waiting...', `<h1>Waiting for QR code...</h1><p>Status: ${linkStatus}</p><p style="color:#888">Auto-refreshing...</p>`, 3));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[wa-link] QR server on port ${PORT} — visit /wa-link?token=AUTH_TOKEN`);
});

// If already linked, skip Baileys
if (isLinked()) {
  linkStatus = 'connected';
  console.log('[wa-link] WhatsApp already linked');
} else {
  startLinking();
}

async function startLinking() {
  try {
    const baileys = require('/opt/node_modules/@whiskeysockets/baileys');
    const makeWASocket = baileys.default || baileys.makeWASocket;
    const { useMultiFileAuthState, DisconnectReason } = baileys;
    const pino = require('/opt/node_modules/pino');

    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        linkStatus = 'qr_ready';
        console.log('[wa-link] QR code ready — scan at /wa-link');
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code !== DisconnectReason?.loggedOut) {
          linkStatus = 'reconnecting';
          console.log('[wa-link] Reconnecting...');
          setTimeout(startLinking, 3000);
        } else {
          linkStatus = 'logged_out';
          console.log('[wa-link] Logged out');
        }
      } else if (connection === 'open') {
        currentQR = null;
        linkStatus = 'connected';
        console.log('[wa-link] WhatsApp linked successfully!');
      }
    });
  } catch (err) {
    linkStatus = 'error: ' + err.message;
    console.error('[wa-link] Error:', err.message);
  }
}
