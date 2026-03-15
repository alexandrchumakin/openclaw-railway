// Auto-approves pending node pairing requests.
// Connects to the gateway as "openclaw-control-ui" operator (localhost + dangerouslyDisableDeviceAuth).
// Protocol: receive connect.challenge -> send connect -> receive hello-ok -> node.pair.list -> approve.
const WebSocket = require('/usr/local/lib/node_modules/openclaw/node_modules/ws');
const crypto = require('crypto');
const fs = require('fs');

const GATEWAY_PORT = 18789;
const POLL_INTERVAL = 10000;
const MAX_RUNTIME = 30 * 60 * 1000; // 30 minutes

function getToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json', 'utf8'));
    return cfg.gateway?.auth?.token || '';
  } catch { return ''; }
}

function checkAndApprove() {
  const token = getToken();
  if (!token) return;

  const ws = new WebSocket(`ws://127.0.0.1:${GATEWAY_PORT}/`, {
    handshakeTimeout: 3000,
    maxPayload: 25 * 1024 * 1024,
    headers: { 'Origin': `http://127.0.0.1:${GATEWAY_PORT}` },
  });

  let done = false;
  let connected = false;
  const cleanup = () => { if (!done) { done = true; try { ws.close(); } catch {} } };
  setTimeout(cleanup, 15000);

  ws.on('open', () => {
    // Gateway sends connect.challenge immediately — handled in 'message'
  });

  ws.on('message', (raw) => {
    if (done) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Step 1: Receive connect.challenge, send connect request
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      const connectReq = {
        type: 'req',
        id: crypto.randomUUID(),
        method: 'connect',
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: 'openclaw-control-ui',   // Must match GATEWAY_CLIENT_IDS.CONTROL_UI
            version: '1.0.0',
            platform: 'linux',
            mode: 'ui',                  // Must match GATEWAY_CLIENT_MODES.UI
          },
          role: 'operator',
          scopes: ['operator.read', 'operator.write', 'operator.pairing'],
          caps: [],
          locale: 'en-US',
          userAgent: 'openclaw-control-ui/1.0 (auto-approve)',
          auth: { token },
          // No device identity — relies on dangerouslyDisableDeviceAuth + localhost
        },
      };
      ws.send(JSON.stringify(connectReq));
      return;
    }

    // Step 2: hello-ok -> list nodes
    if (msg.type === 'res' && msg.ok && msg.payload?.type === 'hello-ok') {
      connected = true;
      console.log('[auto-approve] Connected to gateway, listing nodes...');
      ws.send(JSON.stringify({
        type: 'req', id: 'list-1', method: 'node.pair.list', params: {},
      }));
      return;
    }

    // Connect rejected
    if (msg.type === 'res' && !msg.ok && !connected) {
      const err = msg.error?.message || msg.error?.code || 'unknown';
      console.log(`[auto-approve] Connect rejected: ${err}`);
      cleanup();
      return;
    }

    // Step 3: Handle node list
    if (msg.type === 'res' && msg.id === 'list-1') {
      if (!msg.ok) {
        console.log('[auto-approve] node.pair.list failed:', msg.error?.message);
        cleanup();
        return;
      }
      const result = msg.payload || {};
      const allNodes = result.pending || result.nodes || result.requests || [];
      const pending = Array.isArray(allNodes)
        ? allNodes.filter(n => n.status === 'pending' || n.state === 'pending')
        : [];

      if (pending.length > 0) {
        console.log(`[auto-approve] Found ${pending.length} pending node(s)`);
        pending.forEach((p, i) => {
          const rid = p.requestId || p.id || p.nodeId;
          console.log(`[auto-approve] Approving: ${rid}`);
          ws.send(JSON.stringify({
            type: 'req', id: `approve-${i}`, method: 'node.pair.approve',
            params: { requestId: rid },
          }));
        });
        setTimeout(cleanup, 3000);
      } else {
        cleanup();
      }
      return;
    }

    // Approve responses
    if (msg.type === 'res' && typeof msg.id === 'string' && msg.id.startsWith('approve-')) {
      console.log(`[auto-approve] ${msg.ok ? 'APPROVED' : 'FAILED'}: ${msg.error?.message || 'ok'}`);
    }

    // Real-time pairing events
    if (msg.type === 'event' && msg.event === 'node.pair.requested') {
      const rid = msg.payload?.requestId || msg.payload?.id;
      if (rid) {
        console.log(`[auto-approve] Live pairing request: ${rid}`);
        ws.send(JSON.stringify({
          type: 'req', id: `approve-live-${Date.now()}`, method: 'node.pair.approve',
          params: { requestId: rid },
        }));
      }
    }
  });

  ws.on('error', () => {});
  ws.on('close', () => { done = true; });
}

// Wait for gateway to be fully ready
setTimeout(() => {
  console.log('[auto-approve] Daemon started (every 10s, 30min)');
  checkAndApprove();
  const interval = setInterval(checkAndApprove, POLL_INTERVAL);
  setTimeout(() => { clearInterval(interval); process.exit(0); }, MAX_RUNTIME);
}, 8000);
