# AGENTS.md — Instructions for Codex CLI / OpenAI Agents

## Project Summary

OpenClaw AI gateway on Railway using Cursor (Claude 4.6 Opus Thinking) as the LLM backend, with Telegram as the primary channel and a custom DuckDuckGo web search system that injects real page content into LLM context.

## Architecture

```
User (Telegram) → OpenClaw Gateway (:18789)
    → Search Middleware (:8766) [detects search, fetches pages, injects results]
    → cursor-api-proxy (:8765) [translates OpenAI API → Cursor Agent CLI]
    → Cursor Agent CLI [runs Claude 4.6 Opus Thinking]

Public traffic: Router (:$PORT) → Gateway (:18789) | Search Proxy (:9876)
```

## Files

```
Dockerfile              → Node 22 + Cursor CLI + OpenClaw + cursor-api-proxy
entrypoint.sh           → Startup: onboard (first boot only), config merge, process management
openclaw.json           → Config template (channels, gateway, model). Strict JSON — unknown keys crash OpenClaw
SOUL.md                 → Agent personality (RAILWAY_DOMAIN placeholder replaced at runtime)
search-middleware.js    → Between OpenClaw and cursor-proxy. Search injection + response deduplication
search-proxy.js         → DuckDuckGo scraper on port 9876
router.js               → Public HTTP/WS router
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
- **Cursor agent is sandboxed** — cannot make outbound HTTP, all web search is handled by middleware

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
Edit `SOUL.md`. Applied every deploy.

### Search behavior
Edit `search-middleware.js`:
- `detectSearchIntent()` — when to search (currently: almost always except greetings)
- `fetchPage()` — page scraping with 3s/page timeout, 8s total
- Top 3 results get full page content fetched

### Telegram access control
Edit `openclaw.json` → `channels.telegram.allowFrom`: `["*"]` for open, or `["user_id"]` for restricted.

## Invalid OpenClaw Config Keys (discovered through trial and error)

These keys do NOT exist and will crash OpenClaw:
- `gateway.host`, `gateway.rateLimit`
- `channels.telegram.mode`, `channels.telegram.streaming`, `channels.telegram.dmPolicy` (use with `allowFrom: ["*"]`)
- `agents.defaults.systemPrompt` (use SOUL.md file)
- `tools.web.enabled`, `tools.web.provider`, `tools.web.baseUrl`
- `controlUi.auth`
- `blockStreamingCoalesce` must be `{}` (not boolean or string)

## Testing

```bash
docker build -t test . && docker run -d --name test -e CURSOR_API_KEY=fake -e PORT=8080 -p 8080:8080 test
sleep 15 && docker logs test
docker stop test && docker rm test && docker rmi test && docker builder prune -f
```

Check logs for "Config invalid" errors before pushing.

## Known Issues

1. OpenClaw webchat always shows "rate limit reached" — use Telegram instead
2. Cursor agent can't fetch URLs (sandbox) — middleware handles search
3. Dashboard channel page shows "Unsupported schema node" — cosmetic bug
4. Thinking model may duplicate content — middleware deduplicates responses
