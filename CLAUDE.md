# CLAUDE.md — Instructions for Claude Code

## Project Overview

OpenClaw AI gateway on Railway with Cursor as the LLM backend, Telegram as the primary channel, and a custom DuckDuckGo-based web search system. The search middleware intercepts LLM requests, detects search intent, fetches real web pages, and injects results into the conversation context.

## Architecture

```
Telegram → OpenClaw (18789) → Search Middleware (8766) → cursor-api-proxy (8765) → Cursor Agent CLI
                                       ↓
                              DuckDuckGo Search Proxy (9876)
                              (searches + fetches page content)
```

Traffic flow: Public $PORT → router.js → OpenClaw gateway (18789) or search proxy (9876)

## Key Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Container: Node 22 + Cursor CLI + OpenClaw + cursor-api-proxy + search components |
| `entrypoint.sh` | Startup orchestrator. First boot: runs `openclaw onboard`. Every boot: merges config, starts all services |
| `openclaw.json` | Config template. Merged into runtime config on every boot. Contains gateway, channel, and model settings |
| `SOUL.md` | Agent personality. Injected into workspace on every boot. `RAILWAY_DOMAIN` placeholder is replaced at runtime |
| `search-middleware.js` | Sits between OpenClaw and cursor-api-proxy. Detects search intent, calls DDG, fetches top 3 pages, injects results. Also deduplicates streaming responses |
| `search-proxy.js` | DuckDuckGo HTML scraper. Returns Brave-compatible JSON format |
| `router.js` | HTTP + WebSocket router. Routes /search → search proxy, everything else → OpenClaw |

## Environment Variables (Railway, never in code)

| Variable | Required | Description |
|----------|----------|-------------|
| `CURSOR_API_KEY` | Yes | Cursor subscription API key |
| `TELEGRAM_BOT_TOKEN` | Yes | From @BotFather |
| `FORCE_REINIT` | No | Set to `1` to force full re-onboard, then remove |
| `PORT` | Auto | Railway injects this |
| `RAILWAY_PUBLIC_DOMAIN` | Auto | Railway injects this |

## Critical Rules

- **Never hardcode API keys or secrets** in any file
- **Never put secrets in openclaw.json** — it's a template committed to git
- `openclaw.json` must be **valid strict JSON** — OpenClaw rejects unknown keys with "Config invalid"
- The entrypoint uses a **first-boot marker** (`/root/.openclaw/.initialized`) to skip onboard on subsequent boots
- Config is **merged** every boot: onboard result + template → runtime config
- `SOUL.md` uses `RAILWAY_DOMAIN` placeholder — replaced by `sed` at runtime
- The gateway binds to `127.0.0.1:18789` (localhost only) — `router.js` on `0.0.0.0:$PORT` proxies to it
- The search middleware must be at port **8766** — OpenClaw's provider config points there

## Persistent Volume

Railway volume mounted at `/root/.openclaw` preserves:
- Sessions and conversation history
- Agent memory
- Auth token (prevents token_mismatch)
- First-boot marker

**To force clean reset**: add `FORCE_REINIT=1` env var, deploy, remove var.

## Common Tasks

### Change the LLM model
1. Edit `entrypoint.sh` → `--custom-model-id "model-name"`
2. Edit `openclaw.json` → `agents.defaults.model.primary`
3. Both must match. Available: `claude-4.6-opus-thinking`, `claude-4.6-opus`, `gpt-5.4-fast`, `claude-sonnet-4`

### Modify agent personality
Edit `SOUL.md`. Changes apply on next deploy without FORCE_REINIT.

### Fix "Config invalid" errors
OpenClaw's schema is very strict. Common invalid keys we discovered:
- `gateway.host` — doesn't exist
- `gateway.rateLimit` — doesn't exist
- `channels.telegram.mode` — doesn't exist
- `channels.telegram.streaming` — use `blockStreamingCoalesce: {}` instead
- `agents.defaults.systemPrompt` — use SOUL.md file instead
- `tools.web.enabled/provider/baseUrl` — use `tools.web.search.apiKey` or BRAVE_API_KEY env var
- `controlUi.auth` — doesn't exist, use `dangerouslyDisableDeviceAuth: true`

### Test locally
```bash
docker build -t oc-test .
docker run -d --name oc-test -e CURSOR_API_KEY="fake" -e TELEGRAM_BOT_TOKEN="fake" -e PORT=8080 -p 8080:8080 oc-test
sleep 15 && docker logs oc-test
# Check for "Config invalid" or other errors
docker stop oc-test && docker rm oc-test && docker rmi oc-test && docker builder prune -f
```

### Debug search issues
Check deploy logs for:
- `[search-middleware] Extracted user text:` — what text was parsed from OpenClaw's metadata wrapper
- `[search-middleware] Search detected:` — search triggered
- `[search-middleware] Injected N results (M with page content)` — results added to context
- `[search-middleware] Deduplicated SSE` — duplicate response detected and fixed

### Debug no response
- Check if cursor-api-proxy started: `cursor-api-proxy listening on http://127.0.0.1:8765`
- Check if middleware received request: `[search-middleware] POST /v1/chat/completions`
- Check if page fetching timed out (8s total limit)
- Look for `Response error:` in logs

## Known Issues

1. **OpenClaw webchat "rate limit" bug** — The embedded agent always returns "API rate limit reached" for any direct API provider (Groq, OpenAI, Gemini). Telegram channel works because it uses a different code path through cursor-api-proxy.
2. **Cursor agent can't fetch URLs** — Sandbox policy blocks outbound HTTP. Search is handled by the middleware instead.
3. **Dashboard "Unsupported schema node"** — UI rendering bug in OpenClaw's channel config page. Harmless.
4. **Response deduplication** — Cursor's thinking model sometimes duplicates content. The middleware handles this but isn't perfect for all cases.

## Use Case Context

Owner lives in Netherlands (NL), speaks Russian/English/Dutch. Uses this for:
1. General AI assistant via Telegram on OnePlus 13
2. Web search and research
3. Dutch→Russian/English translation
4. Product comparison and shopping research
