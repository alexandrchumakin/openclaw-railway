# OpenClaw Railway Gateway

Self-hosted OpenClaw AI gateway deployed on Railway, designed to work with the OpenClaw Android app for real-time AI assistant capabilities on mobile.

## Architecture

```
OnePlus 13 (OpenClaw Android) → HTTPS → Railway (OpenClaw Gateway) → Gemini API
```

- **Gateway**: Runs on Railway ($5/mo Hobby plan), always-on
- **LLM**: Google Gemini 2.5 Pro via free-tier API
- **Android**: OpenClaw node connects to the gateway over HTTPS
- **Use cases**: Real-time translation summaries, conversation recording analysis, general AI assistant

## Quick Start

### 1. Deploy to Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template)

Or manually:
1. Fork this repo
2. Create a new Railway project → "GitHub Repo" → select this repo
3. Railway auto-detects the Dockerfile and builds

### 2. Set Environment Variables

In Railway **Variables** tab:

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | Yes | Google Gemini API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `PORT` | No | Railway injects this automatically. Set to `18789` if needed |

**Optional provider keys** (add any to switch providers):

| Variable | Provider |
|----------|----------|
| `ANTHROPIC_API_KEY` | Claude (Opus, Sonnet, Haiku) |
| `OPENAI_API_KEY` | GPT-4o, o1, etc. |
| `OPENROUTER_API_KEY` | Any model via OpenRouter |

### 3. Generate Public Domain

Railway → Settings → Networking → "Generate Domain"

You'll get: `https://<your-service>.up.railway.app`

### 4. Connect Android Phone

Install OpenClaw on Android (APK from [docs.openclaw.ai/platforms/android](https://docs.openclaw.ai/platforms/android)):

1. Open OpenClaw Android app
2. Settings → Gateway → Manual connection
3. Enter your Railway public URL: `https://<your-service>.up.railway.app`
4. Tap Connect

## Project Structure

```
├── Dockerfile          # Node 22 container with OpenClaw gateway
├── openclaw.json       # Agent config (model selection, defaults)
├── CLAUDE.md           # Instructions for Claude Code / Claude agents
├── AGENTS.md           # Instructions for Codex CLI / OpenAI agents
└── README.md           # This file
```

## Configuration

### Changing the LLM Model

Edit `openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "model": { "primary": "google/gemini-2.5-pro" }
    }
  }
}
```

Available model formats:
- `google/gemini-2.5-pro` — Google Gemini (free tier available)
- `anthropic/claude-opus-4-6` — Claude Opus (requires `ANTHROPIC_API_KEY`)
- `anthropic/claude-haiku-4-5` — Claude Haiku (cheap, fast)
- `openai/gpt-4o` — GPT-4o (requires `OPENAI_API_KEY`)
- `openrouter/anthropic/claude-opus-4-6` — Any model via OpenRouter

### Adding Agents

Extend `openclaw.json` with custom agents:

```json
{
  "agents": {
    "defaults": {
      "model": { "primary": "google/gemini-2.5-pro" }
    },
    "translator": {
      "model": { "primary": "google/gemini-2.5-pro" },
      "systemPrompt": "You are a translator. Translate Dutch to Russian. Be concise."
    },
    "summarizer": {
      "model": { "primary": "google/gemini-2.5-pro" },
      "systemPrompt": "Summarize conversations with key points, action items, and decisions."
    }
  }
}
```

## Use Case: Dutch-Russian Translation + Meeting Summaries

This gateway was built for a specific workflow:

1. **Real-time translation**: Use [RTranslator](https://github.com/niedev/RTranslator) on-device (offline, zero latency)
2. **Conversation summaries**: Send audio/text to OpenClaw gateway → Gemini generates structured notes
3. **Background recording**: OpenClaw Android node records ambient audio, sends to gateway for processing

### Recommended Android Apps

| App | Purpose | Install |
|-----|---------|---------|
| OpenClaw Android | AI gateway client | [APK from docs](https://docs.openclaw.ai/platforms/android) |
| RTranslator | Offline Dutch↔Russian translation | [GitHub](https://github.com/niedev/RTranslator) |
| Plaud Note | Meeting transcription + summaries | [Google Play](https://play.google.com/store/apps/details?id=ai.plaud.android.plaud) |

## Troubleshooting

### Gateway won't start
- Check logs in Railway Deployments tab
- Run `openclaw doctor --fix` via Railway shell
- Verify `GEMINI_API_KEY` is set correctly (starts with `AIzaSy...`)

### "Config invalid" error
- Don't put API keys in `openclaw.json` — use environment variables
- Model format must be `provider/model-name`

### Android can't connect
- Ensure you generated a **public** domain (not `.railway.internal`)
- Check the URL starts with `https://`
- Verify gateway shows "1/1 service online" in Railway dashboard

### Bad Gateway (502)
- Gateway process crashed — check deployment logs
- Usually a config error or missing API key

## Cost

| Component | Cost |
|-----------|------|
| Railway Hobby | $5/mo (includes $5 usage credit) |
| Gemini 2.5 Pro API | Free tier: 50 RPD / 2M TPM |
| OpenClaw | Free (MIT license) |
| **Total** | **~$5/month** |

## Links

- [OpenClaw Docs](https://docs.openclaw.ai)
- [OpenClaw GitHub](https://github.com/openclaw/openclaw)
- [Railway Docs](https://docs.railway.com)
- [Google AI Studio](https://aistudio.google.com)
