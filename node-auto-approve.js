// Auto-approves pending node pairing requests every 5 seconds.
// Uses OpenClaw's own ws module to connect to the gateway as a local operator.
const WebSocket = require('/usr/local/lib/node_modules/openclaw/node_modules/ws');
const fs = require('fs');

const GATEWAY_PORT = 18789;
const POLL_INTERVAL = 5000;
const MAX_RUNTIME = 10 * 60 * 1000; // run for 10 minutes then exit

function getToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json', 'utf8'));
    return cfg.gateway?.auth?.token || '';
  } catch { return ''; }
}

function checkAndApprove() {
  const token = getToken();
  const url = `ws://127.0.0.1:${GATEWAY_PORT}/?token=${encodeURIComponent(token)}&role=operator`;

  const ws = new WebSocket(url, { handshakeTimeout: 5000 });
  let done = false;

  const cleanup = () => { if (!done) { done = true; try { ws.close(); } catch {} } };
  setTimeout(cleanup, 8000);

  ws.on('open', () => {
    ws.send(JSON.stringify({ method: 'node.pair.list', id: 1 }));
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.id === 1) {
        const pending = [];
        const result = msg.result || {};

        // Handle various response shapes
        const candidates = result.pending || result.nodes || result.requests || [];
        if (Array.isArray(candidates)) {
          candidates.forEach(n => {
            if (n.status === 'pending' || n.state === 'pending' || (!n.paired && !n.approved)) {
              pending.push(n);
            }
          });
        }

        if (pending.length > 0) {
          console.log(`[auto-approve] Found ${pending.length} pending node(s), approving...`);
          pending.forEach((p, i) => {
            const rid = p.requestId || p.id || p.nodeId;
            console.log(`[auto-approve] Approving node: ${rid}`);
            ws.send(JSON.stringify({ method: 'node.pair.approve', id: 100 + i, params: { requestId: rid } }));
          });
        }
        // Close after a short delay to receive approve responses
        setTimeout(cleanup, 2000);
      }

      if (msg.id >= 100) {
        const ok = !msg.error;
        console.log(`[auto-approve] Approve result: ${ok ? 'SUCCESS' : 'FAILED'} ${msg.error?.message || ''}`);
      }
    } catch (e) {
      console.error('[auto-approve] Parse error:', e.message);
    }
  });

  ws.on('error', () => {}); // Silently ignore connection errors
  ws.on('close', () => { done = true; });
}

console.log('[auto-approve] Node auto-approve daemon started (polling every 5s for 10min)');
checkAndApprove();
const interval = setInterval(checkAndApprove, POLL_INTERVAL);
setTimeout(() => {
  clearInterval(interval);
  console.log('[auto-approve] Max runtime reached, exiting');
  process.exit(0);
}, MAX_RUNTIME);
