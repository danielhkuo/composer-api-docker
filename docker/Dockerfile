# syntax=docker/dockerfile:1.7
#
# Build context is the REPO ROOT (this is a fork, so upstream source is in-tree).
#   --target api     OpenAI-compatible /v1 server: worker/ bundled + docker/server.mjs
#   --target bridge  upstream scripts/cursor-sdk-local-agent-bridge.mjs
#
# Nothing under worker/ or scripts/ is modified. Everything additive lives in docker/.

ARG NODE_IMAGE=node:22-alpine

# ------------------------------------------------------------------- build ---
FROM ${NODE_IMAGE} AS build
ARG SOURCE_SHA=dev
ENV SOURCE_SHA=${SOURCE_SHA}
WORKDIR /build
COPY docker/package.json docker/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY docker/bundle.mjs ./bundle.mjs
COPY docker/server.mjs ./server.mjs
COPY docker/stubs ./stubs
COPY worker ./worker
RUN node bundle.mjs

# --------------------------------------------------------------------- api ---
FROM ${NODE_IMAGE} AS api
WORKDIR /app
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0
COPY --from=build /build/dist ./
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]

# ------------------------------------------------------------------ bridge ---
# Mirrors containers/cursor-sdk-bridge/Dockerfile (upstream's own), plus the
# /workspace fix below. docker/check-bridge-drift.sh fails CI if upstream's
# version changes so this stays in step.
FROM ${NODE_IMAGE} AS bridge
WORKDIR /app
ENV NODE_ENV=production \
    CURSOR_SDK_BRIDGE_HOST=0.0.0.0 \
    CURSOR_SDK_BRIDGE_PORT=8792
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY scripts/cursor-sdk-local-agent-bridge.mjs ./scripts/cursor-sdk-local-agent-bridge.mjs
# /workspace MUST exist in the image owned by the runtime user. Docker only
# propagates image ownership onto a fresh named volume when the mount path
# already exists (moby populateVolume stats it and returns early if absent);
# otherwise it is created root:root and the uid-1000 process gets EACCES.
RUN mkdir -p /workspace && chown node:node /workspace
EXPOSE 8792
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CURSOR_SDK_BRIDGE_PORT||8792)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/cursor-sdk-local-agent-bridge.mjs"]
