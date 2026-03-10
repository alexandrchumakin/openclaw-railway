FROM node:22-slim

RUN apt-get update && apt-get install -y git socat curl netcat-openbsd && rm -rf /var/lib/apt/lists/*

# Install Playwright with Chromium for fetching JS-heavy pages
RUN cd /opt && npm install playwright@latest && npx playwright install --with-deps chromium

# Install Cursor CLI (agent)
RUN curl https://cursor.com/install -fsS | bash
ENV PATH="/root/.local/bin:${PATH}"
ENV CURSOR_AGENT_BIN="/root/.local/bin/agent"

# Install OpenClaw
RUN npm install -g openclaw@latest

# Install cursor-api-proxy
RUN cd /opt && git clone https://github.com/anyrobert/cursor-api-proxy.git && \
    cd cursor-api-proxy && npm install && npm run build

RUN mkdir -p /root/.openclaw/agents/main/sessions /root/.openclaw/credentials
RUN chmod 700 /root/.openclaw

ENV NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
ENV OPENCLAW_NO_RESPAWN=1
RUN mkdir -p /var/tmp/openclaw-compile-cache

COPY search-proxy.js /opt/search-proxy.js
COPY search-middleware.js /opt/search-middleware.js
COPY SOUL.md /opt/SOUL.md
COPY router.js /opt/router.js
COPY openclaw.json /opt/openclaw-template.json
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]
