# AGENTS.md — Instructions for Codex CLI / OpenAI Agents

## Project Summary

OpenClaw AI gateway on Railway using Cursor (Claude 4.6 Opus Thinking) as the LLM backend, with Telegram as the primary channel and a custom web search + page fetching system using DuckDuckGo + Playwright (headless Chromium). The middleware opens real web pages in Chrome and injects content into the LLM context. The Cursor agent is sandboxed and has no working tools.

## Architecture

```
User (Telegram) → OpenClaw Gateway (:18789)
    → Search Middleware (:8766)
        - Extracts user text from OpenClaw metadata wrapper
        - Detects URLs in message → fetches via Playwright Chrome (6000 chars each)
        - Detects search intent → searches DDG → fetches all 5 result pages via Playwright (4000 chars each)
        - URL fetches + DDG search run in parallel
        - Injects all results as system message
        - Deduplicates response (block-repeat + sentence-level)
    → cursor-api-proxy (:8765) [translates OpenAI API → Cursor Agent CLI]
    → Cursor Agent CLI [runs Claude 4.6 Opus Thinking, sandboxed, no tools work]

Search Proxy (:9876)
    - /search?q=<query>&count=5  → DuckDuckGo HTML scraper (filters out DDG ad tracking URLs)
    - /fetch?url=<url>&maxChars=6000  → Playwright Chromium page fetcher (15s timeout per page)
    - Shared Chromium browser instance (pre-launched on startup)

Public traffic: Router (:$PORT) → Gateway (:18789) | Search Proxy /search + /fetch (:9876)
```

## Files

```
Dockerfile              → Node 22 + Playwright/Chromium + Cursor CLI + OpenClaw + cursor-api-proxy
entrypoint.sh           → Startup: onboard (first boot only), config merge, process management
                          cursor-api-proxy runs with WORKSPACE=/opt/agent-workspace, FORCE=true, CHAT_ONLY=false
openclaw.json           → Config template (channels, gateway, model). Strict JSON — unknown keys crash OpenClaw
SOUL.md                 → Agent personality + rules: use pre-fetched content, never claim access is blocked
.cursorrules            → Cursor agent workspace rules: forbids ALL tools (WebFetch, Shell, WebSearch, browser)
                          Copied to /opt/agent-workspace/.cursorrules during Docker build
search-middleware.js    → Between OpenClaw and cursor-proxy. URL detection, search injection, page fetching, response deduplication
search-proxy.js         → DuckDuckGo scraper + Playwright Chromium page fetcher on port 9876
router.js               → Public HTTP/WS router (routes /search + /fetch to search proxy)
CLAUDE.md               → Claude Code agent instructions
AGENTS.md               → This file
README.md               → Human docs
```

## Constraints

- **No secrets in code** — API keys are Railway env vars only
- **openclaw.json must be strict JSON** — OpenClaw rejects any unknown key with "Config invalid"
- **Persistent volume** at `/root/.openclaw` — preserves sessions, memory, auth token across deploys
- **First-boot marker** at `/root/.openclaw/.initialized` — onboard runs only once unless `FORCE_REINIT=1`
- **Gateway binds to localhost:18789** — cannot be changed, router.js proxies from public $PORT
- **Cursor agent is sandboxed** — cannot make outbound HTTP. ALL web tools (WebFetch, Shell curl, WebSearch, browser) are blocked. All web access is handled by the middleware layer.
- **Tools profile must be `minimal`** — `full` advertises non-functional web tools and confuses the agent. Valid values: `minimal`, `coding`, `messaging`, `full` (NOT `none`)
- **Agent workspace** at `/opt/agent-workspace` — contains `.cursorrules` forbidding all tools. Must use `CURSOR_BRIDGE_FORCE=true` (trust workspace) and `CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE=false` (so rules file is read)

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CURSOR_API_KEY` | Yes | Cursor subscription API key |
| `TELEGRAM_BOT_TOKEN` | Yes | From Telegram @BotFather |
| `FORCE_REINIT` | No | Set `1` to re-onboard, then remove |

## How to Modify

### Change LLM model
Update both:
1. `entrypoint.sh` → `--custom-model-id "model-name"`
2. `openclaw.json` → `agents.defaults.model.primary` → `"cursor-proxy/model-name"`

### Agent personality
Edit `SOUL.md`. Applied every deploy. Contains critical rules about using pre-fetched content and never claiming access is blocked.

### Agent tool restrictions
Edit `.cursorrules`. Copied to `/opt/agent-workspace/` during Docker build. Forbids all tool usage.

### Search behavior
Edit `search-middleware.js`:
- `detectSearchIntent()` — when to search (currently: almost everything except greetings/translations)
- `extractUrls()` — detects URLs in user messages for direct Playwright fetching
- `fetchPage()` — calls search-proxy's `/fetch` endpoint (15s timeout per page, 30s overall)
- All 5 DDG results get full page content fetched via Playwright
- User-mentioned URLs get 6000 chars, search results get 4000 chars

### Page fetching
Edit `search-proxy.js`:
- `fetchPageWithBrowser()` — Playwright page load with 15s timeout, 2s JS render wait
- Shared Chromium instance with `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu`
- `/fetch?url=<url>&maxChars=6000` endpoint

### Response deduplication
Edit `search-middleware.js` → `deduplicateText()`:
- Strategy 1: Block-repeat detection (finds where content starts repeating at 30-55% of text length)
- Strategy 2: Sentence-level dedup (splits by sentence boundaries, removes all seen duplicates)

### Telegram access control
Edit `openclaw.json` → `channels.telegram.allowFrom`: `["*"]` for open, or `["user_id"]` for restricted.

## Invalid OpenClaw Config Keys (discovered through trial and error)

These keys do NOT exist and will crash OpenClaw:
- `gateway.host`, `gateway.rateLimit`
- `channels.telegram.mode`, `channels.telegram.streaming`, `channels.telegram.dmPolicy` (use with `allowFrom: ["*"]`)
- `agents.defaults.systemPrompt` (use SOUL.md file)
- `tools.web.enabled`, `tools.web.provider`, `tools.web.baseUrl`
- `tools.profile: "none"` — invalid, must be `minimal`, `coding`, `messaging`, or `full`
- `controlUi.auth`
- `blockStreamingCoalesce` must be `{}` (not boolean or string)

## Testing

```bash
docker build -t oc-test .
docker run -d --name oc-test -e CURSOR_API_KEY=fake -e TELEGRAM_BOT_TOKEN=fake -e PORT=8080 -p 8080:8080 oc-test
sleep 20 && docker logs oc-test
# Verify: "Chromium browser launched", "Search middleware listening", "Gateway ready"
# Test page fetch: docker exec oc-test curl -s "http://127.0.0.1:9876/fetch?url=https://example.com&maxChars=500"
# Test search: docker exec oc-test curl -s "http://127.0.0.1:9876/search?q=test&count=3"
# Test middleware: docker exec oc-test curl -s -X POST "http://127.0.0.1:8766/v1/chat/completions" -H "Content-Type: application/json" -d '{"model":"test","messages":[{"role":"user","content":"test query"}]}' --max-time 60
docker stop oc-test && docker rm oc-test && docker rmi oc-test && docker builder prune -f
```

Check logs for "Config invalid" errors before pushing.

## Known Issues

1. OpenClaw webchat always shows "rate limit reached" — use Telegram instead
2. Cursor agent sandbox blocks all outbound HTTP — middleware handles all web access via Playwright
3. Dashboard channel page shows "Unsupported schema node" — cosmetic bug
4. Thinking model may duplicate content — middleware deduplicates responses (block-repeat + sentence-level)
5. Some sites block even headless Chrome (Captcha/WAF) — middleware returns whatever content it can get
6. Slow sites may exceed 15s Playwright timeout — check logs for `Playwright fetch failed`
