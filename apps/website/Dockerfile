FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json ./package.json
COPY cloud ./cloud
COPY i18n ./i18n
COPY public ./public
COPY scripts ./scripts

RUN node scripts/build-site.mjs

FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=8091

WORKDIR /app
COPY server.mjs ./server.mjs
COPY --from=build /app/dist ./dist

USER node
EXPOSE 8091

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8091) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.mjs"]
