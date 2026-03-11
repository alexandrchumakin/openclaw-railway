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
  CURSOR_BRIDGE_WORKSPACE="/opt/agent-workspace" \
  CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE="false" \
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
    --custom-model-id "claude-4.6-opus-thinking" \
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
  cfg.models.providers['cursor-proxy'].baseUrl = 'http://127.0.0.1:8766/v1';
  if (cfg.models.providers['cursor-proxy'].models?.[0]) {
    cfg.models.providers['cursor-proxy'].models[0].contextWindow = 200000;
    cfg.models.providers['cursor-proxy'].models[0].maxTokens = 16384;
  }
}
cfg.tools = { profile: 'full' };
fs.writeFileSync('/root/.openclaw/openclaw.json', JSON.stringify(cfg, null, 2));
console.log('Provider baseUrl:', cfg.models?.providers?.['cursor-proxy']?.baseUrl);
"

# Set fake Brave API key so OpenClaw enables web_search tool
export BRAVE_API_KEY="free-local-proxy"
export BRAVE_SEARCH_BASE_URL="http://127.0.0.1:9876"

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

# Start router (handles both OpenClaw + search proxy on $PORT)
node /opt/router.js &

# Wait for openclaw process
wait $OPENCLAW_PID
