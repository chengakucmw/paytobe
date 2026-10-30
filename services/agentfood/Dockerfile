FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    AGENTFOOD_RUNTIME_ENV=production \
    PORT=8791 \
    AGENTFOOD_STORE_PATH=/var/lib/agentfood/agentfood-store.json

WORKDIR /app
COPY services/agentfood/package.json ./services/agentfood/package.json
COPY packages/protocol ./packages/protocol
COPY packages/sdk-js ./packages/sdk-js
COPY services/agentfood/src ./services/agentfood/src
COPY services/agentfood/public ./services/agentfood/public

RUN mkdir -p /var/lib/agentfood /app/node_modules/@Paytobe \
  && ln -s /app/packages/protocol /app/node_modules/@Paytobe/protocol \
  && chown -R node:node /app /var/lib/agentfood

USER node
WORKDIR /app/services/agentfood
EXPOSE 8791

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8791) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "run", "start:production"]
