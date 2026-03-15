// Auto-approves pending node pairing requests.
// Stays connected to the gateway as "openclaw-control-ui" operator and listens for
// real-time node.pair.requested events. Also polls node.pair.list periodically.
const WebSocket = require('/usr/local/lib/node_modules/openclaw/node_modules/ws');
const crypto = require('crypto');
const fs = require('fs');

const GATEWAY_PORT = 18789;
const LIST_INTERVAL = 15000;  // poll every 15s as backup
const MAX_RUNTIME = 60 * 60 * 1000; // 1 hour

function getToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json', 'utf8'));
    return cfg.gateway?.auth?.token || '';
  } catch { return ''; }
}

function approveNode(ws, rid) {
  console.log(`[auto-approve] Approving: ${rid}`);
  ws.send(JSON.stringify({
    type: 'req', id: `approve-${Date.now()}`, method: 'node.pair.approve',
    params: { requestId: rid },
  }));
}

function startConnection() {
  const token = getToken();
  if (!token) { setTimeout(startConnection, 5000); return; }

  const ws = new WebSocket(`ws://127.0.0.1:${GATEWAY_PORT}/`, {
    handshakeTimeout: 5000,
    maxPayload: 25 * 1024 * 1024,
    headers: { 'Origin': `http://127.0.0.1:${GATEWAY_PORT}` },
  });

  let connected = false;
  let listInterval = null;
  let listCounter = 0;

  function listNodes() {
    if (ws.readyState !== WebSocket.OPEN) return;
    listCounter++;
    ws.send(JSON.stringify({
      type: 'req', id: `list-${listCounter}`, method: 'node.pair.list', params: {},
    }));
  }

  function handlePairList(payload) {
    // Log raw response for debugging (first time and every 30th poll)
    if (listCounter <= 2 || listCounter % 30 === 0) {
      console.log(`[auto-approve] node.pair.list raw: ${JSON.stringify(payload).substring(0, 500)}`);
    }

    // Try all possible shapes of the response
    const candidates = [];
    if (payload) {
      // Iterate all values looking for arrays of nodes
      for (const [key, val] of Object.entries(payload)) {
        if (Array.isArray(val)) {
          val.forEach(n => candidates.push({ ...n, _from: key }));
        }
      }
      // If payload itself is an array
      if (Array.isArray(payload)) {
        payload.forEach(n => candidates.push(n));
      }
    }

    const pending = candidates.filter(n =>
      n.status === 'pending' || n.state === 'pending' ||
      n.pairingState === 'pending' || n.paired === false
    );

    if (pending.length > 0) {
      console.log(`[auto-approve] Found ${pending.length} pending node(s) in list`);
      pending.forEach(p => {
        const rid = p.requestId || p.id || p.nodeId || p.deviceId;
        if (rid) approveNode(ws, rid);
      });
    }
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Step 1: connect.challenge -> send connect
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      ws.send(JSON.stringify({
        type: 'req',
        id: crypto.randomUUID(),
        method: 'connect',
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: 'openclaw-control-ui',
            version: '1.0.0',
            platform: 'linux',
            mode: 'ui',
          },
          role: 'operator',
          scopes: ['operator.read', 'operator.write', 'operator.pairing'],
          caps: [],
          locale: 'en-US',
          userAgent: 'openclaw-control-ui/1.0 (auto-approve)',
          auth: { token },
        },
      }));
      return;
    }

    // Step 2: hello-ok -> start listening + polling
    if (msg.type === 'res' && msg.ok && msg.payload?.type === 'hello-ok') {
      connected = true;
      console.log('[auto-approve] Connected and listening for pairing requests');
      // First list immediately
      listNodes();
      // Then poll periodically as backup
      listInterval = setInterval(listNodes, LIST_INTERVAL);
      return;
    }

    // Connect rejected
    if (msg.type === 'res' && !msg.ok && !connected) {
      console.log(`[auto-approve] Connect rejected: ${msg.error?.message || JSON.stringify(msg.error)}`);
      return;
    }

    // node.pair.list responses
    if (msg.type === 'res' && typeof msg.id === 'string' && msg.id.startsWith('list-')) {
      if (msg.ok) {
        handlePairList(msg.payload);
      }
      return;
    }

    // Approve responses
    if (msg.type === 'res' && typeof msg.id === 'string' && msg.id.startsWith('approve-')) {
      console.log(`[auto-approve] ${msg.ok ? 'APPROVED' : 'FAILED'}: ${msg.error?.message || 'ok'}`);
      return;
    }

    // === REAL-TIME EVENTS ===

    // Node pairing requested
    if (msg.type === 'event' && (
      msg.event === 'node.pair.requested' ||
      msg.event === 'node.pairing.requested' ||
      msg.event === 'device.pair.requested'
    )) {
      const rid = msg.payload?.requestId || msg.payload?.id || msg.payload?.nodeId;
      console.log(`[auto-approve] LIVE pairing event (${msg.event}): ${JSON.stringify(msg.payload).substring(0, 300)}`);
      if (rid) {
        approveNode(ws, rid);
      } else {
        // Unknown format — try listing to find it
        listNodes();
      }
      return;
    }

    // Log any other interesting events for debugging
    if (msg.type === 'event' && msg.event?.includes('pair')) {
      console.log(`[auto-approve] Pairing event: ${msg.event} ${JSON.stringify(msg.payload).substring(0, 200)}`);
    }
  });

  ws.on('error', (e) => {
    // Silently retry
  });

  ws.on('close', () => {
    connected = false;
    if (listInterval) clearInterval(listInterval);
    // Reconnect after 5 seconds
    console.log('[auto-approve] Disconnected, reconnecting in 5s...');
    setTimeout(startConnection, 5000);
  });
}

// Wait for gateway to be fully ready
setTimeout(() => {
  console.log('[auto-approve] Daemon started (persistent connection, 1h runtime)');
  startConnection();
  setTimeout(() => { process.exit(0); }, MAX_RUNTIME);
}, 8000);
