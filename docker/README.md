# Docker deployment

Runs this fork's OpenAI-compatible `/v1` API on Linux (x86_64) without the macOS app.
Everything here is **additive** — no file under `worker/`, `scripts/`, or `macos/` is
modified, so merges from upstream should never conflict.

```
your client ──► api container ──────► bridge container ──────► api.cursor.com
(hermes, etc)   worker/ bundled       scripts/cursor-sdk-
                + docker/server.mjs   local-agent-bridge.mjs
```

## How it works

`worker/index.ts` exports `handleRequest` separately from its module-worker default
so it can run without workerd — this repo's own vitest suite drives it that way under
plain Node. `docker/server.mjs` supplies the four things Cloudflare would otherwise
provide: an HTTP listener, an `env` bag, an `ExecutionContext`, and stubs for D1 / R2 /
ASSETS / Durable Objects.

`worker/` has exactly one non-relative import (`@cloudflare/containers`), aliased to a
stub, so esbuild bundles the whole tree with no Cloudflare dependencies.

In direct-bearer mode a bare `/v1/...` request with a non-`cmp_` token never touches
D1 (see the comment in `worker/index.ts`), and setting `CURSOR_SDK_BRIDGE_URL` selects
the plain-HTTP bridge branch instead of the Durable Object. So no Cloudflare bindings
are needed.

## Local development

```bash
cp docker/.env.example docker/.env      # set CURSOR_API_KEY and BRIDGE_TOKEN
docker compose -f docker/docker-compose.yml up -d --build
curl -s http://127.0.0.1:8787/health
```

If port 8787 is taken, the macOS *API for Cursor* app is probably running — quit it or
set `BIND_PORT`.

## Unraid

Unraid is x86_64-only and cannot build these images (its bundled buildx is too old for
`docker compose build`), so it pulls prebuilt images published by CI. Use
[`unraid/docker-compose.yml`](unraid/docker-compose.yml) and follow its header comment.

Two things that are easy to miss:

- **Settings → Docker → Advanced → "Preserve user defined networks" = Yes.** Defaults to
  No; Unraid deletes networks it did not create on every array restart, so the stack works
  until your first reboot and then breaks confusingly.
- **Do not publish to `127.0.0.1` and expect a sibling container to reach it.** A loopback
  publish emits a DNAT rule with `-d 127.0.0.1/32`, so only the host's own loopback matches.

### Connecting another container (e.g. hermes)

Put it on the `cursor-api` network — in an Unraid template set the **Network Type dropdown
itself** to `cursor-api` (Extra Parameters will not work, and Unraid's default "Bridge" has
no embedded DNS). Then point the client at:

```
http://cursor-api:8787/v1
```

with any non-empty bearer token (`local` is conventional). A tokenless request returns 401
by design — the container swaps a presented token for your real Cursor key but never
injects into a tokenless request.

## Staying current with upstream

`.github/workflows/docker-sync-upstream.yml` merges `standardagents/composer-api` into
`main` daily. Because everything added lives in `docker/` and `.github/workflows/docker-*`,
the merge is purely additive and should not conflict. A push to `main` then triggers
`docker-build.yml`, which checks bridge-Dockerfile drift, builds `linux/amd64`, smoke tests
with no credentials, and publishes to GHCR.

Manually:

```bash
git fetch upstream && git merge upstream/main && git push origin main
```

## Not included

`/api/signup` and hosted `cmp_` proxy keys (needs D1), the marketing site and `/chat`
playground (needs ASSETS), and DMG/appcast serving (needs R2). Streaming is buffered
rather than incremental: `worker/index.ts` awaits the full bridge call before emitting
SSE, so nothing goes over the wire until the model finishes. The macOS app sets
`streamEvents: true` on the bridge and streams token-by-token; the worker does not.

## A non-technical note

Upstream's README states Cursor asked them to take down the *hosted* API path, and the
production path is the signed macOS app. A single-user container on your own machine or
server — one Cursor key, one caller — is the close analogue of that app. A shared
multi-tenant deployment serving many people's keys is not. That distinction is about how
you run it, and it is your call as the account holder.
