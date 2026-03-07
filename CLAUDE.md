# CLAUDE.md — Instructions for Claude Code

## Project Overview

This is an OpenClaw AI gateway deployed on Railway, serving as a backend for an Android phone (OnePlus 13). The gateway connects to Google Gemini 2.5 Pro and provides AI assistant capabilities over HTTPS.

## Architecture

- **Runtime**: Node.js 22 in Docker on Railway
- **Framework**: OpenClaw (npm package, MIT licensed)
- **LLM Provider**: Google Gemini via `GEMINI_API_KEY` env var
- **Client**: OpenClaw Android app connecting over public HTTPS domain
- **Config**: `openclaw.json` for agent/model settings, env vars for secrets

## Key Files

- `Dockerfile` — Container definition. Installs Node 22 + git + openclaw. Copies config and starts gateway on `$PORT` (Railway-injected) or 18789
- `openclaw.json` — Agent configuration. Model selection, system prompts, agent definitions. Do NOT put API keys here — use env vars

## Environment Variables (set in Railway, never in code)

- `GEMINI_API_KEY` — Google Gemini API key (required)
- `PORT` — Railway injects automatically
- `ANTHROPIC_API_KEY` — Optional, for Claude models
- `OPENAI_API_KEY` — Optional, for GPT models
- `OPENROUTER_API_KEY` — Optional, for OpenRouter proxy

## Rules

- Never hardcode API keys or secrets in any file
- Keep `openclaw.json` minimal — OpenClaw auto-detects providers from env vars
- The Dockerfile CMD should not use `envsubst` — OpenClaw reads env vars directly
- Model format in config: `provider/model-name` (e.g., `google/gemini-2.5-pro`)
- Test config changes by checking OpenClaw logs after deploy (Railway Deployments tab)
- The gateway must listen on `$PORT` env var for Railway to route traffic

## Common Tasks

### Change the default model
Edit `openclaw.json` → `agents.defaults.model.primary`

### Add a new agent
Add a named entry under `agents` in `openclaw.json` with `model` and `systemPrompt`

### Add a new provider
Add the provider's API key as a Railway env var. OpenClaw auto-detects:
- `GEMINI_API_KEY` → Google
- `ANTHROPIC_API_KEY` → Anthropic
- `OPENAI_API_KEY` → OpenAI

### Debug deployment failures
Check Railway deployment logs. Common issues:
- "Config invalid" → bad `openclaw.json` syntax or unknown keys
- "ENOENT git" → `git` not installed in Docker image
- "No API key found" → env var not set in Railway

## Use Case Context

The owner uses this for:
1. Dutch→Russian/English conversation translation summaries
2. Meeting/conversation recording analysis (like Gemini Notes or Plaud Note)
3. General AI assistant via Android phone in the Netherlands

The real-time translation is handled on-device by RTranslator (offline). This gateway handles the heavier AI tasks (summarization, analysis) where latency is acceptable.
