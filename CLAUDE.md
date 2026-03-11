# CLAUDE.md — Instructions for Claude Code

## Project Overview

OpenClaw AI gateway on Railway with Cursor as the LLM backend, Telegram as the primary channel, and a custom web search system using DuckDuckGo + Playwright (headless Chromium). The search middleware intercepts LLM requests, detects search intent, opens pages in a real Chrome browser, and injects results into the conversation context. The Cursor agent is sandboxed and has no working tools — all web access is handled by the middleware.

## Architecture

```
Telegram → OpenClaw (18789) → Search Middleware (8766) → cursor-api-proxy (8765) → Cursor Agent CLI
                                       ↓                        ↓
                              DuckDuckGo Search Proxy (9876)    /opt/agent-workspace (.cursorrules)
                              Playwright Chromium browser
                              (searches + fetches page content via real Chrome)
```

Traffic flow: Public $PORT → router.js → OpenClaw gateway (18789) or search proxy (9876)

### Web Search & Page Fetching Flow

1. User sends message via Telegram
2. OpenClaw forwards to Search Middleware (port 8766)
3. Middleware extracts user text from OpenClaw metadata wrapper
4. Middleware detects URLs in user message → fetches them directly via Playwright (6000 chars each)
5. Middleware detects search intent → searches DuckDuckGo → fetches all 5 result pages via Playwright (4000 chars each)
6. URL fetches and DDG search run in parallel; DDG ad tracking URLs are filtered out
7. All results injected as a system message before the user's message
8. cursor-api-proxy receives enriched context → Cursor Agent CLI responds using the provided content
9. Response is deduplicated (block-repeat and sentence-level) and sent back through OpenClaw to Telegram

### Tool Sandbox Constraints

The Cursor Agent CLI is sandboxed — **no outbound HTTP** works from within it:
- WebFetch — blocked
- Shell (curl/wget) — blocked
- WebSearch — blocked
- browser — blocked

This is why all web access is handled by the middleware layer BEFORE the agent sees the message. The agent workspace (`/opt/agent-workspace/.cursorrules`) explicitly forbids tool usage. OpenClaw tools are set to `profile: 'minimal'` to avoid advertising non-functional web tools.

## Key Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Container: Node 22 + Playwright/Chromium + Cursor CLI + OpenClaw + cursor-api-proxy |
| `entrypoint.sh` | Startup orchestrator. First boot: runs `openclaw onboard`. Every boot: merges config, starts all services |
| `openclaw.json` | Config template. Merged into runtime config on every boot. Contains gateway, channel, and model settings |
| `SOUL.md` | Agent personality + critical rules. Injected into workspace on every boot. Tells agent to use pre-fetched content, never claim access is blocked |
| `.cursorrules` | Cursor agent workspace rules. Forbids all tool usage (WebFetch, Shell, WebSearch, browser). Copied to `/opt/agent-workspace/` |
| `search-middleware.js` | Sits between OpenClaw and cursor-api-proxy. Detects search intent + URLs, calls search-proxy for DDG search and Playwright page fetching, injects results. Also deduplicates streaming responses |
| `search-proxy.js` | DuckDuckGo HTML scraper + Playwright Chromium page fetcher. Provides `/search` (DDG) and `/fetch?url=` (browser) endpoints. Shared browser instance pre-launched on startup |
| `router.js` | HTTP + WebSocket router. Routes /search and /fetch → search proxy, everything else → OpenClaw |

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
- **Tools profile must be `minimal`** — `full` advertises web_search/web_fetch/browser which don't work through Cursor sandbox and confuse the agent
- **Tools profile valid values**: `minimal`, `coding`, `messaging`, `full` — `none` is NOT valid
- **cursor-api-proxy workspace** must be `/opt/agent-workspace` with `CURSOR_BRIDGE_FORCE=true` (workspace trust) and `CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE=false` (so `.cursorrules` is read)

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

### Modify agent tool restrictions
Edit `.cursorrules`. This is copied to `/opt/agent-workspace/.cursorrules` during Docker build. Tells the Cursor agent which tools are forbidden.

### Fix "Config invalid" errors
OpenClaw's schema is very strict. Common invalid keys we discovered:
- `gateway.host` — doesn't exist
- `gateway.rateLimit` — doesn't exist
- `channels.telegram.mode` — doesn't exist
- `channels.telegram.streaming` — use `blockStreamingCoalesce: {}` instead
- `agents.defaults.systemPrompt` — use SOUL.md file instead
- `tools.web.enabled/provider/baseUrl` — use `tools.web.search.apiKey` or BRAVE_API_KEY env var
- `tools.profile: "none"` — invalid, use `minimal`, `coding`, `messaging`, or `full`
- `controlUi.auth` — doesn't exist, use `dangerouslyDisableDeviceAuth: true`

### Test locally
```bash
docker build -t oc-test .
docker run -d --name oc-test -e CURSOR_API_KEY="fake" -e TELEGRAM_BOT_TOKEN="fake" -e PORT=8080 -p 8080:8080 oc-test
sleep 20 && docker logs oc-test
# Check for "Config invalid" or other errors
# Verify: "Chromium browser launched", "Search middleware listening", "Gateway ready"
# Test page fetch: docker exec oc-test curl -s "http://127.0.0.1:9876/fetch?url=https://example.com&maxChars=500"
# Test search: docker exec oc-test curl -s "http://127.0.0.1:9876/search?q=test&count=3"
docker stop oc-test && docker rm oc-test && docker rmi oc-test && docker builder prune -f
```

### Debug search issues
Check deploy logs for:
- `[search-proxy] Chromium browser launched` — Playwright started successfully
- `[search-middleware] Extracted user text:` — what text was parsed from OpenClaw's metadata wrapper
- `[search-middleware] User mentioned URLs:` — URLs detected in user message
- `[search-middleware] Directly fetching user URL:` — URL being fetched via Playwright
- `[search-middleware] Search detected:` — search triggered
- `[search-proxy] Fetching URL via browser:` — Playwright opening a page
- `[search-proxy] Playwright fetch failed for` — page load timeout or error
- `[search-middleware] Injected N results (M with page content)` — results added to context
- `[search-middleware] Dedup: block repeat found` — block-level duplicate detected
- `[search-middleware] Dedup: removed N duplicate sentences` — sentence-level dedup
- `[search-middleware] Deduplicated SSE` or `Deduplicated JSON` — response deduplication applied

### Debug no response
- Check if cursor-api-proxy started: `cursor-api-proxy listening on http://127.0.0.1:8765`
- Verify workspace: `workspace: /opt/agent-workspace` and `force: true`
- Check if middleware received request: `[search-middleware] POST /v1/chat/completions`
- Check if page fetching timed out — Playwright has 15s per page, 30s overall
- Look for `Response error:` in logs
- Check for `Workspace Trust Required` error — means `CURSOR_BRIDGE_FORCE` is not set

### Debug agent still trying to use tools
If the agent says "WebFetch is blocked" or tries curl:
- Verify `.cursorrules` exists: `docker exec <container> cat /opt/agent-workspace/.cursorrules`
- Verify `CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE=false` in logs (so workspace with rules is used)
- Verify tools profile is `minimal` (not `full`) — `full` advertises web tools in system prompt
- Check SOUL.md has the "NEVER try to use WebFetch" rules

## Known Issues

1. **OpenClaw webchat "rate limit" bug** — The embedded agent always returns "API rate limit reached" for any direct API provider (Groq, OpenAI, Gemini). Telegram channel works because it uses a different code path through cursor-api-proxy.
2. **Cursor agent sandbox** — All outbound HTTP is blocked (WebFetch, Shell curl, WebSearch). This is a Cursor CLI limitation. The middleware handles all web access instead.
3. **Dashboard "Unsupported schema node"** — UI rendering bug in OpenClaw's channel config page. Harmless.
4. **Response deduplication** — Cursor's thinking model sometimes duplicates content. The middleware handles this with block-repeat detection and sentence-level dedup, but edge cases may still occur.
5. **Some sites block even Playwright** — Sites with Captcha/WAF (e.g., Amazon) may return empty content even from headless Chrome. The middleware returns whatever it can get.
6. **Playwright page timeout** — Some slow sites may exceed the 15s per-page timeout. Check logs for `Playwright fetch failed`.

## Use Case Context

Primary use cases:
1. General AI assistant via Telegram
2. Web search and research (with real Chrome browser page fetching)
3. Translation
4. Product comparison and shopping research
