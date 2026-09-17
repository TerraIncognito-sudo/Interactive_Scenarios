# The vote relay.
#
# Node 24 runs its TypeScript directly by stripping types, so there is no
# server build step — only the three browser pages are bundled.
#
# What is not in this image is the point of it. There is no scenario, no
# engine, no `yaml` and no `qrcode`: the relay carries votes between phones
# and a client, and it could not read a scenario if you handed it one. That
# used to be a rule people kept by care, the way "the game server never learns
# about Python" was; here it is enforced by the dependency list and by
# `tests/relay.test.ts`, which walks the import graph from `server/index.ts`
# and asserts the whole of what it borrows is one protocol file.
#
# The consequence worth stating plainly: a key stolen off this box buys the
# ability to open a room and publish a poll to some phones. It does not buy
# the show.

FROM node:24-alpine AS build
WORKDIR /app

# The root manifest and the relay's, and deliberately not the other two.
#
# npm skips a workspace whose folder holds no manifest, and that is what
# actually keeps `yaml` out of this image. Copy `shared/package.json` here and
# yaml lands in the hoisted tree even under `--workspace server` below, where
# it sits as an *extraneous* package that `npm prune` will not remove either.
# The parser that must not be in this container is kept out by not describing
# the workspace that needs one.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
RUN npm ci

# The root Vite config is the relay's: three entries, `server/web` for a root,
# and no projector. The stage is built by `client/vite.config.ts`, which is
# never run here — it would be bundling the one surface this image must not
# serve.
COPY tsconfig.json vite.config.ts ./
COPY shared/relay ./shared/relay
COPY server ./server
RUN npx vite build

# ---------------------------------------------------------------------------

FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Only the relay's own dependencies: 62 packages, not one of which can read
# a scenario. The same two manifests as the build stage, for the same reason.
#
# The workspace filter is redundant while only one workspace is described, and
# is kept anyway because it says which workspace this image is -- rather than
# leaving that to be inferred from a COPY line somebody could helpfully add a
# sibling to.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
RUN npm ci --omit=dev --workspace server --include-workspace-root \
  && npm cache clean --force

# One folder out of `shared`, not the whole of it. The engine and the
# scenario loader live next door to this in the repo and have no business in
# here -- the header's claim is meant to be true of the filesystem, not only
# of what gets imported.
#
# It travels as source rather than through node_modules, which is deliberate:
# Node refuses to strip types for any file under a node_modules segment, so a
# package-name import would be a container that will not start.
COPY shared/relay ./shared/relay
COPY server ./server
COPY --from=build /app/dist ./dist

# SQLite lives here, and it is now the only copy of a vote cast while the
# client is disconnected — as well as of every issued key. Mount a volume.
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
