# AGENTS.md — Instructions for Codex CLI / OpenAI Agents

## Project Summary

OpenClaw AI gateway on Railway. Docker container running Node 22 + OpenClaw npm package. Connects to Google Gemini 2.5 Pro. Serves an Android phone (OnePlus 13) via HTTPS.

## Files

```
Dockerfile          → Container: node:22-slim + git + openclaw@latest
openclaw.json       → Agent config (model selection, system prompts)
CLAUDE.md           → Claude Code agent instructions
AGENTS.md           → This file (Codex CLI instructions)
README.md           → Human-readable docs
```

## Constraints

- API keys are env vars in Railway, never in source code
- `openclaw.json` must be valid JSON (not JSON5)
- Model identifiers use `provider/model-name` format
- Gateway must bind to `$PORT` (Railway provides this)
- Docker image needs `git` package for npm to install openclaw

## How to Modify

### openclaw.json
Contains agent definitions and model config. Structure:
```json
{
  "agents": {
    "defaults": {
      "model": { "primary": "provider/model-name" }
    },
    "agent-name": {
      "model": { "primary": "provider/model-name" },
      "systemPrompt": "Instructions for this agent"
    }
  }
}
```

### Dockerfile
Standard Node.js Docker pattern. If adding system dependencies, add them to the `apt-get install` line. Keep the image slim.

### Adding features
OpenClaw supports: channels (WhatsApp, Telegram, Discord), tools, memory, media handling. See https://docs.openclaw.ai for full config reference.

## Testing

After any change, push to GitHub. Railway auto-deploys. Check:
1. Railway Deployments tab for build/runtime logs
2. Public URL should respond (not 502 Bad Gateway)
3. Android app should connect and get responses from the agent

## Context

Owner's workflow:
- Lives in Netherlands, needs Dutch→Russian translation and conversation summaries
- Real-time translation: RTranslator app (on-device, offline)
- AI summaries: This OpenClaw gateway + Gemini
- Phone: OnePlus 13 with OpenClaw Android node
