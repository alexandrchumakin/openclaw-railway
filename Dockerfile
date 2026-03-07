FROM node:22-slim

RUN apt-get update && apt-get install -y gettext-base && rm -rf /var/lib/apt/lists/*
RUN npm install -g openclaw@latest

RUN mkdir -p /root/.openclaw

COPY openclaw.json /root/.openclaw/openclaw.json

CMD ["sh", "-c", "envsubst < /root/.openclaw/openclaw.json > /tmp/config.json && cp /tmp/config.json /root/.openclaw/openclaw.json && openclaw gateway --port ${PORT:-18789}"]
