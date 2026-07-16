# __APP_NAME__/Dockerfile — self-authored app "__APP_NAME__"
# Minimal Node.js example. Replace with your stack (Go, Python, etc.).
# The server MUST listen on 0.0.0.0:__APP_PORT__ (matches the Caddy label).

FROM node:22-alpine

WORKDIR /app

# Copy source (app/ holds your code). Add package.json + npm ci for real deps.
COPY app/ /app/

EXPOSE __APP_PORT__

CMD ["node", "server.mjs"]
