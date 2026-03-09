FROM node:22-slim

RUN apt-get update && apt-get install -y git socat curl && rm -rf /var/lib/apt/lists/*

# Install Cursor CLI (agent)
RUN curl https://cursor.com/install -fsS | bash || true

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

COPY openclaw.json /root/.openclaw/openclaw-template.json
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]
