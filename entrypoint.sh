#!/bin/sh
set -e

FIRST_BOOT_MARKER="/root/.openclaw/.initialized"
CHROME_REMOTE_DEBUG_PORT="9222"
CHROME_REMOTE_DEBUG_URL="http://127.0.0.1:${CHROME_REMOTE_DEBUG_PORT}"
PRIMARY_MODEL_ID="claude-opus-4-8-thinking-max"
export CHROME_REMOTE_DEBUG_URL PRIMARY_MODEL_ID

wait_for_port() {
  service_name="$1"
  port="$2"
  attempts="${3:-30}"
  for _ in $(seq 1 "$attempts"); do
    if nc -z 127.0.0.1 "$port" 2>/dev/null; then
      echo "$service_name ready on port $port"
      return 0
    fi
    sleep 1
  done
  echo "$service_name failed to listen on port $port after ${attempts}s" >&2
  return 1
}

shutdown() {
  trap - HUP INT TERM
  echo "Stopping OpenClaw service processes..."
  for pid in \
    ${ROUTER_PID:-} \
    ${NODE_APPROVE_PID:-} \
    ${WA_LINK_PID:-} \
    ${OPENCLAW_PID:-} \
    ${MIDDLEWARE_PID:-} \
    ${CURSOR_PID:-} \
    ${SEARCH_PROXY_PID:-} \
    ${CHROME_PID:-}
  do
    kill -TERM "$pid" 2>/dev/null || true
  done
  for pid in \
    ${ROUTER_PID:-} \
    ${NODE_APPROVE_PID:-} \
    ${WA_LINK_PID:-} \
    ${OPENCLAW_PID:-} \
    ${MIDDLEWARE_PID:-} \
    ${CURSOR_PID:-} \
    ${SEARCH_PROXY_PID:-} \
    ${CHROME_PID:-}
  do
    wait "$pid" 2>/dev/null || true
  done
  exit 0
}
trap shutdown HUP INT TERM

resolve_chrome_bin() {
  if command -v google-chrome >/dev/null 2>&1; then command -v google-chrome; return 0; fi
  if command -v google-chrome-stable >/dev/null 2>&1; then command -v google-chrome-stable; return 0; fi
  if command -v chromium >/dev/null 2>&1; then command -v chromium; return 0; fi
  if command -v chromium-browser >/dev/null 2>&1; then command -v chromium-browser; return 0; fi
  for candidate in /root/.cache/ms-playwright/chromium-*/chrome-linux*/chrome; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

# OpenClaw beta may migrate persistent state on first start. Keep one verified
# pre-upgrade archive on the mounted volume as the rollback boundary.
MIGRATION_BACKUP_DIR="/root/.openclaw/migration-backups/opus48"
MIGRATION_BACKUP_FILE="$MIGRATION_BACKUP_DIR/pre-upgrade.tar.gz"
if [ -f "$FIRST_BOOT_MARKER" ] && [ ! -f "$MIGRATION_BACKUP_FILE" ]; then
  mkdir -p "$MIGRATION_BACKUP_DIR"
  chmod 700 "$MIGRATION_BACKUP_DIR"
  rm -f /tmp/openclaw-pre-opus48.tar.gz
  env \
    -u CURSOR_API_KEY \
    -u TELEGRAM_BOT_TOKEN \
    -u GCALCLI_OAUTH_BASE64 \
    -u GCALCLI_OAUTH_JSON \
    -u WHATSAPP_CREDS \
    openclaw backup create \
    --output /tmp/openclaw-pre-opus48.tar.gz \
    --verify
  mv /tmp/openclaw-pre-opus48.tar.gz "$MIGRATION_BACKUP_FILE"
  chmod 600 "$MIGRATION_BACKUP_FILE"
  echo "Verified pre-Opus-4.8 migration backup created"
fi

# Validate/import Calendar state before any agent-capable process starts, then
# re-exec PID 1 without the raw Railway credential so /proc/1/environ cannot
# expose it to a later agent command.
if [ "${_OPENCLAW_GCALCLI_PREPARED:-}" != "1" ]; then
  /usr/local/libexec/prepare-gcalcli-credentials
  exec env \
    -u GCALCLI_OAUTH_BASE64 \
    -u GCALCLI_OAUTH_JSON \
    _OPENCLAW_GCALCLI_PREPARED=1 \
    /entrypoint.sh
fi

start_chrome() {
  mkdir -p /tmp/chrome-remote-debug-profile
  env \
    -u CURSOR_API_KEY \
    -u TELEGRAM_BOT_TOKEN \
    -u GCALCLI_OAUTH_BASE64 \
    -u GCALCLI_OAUTH_JSON \
    -u WHATSAPP_CREDS \
    "$CHROME_BIN" \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="$CHROME_REMOTE_DEBUG_PORT" \
    --user-data-dir=/tmp/chrome-remote-debug-profile \
    --no-first-run \
    --no-default-browser-check \
    --disable-dev-shm-usage \
    --disable-gpu \
    --disable-blink-features=AutomationControlled \
    --no-sandbox \
    --headless=new \
    about:blank >/tmp/chrome-remote-debug.log 2>&1 &
  CHROME_PID=$!
  for _ in $(seq 1 20); do
    if nc -z 127.0.0.1 "$CHROME_REMOTE_DEBUG_PORT" 2>/dev/null; then
      echo "Chrome remote debugging ready at ${CHROME_REMOTE_DEBUG_URL}"
      break
    fi
    sleep 1
  done
  if ! nc -z 127.0.0.1 "$CHROME_REMOTE_DEBUG_PORT" 2>/dev/null; then
    echo "Chrome remote debugging failed; search-proxy will fall back to local Playwright launch"
    return 1
  fi
  if curl -fsS --max-time 10 "${CHROME_REMOTE_DEBUG_URL}/json/version" >/dev/null 2>&1; then
    echo "Chrome CDP endpoint is healthy: ${CHROME_REMOTE_DEBUG_URL}/json/version"
  else
    echo "Chrome TCP port is open but CDP endpoint check failed: ${CHROME_REMOTE_DEBUG_URL}/json/version"
  fi
}

CHROME_BIN="$(resolve_chrome_bin || true)"
if [ -n "$CHROME_BIN" ]; then
  start_chrome || echo "Continuing without Chrome CDP"
else
  echo "Chrome binary not found; search-proxy will fall back to local Playwright launch"
fi

# Start search proxy (free DuckDuckGo-based web search)
env \
  -u CURSOR_API_KEY \
  -u TELEGRAM_BOT_TOKEN \
  -u GCALCLI_OAUTH_BASE64 \
  -u GCALCLI_OAUTH_JSON \
  -u WHATSAPP_CREDS \
  node /opt/search-proxy.js &
SEARCH_PROXY_PID=$!
echo "Search proxy started on port 9876"
wait_for_port "Search proxy" 9876 60

# Start cursor-api-proxy in background (port 8765)
# Use custom workspace rules to block web tools while allowing local runtime tools (calendar, etc.)
cd /opt/cursor-api-proxy
env \
  -u TELEGRAM_BOT_TOKEN \
  -u GCALCLI_OAUTH_BASE64 \
  -u GCALCLI_OAUTH_JSON \
  -u WHATSAPP_CREDS \
  CURSOR_API_KEY="${CURSOR_API_KEY}" \
  CURSOR_BRIDGE_WORKSPACE="/opt/agent-workspace" \
  CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE="false" \
  CURSOR_BRIDGE_FORCE="true" \
  CURSOR_BRIDGE_APPROVE_MCPS="true" \
  CURSOR_BRIDGE_PROMPT_VIA_STDIN="true" \
  CURSOR_BRIDGE_TIMEOUT_MS="420000" \
  CURSOR_BRIDGE_MODE="agent" \
  CURSOR_BRIDGE_CONTEXT_PREAMBLE="false" \
  npm start &
CURSOR_PID=$!
echo "Cursor API proxy started on port 8765"
wait_for_port "Cursor API proxy" 8765 30

cursor_model_available() {
  curl -fsS --max-time 70 http://127.0.0.1:8765/v1/models | node -e "
let body = '';
process.stdin.on('data', chunk => body += chunk);
process.stdin.on('end', () => {
  let payload;
  try { payload = JSON.parse(body); } catch { process.exit(1); }
  const modelId = process.env.PRIMARY_MODEL_ID;
  const available = Array.isArray(payload.data) && payload.data.some(model => model.id === modelId);
  process.exit(available ? 0 : 1);
});
"
}

MODEL_PREFLIGHT_ATTEMPT=1
while ! cursor_model_available; do
  if [ "$MODEL_PREFLIGHT_ATTEMPT" -ge 3 ]; then
    echo "Cursor model preflight failed after $MODEL_PREFLIGHT_ATTEMPT attempts: $PRIMARY_MODEL_ID" >&2
    exit 1
  fi
  echo "Cursor model preflight attempt $MODEL_PREFLIGHT_ATTEMPT failed; retrying in 5s" >&2
  MODEL_PREFLIGHT_ATTEMPT=$((MODEL_PREFLIGHT_ATTEMPT + 1))
  sleep 5
done
echo "Required Cursor model is available: $PRIMARY_MODEL_ID"

# Start search-injecting middleware between OpenClaw and cursor-api-proxy
env \
  -u CURSOR_API_KEY \
  -u TELEGRAM_BOT_TOKEN \
  -u GCALCLI_OAUTH_BASE64 \
  -u GCALCLI_OAUTH_JSON \
  -u WHATSAPP_CREDS \
  SEARCH_MIDDLEWARE_PORT=8766 node /opt/search-middleware.js &
MIDDLEWARE_PID=$!
echo "Search middleware started on port 8766"
wait_for_port "Search middleware" 8766 30

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
    --custom-model-id "$PRIMARY_MODEL_ID" \
    --custom-compatibility openai \
    --skip-channels \
    --skip-daemon \
    --skip-health \
    --skip-skills \
    --skip-ui \
    --skip-search

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
  openclaw plugins install @openclaw/whatsapp@2026.6.11 2>&1 || echo "WhatsApp plugin install failed (will retry next boot)"
fi

# Always update SOUL.md and config settings (but preserve sessions/memory)
DOMAIN="${RAILWAY_PUBLIC_DOMAIN:-localhost}"
mkdir -p /root/.openclaw/workspace /root/.openclaw/agents/main/agent
sed "s/RAILWAY_DOMAIN/$DOMAIN/g" /opt/SOUL.md > /root/.openclaw/agents/main/agent/SOUL.md
cp /root/.openclaw/agents/main/agent/SOUL.md /root/.openclaw/workspace/SOUL.md

# Merge template config and migrate persisted model selections while preserving
# gateway auth, sessions, and unrelated overrides.
node /opt/merge-openclaw-config.js

openclaw config validate

# Web search and page fetching are handled by the middleware layer (search-middleware.js + search-proxy.js)
# No need for Brave API key — middleware uses DuckDuckGo + Playwright Chrome browser

# Start openclaw gateway
env \
  -u CURSOR_API_KEY \
  -u GCALCLI_OAUTH_BASE64 \
  -u GCALCLI_OAUTH_JSON \
  -u WHATSAPP_CREDS \
  openclaw gateway --port 18789 &
OPENCLAW_PID=$!

# Wait until gateway is actually listening
echo "Waiting for gateway to start..."
wait_for_port "Gateway" 18789 30

DOMAIN="${RAILWAY_PUBLIC_DOMAIN:-localhost}"
echo "============================================"
echo "OpenClaw gateway ready: https://$DOMAIN"
echo "============================================"

# Start node auto-approve daemon (approves Android/remote node pairing requests)
env \
  -u CURSOR_API_KEY \
  -u TELEGRAM_BOT_TOKEN \
  -u GCALCLI_OAUTH_BASE64 \
  -u GCALCLI_OAUTH_JSON \
  -u WHATSAPP_CREDS \
  node /opt/node-auto-approve.js &
NODE_APPROVE_PID=$!
echo "Node auto-approve daemon started"

# Start WhatsApp QR code web server (serves scannable QR at /wa-link?token=...)
env \
  -u CURSOR_API_KEY \
  -u TELEGRAM_BOT_TOKEN \
  -u GCALCLI_OAUTH_BASE64 \
  -u GCALCLI_OAUTH_JSON \
  -u WHATSAPP_CREDS \
  node /opt/wa-link.js &
WA_LINK_PID=$!
echo "WhatsApp link server started on port 9877"

# Start the public router; search services remain bound to localhost.
env \
  -u CURSOR_API_KEY \
  -u TELEGRAM_BOT_TOKEN \
  -u GCALCLI_OAUTH_BASE64 \
  -u GCALCLI_OAUTH_JSON \
  -u WHATSAPP_CREDS \
  node /opt/router.js &
ROUTER_PID=$!
wait_for_port "Router" "${PORT:-8080}" 30

# Exit the container if a critical child dies so Railway can replace the
# complete process set instead of leaving a partially working deployment.
SUPERVISOR_TICKS=0
TELEGRAM_STUCK_CHECKS=0
CHROME_RESTART_FAILURES=0
while :; do
  for process in \
    "search-proxy:$SEARCH_PROXY_PID" \
    "cursor-api-proxy:$CURSOR_PID" \
    "search-middleware:$MIDDLEWARE_PID" \
    "openclaw-gateway:$OPENCLAW_PID" \
    "router:$ROUTER_PID"
  do
    process_name=${process%%:*}
    process_pid=${process##*:}
    if ! kill -0 "$process_pid" 2>/dev/null; then
      echo "Critical process exited: $process_name (pid $process_pid)" >&2
      wait "$process_pid" 2>/dev/null || true
      exit 1
    fi
  done

  # Chrome is best-effort: the chrome-devtools MCP and CDP page fetching need
  # it, but search-proxy can fall back to its own Chromium. Restart instead of
  # failing the container when it dies (e.g. OOM on Railway), and stop trying
  # after repeated failures so a crash-looping Chrome cannot stall supervision
  # of the critical processes.
  if [ -n "$CHROME_BIN" ] && ! kill -0 "${CHROME_PID:-0}" 2>/dev/null; then
    echo "Chrome remote debugging process died; restarting" >&2
    wait "${CHROME_PID:-0}" 2>/dev/null || true
    if start_chrome; then
      CHROME_RESTART_FAILURES=0
    else
      CHROME_RESTART_FAILURES=$((CHROME_RESTART_FAILURES + 1))
      if [ "$CHROME_RESTART_FAILURES" -ge 3 ]; then
        echo "Chrome failed to restart $CHROME_RESTART_FAILURES times; disabling Chrome restarts" >&2
        CHROME_BIN=""
      fi
    fi
  fi

  SUPERVISOR_TICKS=$((SUPERVISOR_TICKS + 1))
  if [ $((SUPERVISOR_TICKS % 6)) -eq 0 ]; then
    set +e
    env \
      -u CURSOR_API_KEY \
      -u TELEGRAM_BOT_TOKEN \
      -u GCALCLI_OAUTH_BASE64 \
      -u GCALCLI_OAUTH_JSON \
      -u WHATSAPP_CREDS \
      timeout 20 openclaw channels status --json 2>/dev/null \
      | node /opt/telegram-health-check.js
    TELEGRAM_HEALTH_STATUS=$?
    set -e

    if [ "$TELEGRAM_HEALTH_STATUS" -eq 1 ]; then
      TELEGRAM_STUCK_CHECKS=$((TELEGRAM_STUCK_CHECKS + 1))
      echo "Telegram stop-timeout state persists ($TELEGRAM_STUCK_CHECKS/3)" >&2
      if [ "$TELEGRAM_STUCK_CHECKS" -ge 3 ]; then
        echo "Restarting container to recover stuck Telegram polling" >&2
        exit 1
      fi
    elif [ "$TELEGRAM_HEALTH_STATUS" -eq 0 ]; then
      TELEGRAM_STUCK_CHECKS=0
    else
      echo "Telegram health check unavailable; leaving gateway running" >&2
    fi
  fi
  sleep 10
done
