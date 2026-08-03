FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=8093

WORKDIR /app
COPY apps/merchant-portal/server.mjs ./server.mjs
COPY apps/merchant-portal/public ./public
COPY apps/merchant-portal/src ./src

USER node
EXPOSE 8093

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8093) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.mjs"]
