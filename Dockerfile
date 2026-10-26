# syntax=docker/dockerfile:1.27.1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# The frontend that reads this file, pinned like the images below: it decides
# how every step builds. Refresh with
# `docker buildx imagetools inspect docker/dockerfile:1`.

# The base is pinned by digest as well as by tag, so a rebuild a year from now
# gets this runtime rather than whatever `24-trixie-slim` has moved to. The
# cost is that base image patches no longer arrive on their own: this line is
# something to bump on purpose. Refresh it with
#
#   docker buildx imagetools inspect node:24-trixie-slim
#
# and rebuild. The digest names the multi-platform index, so it resolves on
# both linux/amd64 (a typical server) and linux/arm64 (a Mac).
#
# Debian rather than Alpine because sharp's prebuilt libvips and Node itself
# are both better supported on glibc than on musl (design section 3).
ARG NODE_IMAGE=node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66

# ---------------------------------------------------------------- deps
# Every dependency, for the Vite build.
#
# pnpm comes from corepack, at the version package.json's `packageManager`
# field names, so the image installs with the same pnpm as a laptop. Only the
# two install stages have it. The runtime image has no package manager at all.
#
# This stage and the next run on the builder's own platform even when the
# image targets another one: the client bundle is the same bytes on every
# CPU, and running Vite under emulation would only make a cross build slow.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm
RUN --mount=type=cache,id=raccoon-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

# --------------------------------------------------------------- build
# The SPA into dist/. The PWA icons are committed under public/icons, so the
# build only copies them. `node scripts/icons.ts` is for when public/icon.svg
# changes, and its output is committed.
FROM deps AS build
COPY vite.config.ts ./
COPY client ./client
COPY shared ./shared
COPY public ./public
# The DM guide and its screenshots, which the build bundles into the app's
# /docs/dm-guide page (client/pages/DmGuide.tsx).
COPY docs/dm-guide.md ./docs/dm-guide.md
COPY docs/dm-guide ./docs/dm-guide
RUN pnpm build

# ----------------------------------------------------------- prod-deps
# Production dependencies only, in a clean stage that sees nothing but
# package.json and the lockfile. `pnpm deploy` would be the usual tool, but it
# is a workspace command and this is a single package (design section 15.1).
#
# This stage runs on the target platform, which is what puts the right native
# binaries in the image: pnpm installs only the optional packages that match
# the CPU and libc it runs on, so sharp's @img/sharp-linux-* and argon2's
# @node-rs/argon2-linux-*-gnu come out for the image's architecture. A cross
# build (`--platform linux/amd64` on an arm64 Mac) runs this under emulation.
FROM ${NODE_IMAGE} AS prod-deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm
RUN --mount=type=cache,id=raccoon-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --prod --frozen-lockfile --store-dir /pnpm/store

# ------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

# Configuration that is the same for every deployment, so baking it in is
# fine. No secret is ever an ARG or an ENV here: both are recorded in the
# image and come back out of `docker history` and `docker inspect` for anyone
# who can pull it. DATABASE_URL, SERPAPI_KEY and the Turnstile keys arrive at
# run time from the compose file.
#
# NODE_ENV=production makes the server refuse to start without PUBLIC_ORIGIN
# and both egress proxies, so an image run by hand with nothing set fails
# loudly instead of serving with development cookies.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    ASSET_DIR=/data/assets

# npm, npx, yarn and corepack ship with the base image. This one runs a
# single `node` command and needs none of them, and a package installer next
# to the app is the first thing anyone with code execution reaches for.
#
# /data/assets is created here, owned by `node`, because Docker seeds an empty
# named volume from the image's directory at that path, ownership included.
# Without it the volume would come up owned by root and every upload would
# fail with EACCES.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /data/assets \
 && chown node:node /data/assets

# Copied without --chown, so the app's own files are owned by root and read
# only to the `node` user. The server has no reason to rewrite its code, its
# schema or its static files, and a compromised one should not be able to.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY scripts ./scripts
COPY db ./db
COPY --from=build /app/dist ./dist

USER node
EXPOSE 3000

# Liveness only: /healthz answers while the HTTP server runs, and reports
# `degraded` (still a 200) rather than failing when a room is unhappy, so a
# struggling room never gets the whole container restarted under the table.
# Node's own fetch, because the image has no curl or wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# What a registry shows for the published image. .github/workflows/image.yml
# passes VERSION, REVISION and SOURCE_URL, the repository it builds from, so
# no file here names it. Last in the stage, because a changed build argument
# would otherwise rebuild every layer after it. The defaults mark a local
# build.
ARG VERSION=dev
ARG REVISION=unknown
ARG SOURCE_URL=
LABEL org.opencontainers.image.title="raccoon-vtt" \
      org.opencontainers.image.description="A self-hosted virtual tabletop for D&D groups playing the 2024 rules, made for phones first" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

# The server's .ts files run directly through Node's type stripping. There is
# no server build step.
CMD ["node", "server/main.ts"]
