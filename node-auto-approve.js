// Auto-approves pending node pairing requests.
// Follows the full OpenClaw gateway WebSocket protocol:
//   1. Connect to ws://127.0.0.1:18789/
//   2. Receive connect.challenge event
//   3. Send connect request (operator role, token auth, no device identity)
//   4. Receive hello-ok
//   5. Send node.pair.list, approve any pending nodes
// Requires dangerouslyDisableDeviceAuth: true in gateway config (skips device identity for operator).
const WebSocket = require('/usr/local/lib/node_modules/openclaw/node_modules/ws');
const crypto = require('crypto');
const fs = require('fs');

const GATEWAY_PORT = 18789;
const POLL_INTERVAL = 10000;
const MAX_RUNTIME = 15 * 60 * 1000; // 15 minutes

function getToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json', 'utf8'));
    return cfg.gateway?.auth?.token || '';
  } catch { return ''; }
}

function uuid() { return crypto.randomUUID(); }

function checkAndApprove() {
  const token = getToken();
  if (!token) { return; }

  const url = `ws://127.0.0.1:${GATEWAY_PORT}/`;
  const ws = new WebSocket(url, { handshakeTimeout: 5000, maxPayload: 25 * 1024 * 1024 });
  let done = false;
  let connected = false;

  const cleanup = () => { if (!done) { done = true; try { ws.close(); } catch {} } };
  setTimeout(cleanup, 12000);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Step 2: Receive connect.challenge, respond with connect request
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        const nonce = msg.payload?.nonce;
        const connectReq = {
          type: 'req',
          id: uuid(),
          method: 'connect',
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: 'auto-approve-daemon',
              version: '1.0.0',
              platform: 'linux',
              mode: 'operator'
            },
            role: 'operator',
            scopes: ['operator.read', 'operator.write'],
            caps: [],
            commands: [],
            permissions: {},
            locale: 'en-US',
            userAgent: 'auto-approve/1.0',
            auth: { token }
            // No device identity — relies on dangerouslyDisableDeviceAuth + localhost
          }
        };
        ws.send(JSON.stringify(connectReq));
        return;
      }

      // Step 4: Receive hello-ok, then list pending nodes
      if (msg.type === 'res' && msg.ok && msg.payload?.type === 'hello-ok') {
        connected = true;
        // List pending nodes
        ws.send(JSON.stringify({ type: 'req', id: 'list-1', method: 'node.pair.list', params: {} }));
        return;
      }

      // Connection rejected
      if (msg.type === 'res' && !msg.ok) {
        if (!connected) {
          // Connect failed — don't spam logs, just close
          cleanup();
          return;
        }
      }

      // Step 5: Handle node.pair.list response
      if (msg.type === 'res' && msg.id === 'list-1') {
        if (!msg.ok) {
          cleanup();
          return;
        }
        const result = msg.payload || {};
        const allNodes = result.pending || result.nodes || result.requests || [];
        const pending = Array.isArray(allNodes)
          ? allNodes.filter(n => n.status === 'pending' || n.state === 'pending')
          : [];

        if (pending.length > 0) {
          console.log(`[auto-approve] Found ${pending.length} pending node(s), approving...`);
          pending.forEach((p, i) => {
            const rid = p.requestId || p.id || p.nodeId;
            console.log(`[auto-approve] Approving node: ${rid}`);
            ws.send(JSON.stringify({
              type: 'req',
              id: `approve-${i}`,
              method: 'node.pair.approve',
              params: { requestId: rid }
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
        console.log(`[auto-approve] ${msg.ok ? 'SUCCESS' : 'FAILED'}: ${msg.error?.message || 'approved'}`);
      }

      // Also listen for real-time pairing events
      if (msg.type === 'event' && msg.event === 'node.pair.requested') {
        const rid = msg.payload?.requestId || msg.payload?.id;
        if (rid) {
          console.log(`[auto-approve] Real-time pairing request detected: ${rid}`);
          ws.send(JSON.stringify({
            type: 'req',
            id: `approve-rt-${rid}`,
            method: 'node.pair.approve',
            params: { requestId: rid }
          }));
        }
      }

    } catch (e) {
      // ignore parse errors
    }
  });

  ws.on('error', () => {});
  ws.on('close', () => { done = true; });
}

// Wait 5 seconds for gateway to be fully ready, then start polling
console.log('[auto-approve] Starting in 5s...');
setTimeout(() => {
  console.log('[auto-approve] Node auto-approve daemon started (polling every 10s for 15min)');
  checkAndApprove();
  const interval = setInterval(checkAndApprove, POLL_INTERVAL);
  setTimeout(() => {
    clearInterval(interval);
    console.log('[auto-approve] Max runtime reached, exiting');
    process.exit(0);
  }, MAX_RUNTIME);
}, 5000);
