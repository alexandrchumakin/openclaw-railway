#!/bin/sh
set -e

# Clean any cached/stale state
rm -rf /root/.openclaw/agents/main/sessions/*
rm -f /root/.openclaw/openclaw.json.bak
rm -rf /root/.openclaw/cache

# Start search proxy (free DuckDuckGo-based web search)
node /opt/search-proxy.js &
echo "Search proxy started on port 9876"

# Start cursor-api-proxy in background (port 8765)
cd /opt/cursor-api-proxy
CURSOR_API_KEY="${CURSOR_API_KEY}" npm start &
CURSOR_PID=$!
sleep 3
echo "Cursor API proxy started on port 8765"

# Run onboard to register cursor proxy as custom provider
openclaw onboard \
  --non-interactive \
  --accept-risk \
  --auth-choice custom-api-key \
  --custom-base-url "http://127.0.0.1:8765/v1" \
  --custom-api-key "unused" \
  --custom-provider-id "cursor-proxy" \
  --custom-model-id "claude-sonnet-4" \
  --custom-compatibility openai \
  --skip-channels \
  --skip-daemon \
  --skip-health \
  --skip-skills \
  --skip-ui \
  --skip-search 2>&1 || echo "Onboard completed"

# Merge our template config and fix context window
node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json','utf8'));
const tpl = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw-template.json','utf8'));
cfg.gateway = {...(cfg.gateway||{}), ...tpl.gateway};
cfg.channels = tpl.channels;
// Fix context window and tools profile
if (cfg.models?.providers?.['cursor-proxy']?.models?.[0]) {
  cfg.models.providers['cursor-proxy'].models[0].contextWindow = 200000;
  cfg.models.providers['cursor-proxy'].models[0].maxTokens = 16384;
}
cfg.tools = { profile: 'full' };
fs.writeFileSync('/root/.openclaw/openclaw.json', JSON.stringify(cfg, null, 2));
"

# Set fake Brave API key so OpenClaw enables web_search tool
# Our search proxy on port 9876 mimics the Brave API
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

# Now start socat proxy (gateway is confirmed ready)
socat TCP-LISTEN:${PORT:-8080},fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:18789 &

# Wait for openclaw process
wait $OPENCLAW_PID
