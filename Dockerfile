FROM node:22-slim

RUN apt-get update && apt-get install -y git socat curl netcat-openbsd python3 gcalcli && rm -rf /var/lib/apt/lists/*

# Install Playwright with Chromium for fetching JS-heavy pages
RUN cd /opt && npm install playwright@latest && npx playwright install --with-deps chromium

# Install Cursor CLI (agent)
RUN curl https://cursor.com/install -fsS | bash
ENV PATH="/root/.local/bin:${PATH}"
ENV CURSOR_AGENT_BIN="/root/.local/bin/agent"

# Install OpenClaw
RUN npm install -g openclaw@latest grammy @grammyjs/runner @grammyjs/transformer-throttler @grammyjs/types
RUN openclaw plugins install @openclaw/whatsapp
# Install missing peer deps INTO OpenClaw's node_modules so jiti can resolve them
RUN cd /usr/local/lib/node_modules/openclaw && npm install --no-save @buape/carbon @larksuiteoapi/node-sdk

# Install cursor-api-proxy
RUN cd /opt && git clone https://github.com/anyrobert/cursor-api-proxy.git && \
    cd cursor-api-proxy && npm install && npm run build

RUN mkdir -p /root/.openclaw/agents/main/sessions /root/.openclaw/credentials/whatsapp
RUN chmod 700 /root/.openclaw

# Create agent workspace with rules that forbid web tools (they're sandboxed and always fail)
RUN mkdir -p /opt/agent-workspace/.cursor/rules
COPY .cursorrules /opt/agent-workspace/.cursorrules

ENV NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
ENV OPENCLAW_NO_RESPAWN=1
RUN mkdir -p /var/tmp/openclaw-compile-cache

COPY search-proxy.js /opt/search-proxy.js
COPY search-middleware.js /opt/search-middleware.js
COPY SOUL.md /opt/SOUL.md
COPY router.js /opt/router.js
COPY node-auto-approve.js /opt/node-auto-approve.js
COPY wa-link.js /opt/wa-link.js
COPY openclaw.json /opt/openclaw-template.json
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]
