# OpenClaw + Cursor AI Gateway on Railway

AI assistant accessible via Telegram, powered by Cursor's Claude 4.6 Opus (Thinking) through OpenClaw gateway, with free DuckDuckGo web search.

## Architecture

```
Telegram Bot ← OpenClaw Gateway ← Search Middleware ← cursor-api-proxy ← Cursor Agent CLI
     ↑                                    ↑
     |                              DuckDuckGo Search Proxy
  OnePlus 13                        (fetches pages too)
```

- **Gateway**: OpenClaw on Railway ($5/mo Hobby plan)
- **LLM**: Claude 4.6 Opus (Thinking) via Cursor API key + cursor-api-proxy
- **Search**: Free DuckDuckGo search with page content fetching (no API key needed)
- **Channels**: Telegram bot (primary), web dashboard (limited)
- **Persistence**: Railway volume at `/root/.openclaw` preserves sessions across deploys

## Components

| Component | Port | Purpose |
|-----------|------|---------|
| OpenClaw Gateway | 18789 | Main gateway, manages sessions, channels, agents |
| cursor-api-proxy | 8765 | Translates OpenAI API → Cursor Agent CLI |
| Search Middleware | 8766 | Intercepts LLM calls, injects web search results |
| DuckDuckGo Search Proxy | 9876 | Scrapes DuckDuckGo, fetches top 3 page contents |
| Router | $PORT (8080) | Public entry point, routes to gateway + search |

## Quick Start

### 1. Prerequisites

- [Railway](https://railway.com) Hobby account ($5/mo)
- [Cursor](https://cursor.com) subscription with API key
- Telegram bot token from [@BotFather](https://t.me/BotFather)

### 2. Deploy

1. Fork this repo
2. Railway → New Project → GitHub Repo → select this repo
3. Railway auto-detects Dockerfile and builds

### 3. Set Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CURSOR_API_KEY` | Yes | Cursor API key (from Cursor IDE settings or `agent login`) |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token from @BotFather |
| `FORCE_REINIT` | No | Set to `1` to force full re-onboard on next deploy (then remove) |

### 4. Add Persistent Volume

Railway → Service → Settings → Volumes → Add Volume:
- **Mount Path**: `/root/.openclaw`
- **Size**: 1 GB

This preserves conversations, sessions, memory, and auth tokens across deploys.

### 5. Generate Public Domain

Railway → Service → Settings → Networking → Generate Domain

### 6. Access

- **Telegram**: Message your bot directly
- **Web Dashboard**: Use the URL with token from deploy logs

## Project Structure

```
├── Dockerfile              # Container: Node 22 + Cursor CLI + OpenClaw + cursor-api-proxy
├── entrypoint.sh           # Startup orchestrator (onboard, config merge, process management)
├── openclaw.json           # OpenClaw config template (channels, gateway, model settings)
├── SOUL.md                 # Agent personality and instructions (injected into workspace)
├── search-proxy.js         # DuckDuckGo search proxy (port 9876)
├── search-middleware.js     # Intercepts LLM calls, injects search results + page content
├── router.js               # HTTP/WebSocket router (public port → gateway + search)
├── CLAUDE.md               # Instructions for Claude Code agents
├── AGENTS.md               # Instructions for Codex CLI / OpenAI agents
└── README.md               # This file
```

## How Web Search Works

The search is transparent to the LLM — it doesn't need to "search" itself:

1. User sends message via Telegram
2. OpenClaw forwards to Search Middleware (port 8766)
3. Middleware detects search intent (keywords, questions, etc.)
4. Middleware searches DuckDuckGo and fetches top 3 page contents
5. Results are injected as a system message before the user's message
6. cursor-api-proxy receives enriched context and responds with real data
7. Response is deduplicated and sent back through OpenClaw to Telegram

Search is aggressive by default — almost every message triggers a search unless it's a short greeting or translation request.

## Persistence & State

With the Railway volume mounted at `/root/.openclaw`:

- **Sessions**: Conversation history persists across deploys
- **Memory**: Agent memory files persist
- **Auth token**: Gateway token stays the same (no more token_mismatch on dashboard)
- **Config**: Merged on every boot (template + onboard result)

### Force Reset

To wipe all state and start fresh:
1. Add Railway variable: `FORCE_REINIT=1`
2. Deploy (triggers full re-onboard)
3. Remove `FORCE_REINIT` variable after deploy

## Configuration

### Changing the LLM Model

Edit `entrypoint.sh` → `--custom-model-id` parameter:

```bash
--custom-model-id "claude-4.6-opus-thinking"   # Current default
--custom-model-id "claude-4.6-opus"            # Non-thinking variant
--custom-model-id "gpt-5.4-fast"               # GPT fallback
--custom-model-id "claude-sonnet-4"             # Faster, cheaper
```

Also update `openclaw.json` → `agents.defaults.model.primary` to match.

### Modifying Agent Personality

Edit `SOUL.md` — this is injected into the OpenClaw workspace on every boot. Changes take effect on next deploy without FORCE_REINIT.

### Telegram Channel Settings

Edit `openclaw.json` → `channels.telegram`:

```json
{
  "telegram": {
    "enabled": true,
    "dmPolicy": "open",
    "allowFrom": ["*"],
    "groupPolicy": "open",
    "blockStreamingCoalesce": {}
  }
}
```

To restrict access, replace `["*"]` with specific Telegram user IDs.

### Search Tuning

Edit `search-middleware.js`:
- `detectSearchIntent()` — controls when search triggers
- `fetchPage()` — page content fetching (3s timeout per page, 8s total)
- Top 3 results get full page content, remaining get snippets only

## Troubleshooting

### Bot doesn't respond
- Check Railway deploy logs for errors
- Verify `CURSOR_API_KEY` is valid
- Check if cursor-api-proxy started: look for `cursor-api-proxy listening on http://127.0.0.1:8765`

### "No response generated"
- Usually caused by empty streaming chunks from Cursor thinking model
- The deduplication middleware should handle this — check for `Response error` in logs

### Duplicate messages
- The search middleware deduplicates by comparing first/second halves of response
- If still happening, check `[search-middleware] Deduplicated` in logs

### Search not working
- Check for `[search-middleware] Search detected` in logs
- If no detection: the message didn't match search keywords
- If detected but no results: DuckDuckGo may be rate-limiting

### "Config invalid" on deploy
- OpenClaw's config schema is strict — unknown keys cause crashes
- Test changes locally: `docker build -t test . && docker run -e CURSOR_API_KEY=fake -e PORT=8080 test`
- Check the exact error message for the invalid key

### Web dashboard shows "token_mismatch"
- Close old browser tabs (they have stale tokens)
- Use the fresh URL from deploy logs
- With persistent volume, the token stays the same across deploys

### Force fresh start
- Add `FORCE_REINIT=1` to Railway variables, deploy, then remove it

## Cost

| Component | Cost |
|-----------|------|
| Railway Hobby | $5/mo (includes $5 usage credit) |
| Cursor API | Included in Cursor subscription |
| DuckDuckGo Search | Free (no API key) |
| OpenClaw | Free (MIT license) |
| **Total** | **~$5/month** + Cursor subscription |

## Links

- [OpenClaw Docs](https://docs.openclaw.ai)
- [cursor-api-proxy](https://github.com/anyrobert/cursor-api-proxy)
- [Railway Docs](https://docs.railway.com)
- [Cursor Agent CLI](https://cursor.com/install)
