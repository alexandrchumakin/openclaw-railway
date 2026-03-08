FROM node:22-slim

RUN apt-get update && apt-get install -y git socat && rm -rf /var/lib/apt/lists/*
RUN npm install -g openclaw@latest

RUN mkdir -p /root/.openclaw

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

COPY openclaw.json /root/.openclaw/openclaw.json

CMD ["/entrypoint.sh"]
