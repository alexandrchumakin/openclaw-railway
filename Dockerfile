FROM node:22-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf

RUN apt-get update && apt-get install -y coreutils util-linux git socat curl netcat-openbsd python3 python3-setuptools gcalcli && rm -rf /var/lib/apt/lists/*

# Install Playwright with Chromium for fetching JS-heavy pages
RUN cd /opt && npm install playwright@1.61.1 && npx playwright install --with-deps chromium
RUN npm install -g chrome-devtools-mcp@1.5.0

# Pin Cursor CLI so rebuilds cannot silently change request behavior.
ARG TARGETARCH
ARG CURSOR_AGENT_VERSION=2026.07.09-a3815c0
RUN case "$TARGETARCH" in \
      amd64) CURSOR_ARCH=x64; CURSOR_SHA256=c7c1f32249cedb99cc20cd4eed1f9308dc2299a78c283bbc6efd6d658cd4977e ;; \
      arm64) CURSOR_ARCH=arm64; CURSOR_SHA256=11b2b6801136a11a3632a4b1080ea3bfc7d97d0a68382be9ede1faf5333207fb ;; \
      *) echo "Unsupported Cursor Agent architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://downloads.cursor.com/lab/${CURSOR_AGENT_VERSION}/linux/${CURSOR_ARCH}/agent-cli-package.tar.gz" -o /tmp/cursor-agent.tar.gz && \
    echo "${CURSOR_SHA256}  /tmp/cursor-agent.tar.gz" | sha256sum -c - && \
    mkdir -p "/root/.local/share/cursor-agent/versions/${CURSOR_AGENT_VERSION}" /root/.local/bin && \
    tar --strip-components=1 -xzf /tmp/cursor-agent.tar.gz -C "/root/.local/share/cursor-agent/versions/${CURSOR_AGENT_VERSION}" && \
    ln -s "/root/.local/share/cursor-agent/versions/${CURSOR_AGENT_VERSION}/cursor-agent" /root/.local/bin/agent && \
    ln -s "/root/.local/share/cursor-agent/versions/${CURSOR_AGENT_VERSION}/cursor-agent" /root/.local/bin/cursor-agent && \
    rm /tmp/cursor-agent.tar.gz
ENV PATH="/root/.local/bin:${PATH}"
ENV CURSOR_AGENT_BIN="/root/.local/bin/agent"
RUN test "$(agent --version)" = "$CURSOR_AGENT_VERSION"

# Pin the first OpenClaw release containing Telegram stop-timeout recovery
# (openclaw/openclaw#94016). Stable 2026.6.11 does not contain that fix.
RUN npm install -g openclaw@2026.7.1-beta.6 grammy@1.44.0 @grammyjs/runner@2.0.3 @grammyjs/transformer-throttler@1.2.1 @grammyjs/types@3.28.0
RUN openclaw plugins install @openclaw/whatsapp@2026.6.11
# Install missing peer deps INTO OpenClaw's node_modules so jiti can resolve them
RUN cd /usr/local/lib/node_modules/openclaw && npm install --no-save --legacy-peer-deps @buape/carbon@0.16.0 @larksuiteoapi/node-sdk@1.71.0

# Install cursor-api-proxy
ARG CURSOR_API_PROXY_COMMIT=90b518ea6e8c958e92bc6a48974e525466f6fbe7
COPY cursor-api-proxy-cancellation.patch /tmp/cursor-api-proxy-cancellation.patch
COPY cursor-api-proxy-stream-parser.patch /tmp/cursor-api-proxy-stream-parser.patch
RUN cd /opt && git clone https://github.com/anyrobert/cursor-api-proxy.git && \
    cd cursor-api-proxy && git checkout "$CURSOR_API_PROXY_COMMIT" && \
    git apply --recount --check /tmp/cursor-api-proxy-cancellation.patch && \
    git apply --recount /tmp/cursor-api-proxy-cancellation.patch && \
    git apply --recount --check /tmp/cursor-api-proxy-stream-parser.patch && \
    git apply --recount /tmp/cursor-api-proxy-stream-parser.patch && \
    npm ci && npm test && npm run build && \
    rm /tmp/cursor-api-proxy-cancellation.patch /tmp/cursor-api-proxy-stream-parser.patch

RUN mkdir -p /root/.openclaw/agents/main/sessions /root/.openclaw/credentials/whatsapp
RUN chmod 700 /root/.openclaw

# Create agent workspace with rules that forbid web tools (they're sandboxed and always fail)
RUN mkdir -p /opt/agent-workspace/.cursor/rules
COPY .cursorrules /opt/agent-workspace/.cursorrules
COPY mcp.json /opt/agent-workspace/mcp.json
COPY mcp.json /opt/agent-workspace/.cursor/mcp.json

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
COPY merge-openclaw-config.js /opt/merge-openclaw-config.js
COPY telegram-health-check.js /opt/telegram-health-check.js
COPY gcalcli-wrapper.sh /usr/local/bin/gcalcli
COPY gcalcli-credential-check.py /usr/local/libexec/gcalcli-credential-check
COPY prepare-gcalcli-credentials.sh /usr/local/libexec/prepare-gcalcli-credentials
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /usr/local/bin/gcalcli /usr/local/libexec/gcalcli-credential-check /usr/local/libexec/prepare-gcalcli-credentials

CMD ["/entrypoint.sh"]
