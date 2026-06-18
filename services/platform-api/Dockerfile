FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    RUNTIME_ENV=production \
    PORT=8787 \
    RELAY_STORE_DRIVER=sqlite \
    RELAY_STORE_PATH=/var/lib/velarumpay/relay-store.sqlite \
    RELAY_STORE_LEGACY_JSON=/var/lib/velarumpay/relay-store.json

WORKDIR /app

COPY services/platform-api/package*.json ./services/platform-api/
RUN cd services/platform-api && npm ci --omit=dev

COPY packages/protocol ./packages/protocol
COPY services/platform-api/src ./services/platform-api/src
COPY services/platform-api/scripts ./services/platform-api/scripts
COPY services/platform-api/.env.example ./services/platform-api/.env.example

RUN mkdir -p /var/lib/velarumpay /var/backups/velarumpay \
  && chown -R node:node /app /var/lib/velarumpay /var/backups/velarumpay

USER node
WORKDIR /app/services/platform-api
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "run", "start:production"]
