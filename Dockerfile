FROM node:22-slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
RUN npm install -g openclaw@latest

RUN mkdir -p /root/.openclaw

COPY openclaw.json /root/.openclaw/openclaw.json

CMD ["sh", "-c", "openclaw gateway --host 0.0.0.0 --port ${PORT:-8080}"]
