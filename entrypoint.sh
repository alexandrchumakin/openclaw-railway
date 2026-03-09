#!/bin/sh
set -e

# Clean any cached/stale state
rm -rf /root/.openclaw/agents/main/sessions/*
rm -f /root/.openclaw/openclaw.json.bak
rm -rf /root/.openclaw/cache

# Start openclaw gateway in background
openclaw gateway --port 18789 &
OPENCLAW_PID=$!

# Wait for gateway to start
sleep 5

# Extract the generated auth token from config and log it
TOKEN=$(node -e "const c=JSON.parse(require('fs').readFileSync('/root/.openclaw/openclaw.json','utf8')); console.log(c.gateway?.auth?.token || 'no-token')")
DOMAIN="${RAILWAY_PUBLIC_DOMAIN:-openclaw-railway-production-c433.up.railway.app}"
echo "============================================"
echo "OPENCLAW AUTH TOKEN: $TOKEN"
echo "https://$DOMAIN/chat?session=main&token=$TOKEN"
echo "============================================"

# Proxy $PORT -> 18789 (main gateway, serves both HTTP API and WebSocket)
socat TCP-LISTEN:${PORT:-8080},fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:18789 &

# Wait for openclaw process
wait $OPENCLAW_PID
