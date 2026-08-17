# Node 24 runs the server's TypeScript directly by stripping types, so there
# is no server build step — only the client is bundled.

FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN npx vite build

# ---------------------------------------------------------------------------

FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Only production dependencies; the client is already built.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scenarios ./scenarios
COPY --from=build /app/dist ./dist

# SQLite lives here. Mount a volume so a container restart does not end a
# session that is mid-show.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app

# 8880 rather than the usual 8080: far less likely to collide, and still on
# Cloudflare's proxyable HTTP port list so a plain port-forward works too.
ENV PORT=8880
EXPOSE 8880

USER node

HEALTHCHECK --interval=30s --timeout=4s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8880)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server/index.ts"]
