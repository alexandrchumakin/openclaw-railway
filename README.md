# OpenClaw + Cursor AI Gateway on Railway

Deploy your own AI-powered Telegram bot in minutes. Uses [OpenClaw](https://docs.openclaw.ai) as the gateway, [Cursor](https://cursor.com) (or OpenAI/ChatGPT) as the LLM backend, and includes free web search with real Chrome browser page fetching via Playwright.

**What you get:**
- A personal AI assistant in Telegram that can search the web and read real web pages
- Powered by Claude 4.6 Opus, GPT-5, or any model supported by your API provider
- Free DuckDuckGo search + Playwright headless Chrome for fetching JS-heavy pages
- Deploys on Railway for ~$5/month (plus your LLM API subscription)
- Persistent conversations across deploys

## Quick Start (5 minutes)

### 1. Fork this repo

Click **Fork** on GitHub to create your own copy.

### 2. Create a Railway project

1. Sign up at [railway.com](https://railway.com) (Hobby plan, $5/mo)
2. **New Project** → **Deploy from GitHub Repo** → select your fork
3. Railway auto-detects the Dockerfile and starts building

### 3. Set environment variables

In Railway → your service → **Variables**, add:

| Variable | Required | How to get it |
|----------|----------|---------------|
| `CURSOR_API_KEY` | Yes* | Cursor IDE → Settings → API Keys, or run `agent login` |
| `TELEGRAM_BOT_TOKEN` | Yes | Message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` |
| `FORCE_REINIT` | No | Set to `1` to force re-onboard, then remove after deploy |

*See "Using OpenAI/ChatGPT instead of Cursor" below for alternatives.

### 4. Add a persistent volume

Railway → your service → **Settings** → **Volumes** → **Add Volume**:
- **Mount Path**: `/root/.openclaw`
- **Size**: 1 GB

This preserves your conversations and settings across deploys.

### 5. Generate a public domain

Railway → your service → **Settings** → **Networking** → **Generate Domain**

### 6. Start chatting

Message your Telegram bot. It will automatically search the web and fetch page content for any question you ask.

## Using OpenAI/ChatGPT Instead of Cursor

This project defaults to Cursor's API (which gives access to Claude, GPT, and other models through a Cursor subscription). If you prefer to use OpenAI directly:

### Option A: Use cursor-api-proxy with Cursor key (default)

No changes needed. Set `CURSOR_API_KEY` and you get access to all models Cursor supports (Claude 4.6 Opus, GPT-5, etc.).

### Option B: Use OpenAI API directly

You can replace cursor-api-proxy with a direct OpenAI connection:

1. In `entrypoint.sh`, change the onboard command:
   ```bash
   --custom-base-url "https://api.openai.com/v1"
   --custom-api-key "$OPENAI_API_KEY"
   --custom-provider-id "openai"
   --custom-model-id "gpt-4.1"
   --custom-compatibility openai
   ```
2. Set `OPENAI_API_KEY` instead of `CURSOR_API_KEY` in Railway variables
3. Remove or comment out the cursor-api-proxy startup in `entrypoint.sh`
4. Update the search middleware to point directly to OpenAI:
   ```bash
   --custom-base-url "https://api.openai.com/v1"
   ```
5. Update `openclaw.json` → `agents.defaults.model.primary` to match (e.g., `"openai/gpt-4.1"`)

### Option C: Use any OpenAI-compatible provider

Any provider with an OpenAI-compatible API works (Groq, Together, Mistral, local Ollama, etc.). Just change `--custom-base-url`, `--custom-api-key`, `--custom-provider-id`, and `--custom-model-id` accordingly.

## Architecture

```
Telegram Bot ← OpenClaw Gateway ← Search Middleware ← cursor-api-proxy ← Cursor Agent CLI
     ↑                                    ↑                                    ↑
  Your phone                     DuckDuckGo Search Proxy              /opt/agent-workspace
                              Playwright Chromium browser               (.cursorrules)
                         (searches DDG + opens pages in Chrome)
```

- **Gateway**: OpenClaw on Railway
- **LLM**: Claude 4.6 Opus (Thinking) via Cursor API key + cursor-api-proxy (or any OpenAI-compatible provider)
- **Search**: Free DuckDuckGo search (no API key needed)
- **Page Fetching**: Playwright headless Chromium — opens real web pages, renders JS, extracts text content. Bypasses anti-bot protections that block simple HTTP requests.
- **Channels**: Telegram bot (primary), web dashboard (limited)
- **Persistence**: Railway volume at `/root/.openclaw` preserves sessions across deploys

## Components

| Component | Port | Purpose |
|-----------|------|---------|
| OpenClaw Gateway | 18789 | Main gateway, manages sessions, channels, agents |
| cursor-api-proxy | 8765 | Translates OpenAI API → Cursor Agent CLI |
| Search Middleware | 8766 | Intercepts LLM calls, detects URLs + search intent, fetches pages via Playwright, injects results, deduplicates responses |
| Search Proxy | 9876 | DuckDuckGo scraper + Playwright Chrome page fetcher (`/search` + `/fetch?url=`) |
| Router | $PORT (8080) | Public entry point, routes to gateway + search proxy |

## Project Structure

```
├── Dockerfile              # Container: Node 22 + Playwright/Chromium + Cursor CLI + OpenClaw + cursor-api-proxy
├── entrypoint.sh           # Startup orchestrator (onboard, config merge, process management)
├── openclaw.json           # OpenClaw config template (channels, gateway, model settings)
├── SOUL.md                 # Agent personality and rules (use pre-fetched content, never claim access blocked)
├── .cursorrules            # Cursor agent rules (forbids all tools — WebFetch, Shell, WebSearch, browser)
├── search-proxy.js         # DuckDuckGo search + Playwright Chrome page fetcher (port 9876)
├── search-middleware.js    # Intercepts LLM calls, detects URLs + search, fetches pages, deduplicates responses
├── router.js               # HTTP/WebSocket router (public port → gateway + search proxy)
├── CLAUDE.md               # Instructions for Claude Code agents
├── AGENTS.md               # Instructions for Codex CLI / OpenAI agents
└── README.md               # This file
```

## How Web Search Works

The search is transparent to the LLM — it doesn't need to "search" itself. A Playwright headless Chrome browser handles all page fetching, bypassing anti-bot protections that block simple HTTP requests.

1. User sends message via Telegram
2. OpenClaw forwards to Search Middleware (port 8766)
3. Middleware extracts user text from OpenClaw metadata wrapper
4. **URL detection**: If the user mentioned any URLs, they are fetched directly via Playwright Chrome (6000 chars each)
5. **Search detection**: Middleware detects search intent (almost every message except greetings/translations)
6. **DuckDuckGo search**: Queries DDG, filters out ad tracking URLs
7. **Page fetching**: All 5 search result pages are opened in Playwright Chrome (4000 chars each)
8. Steps 4-7 run in parallel for speed. Per-page timeout is 15s, overall timeout is 30s.
9. Results are injected as a system message before the user's message
10. The LLM receives enriched context and responds using the provided content
11. Response is deduplicated (block-repeat + sentence-level dedup) and sent back through OpenClaw to Telegram

### Why Playwright?

Simple HTTP fetching (curl, node http) gets blocked by many sites with anti-bot protections. Playwright launches a real headless Chromium browser that:
- Renders JavaScript
- Handles redirects and cookies
- Bypasses most anti-bot detection
- Extracts visible text content (`document.body.innerText`)

### Agent Tool Sandbox

The Cursor Agent CLI runs in a sandbox that blocks all outbound HTTP. The agent's built-in tools (WebFetch, Shell, WebSearch) all fail. To prevent the agent from wasting time trying these tools:

1. **`.cursorrules`** in the agent workspace explicitly forbids all tool usage
2. **`tools: { profile: 'minimal' }`** in OpenClaw config avoids advertising non-functional web tools
3. **`SOUL.md`** instructs the agent to use pre-fetched content and never claim access is blocked

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

### Modifying Agent Tool Restrictions

Edit `.cursorrules` — copied to `/opt/agent-workspace/` during Docker build. Explicitly forbids WebFetch, Shell, WebSearch, browser, web_fetch, web_search tools.

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
- `detectSearchIntent()` — controls when search triggers (currently: almost always except greetings)
- `extractUrls()` — detects URLs in user messages for direct fetching
- `fetchPage()` — calls search-proxy's `/fetch` endpoint (15s timeout per page, 30s overall)
- User-mentioned URLs: 6000 chars each; DDG search results: 4000 chars each

Edit `search-proxy.js`:
- `fetchPageWithBrowser()` — Playwright page load (15s timeout, 2s JS render wait)
- Shared Chromium instance with `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage`

### Response Deduplication

Edit `search-middleware.js` → `deduplicateText()`:
- **Block-repeat detection**: Finds where content starts repeating at any split point (30-55% of text)
- **Sentence-level dedup**: Splits by sentence boundaries, removes all duplicate sentences

## Troubleshooting

### Bot doesn't respond
- Check Railway deploy logs for errors
- Verify `CURSOR_API_KEY` is valid
- Check if cursor-api-proxy started: look for `cursor-api-proxy listening on http://127.0.0.1:8765`
- Check workspace: should show `workspace: /opt/agent-workspace` and `force: true`

### "Workspace Trust Required" error
- Verify `CURSOR_BRIDGE_FORCE=true` is set in entrypoint.sh

### Agent says "access is blocked" or tries WebFetch/curl
- Verify `.cursorrules` exists in the agent workspace
- Verify `CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE=false` in logs
- Verify tools profile is `minimal` (not `full`) in entrypoint.sh
- Check SOUL.md has the "NEVER try to use WebFetch" rules

### Duplicate messages
- The search middleware deduplicates using block-repeat and sentence-level detection
- Check for `[search-middleware] Dedup:` or `Deduplicated` in logs

### Search not working
- Check for `[search-proxy] Chromium browser launched` — Playwright must start
- Check for `[search-middleware] Search detected` in logs
- If detected but no page content: Playwright may be timing out (check for `Playwright fetch failed`)

### Page fetching fails for specific sites
- Captcha/WAF sites (e.g., Amazon) may block even headless Chrome
- Slow sites may exceed the 15s timeout

### "Config invalid" on deploy
- OpenClaw's config schema is strict — unknown keys cause crashes
- Valid tool profiles: `minimal`, `coding`, `messaging`, `full` (NOT `none`)
- Test locally first (see Testing section)

### Force fresh start
- Add `FORCE_REINIT=1` to Railway variables, deploy, then remove it

## Testing Locally

```bash
# Build
docker build -t oc-test .

# Run
docker run -d --name oc-test -e CURSOR_API_KEY="fake" -e TELEGRAM_BOT_TOKEN="fake" -e PORT=8080 -p 8080:8080 oc-test

# Wait for startup and check logs
sleep 20 && docker logs oc-test
# Look for: "Chromium browser launched", "Search middleware listening", "Gateway ready"

# Test Playwright page fetching
docker exec oc-test curl -s "http://127.0.0.1:9876/fetch?url=https://example.com&maxChars=500"

# Test DuckDuckGo search
docker exec oc-test curl -s "http://127.0.0.1:9876/search?q=test&count=3"

# Cleanup
docker stop oc-test && docker rm oc-test && docker rmi oc-test && docker builder prune -f
```

## Cost

| Component | Cost |
|-----------|------|
| Railway Hobby | $5/mo (includes $5 usage credit) |
| Cursor API | Included in Cursor subscription (~$20/mo) |
| OpenAI API (alternative) | Pay-per-use (~$0.01-0.06 per request depending on model) |
| DuckDuckGo Search | Free (no API key) |
| Playwright/Chromium | Free (bundled in Docker image) |
| OpenClaw | Free (MIT license) |
| **Total** | **~$5/month** + LLM API costs |

## Links

- [OpenClaw Docs](https://docs.openclaw.ai)
- [cursor-api-proxy](https://github.com/anyrobert/cursor-api-proxy)
- [Playwright Docs](https://playwright.dev)
- [Railway Docs](https://docs.railway.com)
- [Cursor Agent CLI](https://cursor.com/install)
- [OpenAI API Docs](https://platform.openai.com/docs)

## License

MIT
