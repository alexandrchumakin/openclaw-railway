FROM node:22-slim

RUN apt-get update && apt-get install -y git socat && rm -rf /var/lib/apt/lists/*
RUN npm install -g openclaw@latest

RUN mkdir -p /root/.openclaw/agents/main/sessions /root/.openclaw/credentials
RUN chmod 700 /root/.openclaw

ENV NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
ENV OPENCLAW_NO_RESPAWN=1
RUN mkdir -p /var/tmp/openclaw-compile-cache

COPY openclaw.json /root/.openclaw/openclaw.json
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]
