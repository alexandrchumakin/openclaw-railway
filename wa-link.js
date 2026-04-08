// wa-link.js - WhatsApp QR Code Linking Server
// Serves a scannable QR code at /wa-link for WhatsApp linking
// Uses its own Baileys instance with a separate auth dir to avoid conflicting
// with OpenClaw's WhatsApp channel during the initial QR scan

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 9877;
// Use a separate auth dir so we don't conflict with OpenClaw's WhatsApp channel
// After linking, creds are copied to OpenClaw's expected location
const LINK_AUTH_DIR = '/tmp/wa-link-auth';
const OPENCLAW_AUTH_DIR = '/root/.openclaw/credentials/whatsapp';

let currentQR = null;
let linkStatus = 'initializing';
let reconnectCount = 0;
const MAX_RECONNECTS = 15;

function getAuthToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json', 'utf8'));
    return cfg.gateway?.auth?.token || '';
  } catch { return ''; }
}

function isLinked() {
  // Check both locations
  return fs.existsSync(path.join(OPENCLAW_AUTH_DIR, 'creds.json'))
      || fs.existsSync(path.join(LINK_AUTH_DIR, 'creds.json'));
}

function copyCreds() {
  // Copy credentials from link dir to OpenClaw's expected dir
  try {
    fs.mkdirSync(OPENCLAW_AUTH_DIR, { recursive: true });
    const files = fs.readdirSync(LINK_AUTH_DIR);
    for (const f of files) {
      fs.copyFileSync(path.join(LINK_AUTH_DIR, f), path.join(OPENCLAW_AUTH_DIR, f));
    }
    console.log(`[wa-link] Copied ${files.length} credential files to ${OPENCLAW_AUTH_DIR}`);
  } catch (e) {
    console.error('[wa-link] Failed to copy creds:', e.message);
  }
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

  // Auth check
  const token = getAuthToken();
  if (token && parsed.query.token !== token) {
    res.writeHead(401, { 'Content-Type': 'text/html' });
    res.end(html('Unauthorized', '<h1>401 Unauthorized</h1><p>Add <code>?token=YOUR_AUTH_TOKEN</code> to the URL</p><p style="color:#999">Find token in Deploy Logs: OPENCLAW AUTH TOKEN</p>'));
    return;
  }

  res.setHeader('Content-Type', 'text/html');

  // Already linked
  if (isLinked() && (linkStatus === 'connected' || linkStatus === 'initializing')) {
    res.writeHead(200);
    res.end(html('WhatsApp Linked', '<h1 style="color:#2d7d2d">WhatsApp Linked!</h1><p>Connection established. The gateway should pick up credentials automatically.</p>'));
    return;
  }

  // QR code ready
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

  // Error state
  if (linkStatus.startsWith('error')) {
    res.writeHead(200);
    res.end(html('Error', `<h1 style="color:#d32f2f">Error</h1><p>${linkStatus}</p><p>Check Deploy Logs for details. Redeploy to retry.</p>`));
    return;
  }

  // Waiting
  res.writeHead(200);
  res.end(html('Waiting...', `<h1>Waiting for QR code...</h1><p>Status: ${linkStatus}</p><p style="color:#888">Auto-refreshing...</p>`, 3));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[wa-link] QR server on port ${PORT} — visit /wa-link?token=AUTH_TOKEN`);
});

// If already linked, don't start Baileys
if (isLinked()) {
  linkStatus = 'connected';
  console.log('[wa-link] WhatsApp already linked');
} else {
  // Delay start to let the gateway initialize first
  setTimeout(() => startLinking(), 5000);
}

async function startLinking() {
  if (reconnectCount >= MAX_RECONNECTS) {
    linkStatus = 'error: too many reconnects — redeploy to retry';
    console.error('[wa-link] Max reconnects reached, giving up');
    return;
  }

  try {
    const baileys = require('/opt/node_modules/@whiskeysockets/baileys');
    const makeWASocket = baileys.default || baileys.makeWASocket;
    const { useMultiFileAuthState, DisconnectReason } = baileys;
    const pino = require('/opt/node_modules/pino');

    fs.mkdirSync(LINK_AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(LINK_AUTH_DIR);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'warn' }),
      browser: ['OpenClaw Bot', 'Chrome', '22.0'],
      connectTimeoutMs: 30000,
      qrTimeout: 60000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        linkStatus = 'qr_ready';
        reconnectCount = 0; // Reset on successful QR generation
        console.log('[wa-link] QR code ready — scan at /wa-link');
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const msg = lastDisconnect?.error?.message || 'unknown';
        console.log(`[wa-link] Disconnected: code=${code} reason=${msg}`);

        if (code === DisconnectReason?.loggedOut) {
          linkStatus = 'error: logged out — clear creds and redeploy';
          console.log('[wa-link] Logged out, not reconnecting');
          return;
        }

        reconnectCount++;
        const delay = Math.min(3000 * reconnectCount, 30000); // backoff up to 30s
        linkStatus = `reconnecting (${reconnectCount}/${MAX_RECONNECTS})`;
        console.log(`[wa-link] Reconnecting in ${delay}ms...`);
        setTimeout(startLinking, delay);
      } else if (connection === 'open') {
        currentQR = null;
        linkStatus = 'connected';
        reconnectCount = 0;
        console.log('[wa-link] WhatsApp linked successfully!');
        copyCreds();
      }
    });
  } catch (err) {
    linkStatus = 'error: ' + err.message;
    console.error('[wa-link] Error:', err.stack || err.message);
  }
}
