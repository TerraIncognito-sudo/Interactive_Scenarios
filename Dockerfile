# Node 24 runs the server's TypeScript directly by stripping types, so there
# is no server build step — only the client is bundled.

FROM node:24-alpine AS build
WORKDIR /app

# Every workspace manifest, because `npm ci` validates the whole workspace list
# before it installs anything -- a missing one fails the install outright.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm ci

COPY tsconfig.json vite.config.ts ./
COPY shared ./shared
COPY server ./server
RUN npx vite build

# ---------------------------------------------------------------------------

FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Only production dependencies; the browser bundles are already built.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm ci --omit=dev && npm cache clean --force

# `shared` travels with the server because the server imports it by relative
# path. Nothing here resolves through node_modules, which is deliberate: Node
# refuses to strip types for any file under a node_modules segment, so a
# package-name import would be a container that will not start.
COPY shared ./shared
COPY server ./server
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

CMD ["node", "server/index.ts"]
