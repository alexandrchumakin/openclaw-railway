#!/bin/sh
set -e

FIRST_BOOT_MARKER="/root/.openclaw/.initialized"

# Start search proxy (free DuckDuckGo-based web search)
node /opt/search-proxy.js &
echo "Search proxy started on port 9876"

# Start cursor-api-proxy in background (port 8765)
# Use custom workspace with .cursorrules to forbid WebFetch/Shell/WebSearch (they're sandboxed)
cd /opt/cursor-api-proxy
CURSOR_API_KEY="${CURSOR_API_KEY}" \
  CURSOR_BRIDGE_MODE="agent" \
  CURSOR_BRIDGE_WORKSPACE="/opt/agent-workspace" \
  CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE="false" \
  CURSOR_BRIDGE_FORCE="true" \
  CURSOR_BRIDGE_TIMEOUT_MS="180000" \
  npm start &
CURSOR_PID=$!
sleep 3
echo "Cursor API proxy started on port 8765"

# Start search-injecting middleware between OpenClaw and cursor-api-proxy
SEARCH_MIDDLEWARE_PORT=8766 node /opt/search-middleware.js &
sleep 1
echo "Search middleware started on port 8766"

# Only run full onboard on first boot (or when forced)
if [ ! -f "$FIRST_BOOT_MARKER" ] || [ -n "$FORCE_REINIT" ]; then
  echo "First boot — running onboard..."

  # Clean stale state
  rm -f /root/.openclaw/openclaw.json.bak
  rm -rf /root/.openclaw/cache

  openclaw onboard \
    --non-interactive \
    --accept-risk \
    --auth-choice custom-api-key \
    --custom-base-url "http://127.0.0.1:8766/v1" \
    --custom-api-key "unused" \
    --custom-provider-id "cursor-proxy" \
    --custom-model-id "claude-4.6-opus-max-thinking" \
    --custom-compatibility openai \
    --skip-channels \
    --skip-daemon \
    --skip-health \
    --skip-skills \
    --skip-ui \
    --skip-search 2>&1 || echo "Onboard completed"

  touch "$FIRST_BOOT_MARKER"
else
  echo "Existing install detected — skipping onboard, preserving sessions"
fi

# Migrate WhatsApp creds from old location to account subdirectory
if [ -f "/root/.openclaw/credentials/whatsapp/creds.json" ] && [ ! -f "/root/.openclaw/credentials/whatsapp/default/creds.json" ]; then
  echo "Migrating WhatsApp credentials to default account directory..."
  mkdir -p /root/.openclaw/credentials/whatsapp/default
  mv /root/.openclaw/credentials/whatsapp/*.json /root/.openclaw/credentials/whatsapp/default/ 2>/dev/null || true
fi

# Decode WhatsApp credentials from env var (set by wa-local-link.js)
if [ -n "$WHATSAPP_CREDS" ] && [ ! -f "/root/.openclaw/credentials/whatsapp/default/creds.json" ]; then
  echo "Decoding WhatsApp credentials from WHATSAPP_CREDS env var..."
  node -e "
    const bundle = JSON.parse(Buffer.from(process.env.WHATSAPP_CREDS, 'base64').toString());
    const fs = require('fs');
    const dir = '/root/.openclaw/credentials/whatsapp/default';
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(bundle)) {
      fs.writeFileSync(dir + '/' + name, content);
    }
    console.log('WhatsApp credentials written:', Object.keys(bundle).join(', '));
  "
fi

# Ensure WhatsApp plugin is installed (survives container rebuild)
if ! openclaw plugins list 2>/dev/null | grep -q whatsapp; then
  echo "Installing WhatsApp plugin..."
  openclaw plugins install @openclaw/whatsapp 2>&1 || echo "WhatsApp plugin install failed (will retry next boot)"
fi

# Always update SOUL.md and config settings (but preserve sessions/memory)
DOMAIN="${RAILWAY_PUBLIC_DOMAIN:-localhost}"
mkdir -p /root/.openclaw/workspace /root/.openclaw/agents/main/agent
sed "s/RAILWAY_DOMAIN/$DOMAIN/g" /opt/SOUL.md > /root/.openclaw/agents/main/agent/SOUL.md
cp /root/.openclaw/agents/main/agent/SOUL.md /root/.openclaw/workspace/SOUL.md

# Merge template config (preserves auth token and sessions)
node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json','utf8'));
const tpl = JSON.parse(fs.readFileSync('/opt/openclaw-template.json','utf8'));
cfg.gateway = {...(cfg.gateway||{}), ...tpl.gateway};
cfg.channels = tpl.channels;
if (cfg.models?.providers?.['cursor-proxy']) {
  const p = cfg.models.providers['cursor-proxy'];
  p.baseUrl = 'http://127.0.0.1:8766/v1';
  if (!p.models || !p.models.length) {
    p.models = [{ id: 'claude-4.6-opus-max-thinking', contextWindow: 200000, maxTokens: 16384 }];
  } else {
    for (const m of p.models) { m.contextWindow = 200000; m.maxTokens = 16384; delete m.timeoutMs; }
  }
  console.log('Model configs:', p.models.map(m => m.id + ':ctx=' + m.contextWindow).join(', '));
}
cfg.tools = { profile: 'minimal' };
fs.writeFileSync('/root/.openclaw/openclaw.json', JSON.stringify(cfg, null, 2));
console.log('Provider baseUrl:', cfg.models?.providers?.['cursor-proxy']?.baseUrl);
"

# Web search and page fetching are handled by the middleware layer (search-middleware.js + search-proxy.js)
# No need for Brave API key — middleware uses DuckDuckGo + Playwright Chrome browser

# Start openclaw gateway
openclaw gateway --port 18789 &
OPENCLAW_PID=$!

# Wait until gateway is actually listening
echo "Waiting for gateway to start..."
for i in $(seq 1 30); do
  if nc -z 127.0.0.1 18789 2>/dev/null; then
    echo "Gateway ready on port 18789"
    break
  fi
  sleep 1
done

# Extract the generated auth token
TOKEN=$(node -e "const c=JSON.parse(require('fs').readFileSync('/root/.openclaw/openclaw.json','utf8')); console.log(c.gateway?.auth?.token || 'no-token')")
DOMAIN="${RAILWAY_PUBLIC_DOMAIN:-localhost}"
echo "============================================"
echo "OPENCLAW AUTH TOKEN: $TOKEN"
echo "https://$DOMAIN/chat?session=main&token=$TOKEN"
echo "============================================"

# Start node auto-approve daemon (approves Android/remote node pairing requests)
node /opt/node-auto-approve.js &
echo "Node auto-approve daemon started"

# Start WhatsApp QR code web server (serves scannable QR at /wa-link?token=...)
node /opt/wa-link.js &
echo "WhatsApp link server started on port 9877"

# Start router (handles both OpenClaw + search proxy on $PORT)
node /opt/router.js &

# Wait for openclaw process
wait $OPENCLAW_PID
