FROM node:22-slim

RUN apt-get update && apt-get install -y git socat && rm -rf /var/lib/apt/lists/*
RUN npm install -g openclaw@latest

RUN mkdir -p /root/.openclaw

COPY openclaw.json /root/.openclaw/openclaw.json

CMD ["sh", "-c", "openclaw gateway --port 18789 & sleep 5 && socat TCP-LISTEN:${PORT:-8080},fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:18789"]
