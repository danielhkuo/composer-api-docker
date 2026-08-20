#!/usr/bin/env node
/**
 * node:http <-> WHATWG adapter for the upstream Cloudflare Worker.
 *
 * Upstream exports `handleRequest(request, env, ctx, deps)` separately from its
 * default module-worker export precisely so it can be driven without workerd
 * (upstream worker/index.ts; its own vitest suite calls it the same way).
 * This file supplies the four things Cloudflare would otherwise provide:
 * an HTTP listener, an `env` bag, an `ExecutionContext`, and stubs for the
 * bindings we deliberately do not run (D1 / R2 / ASSETS / Durable Objects).
 *
 * Nothing here modifies upstream source. See README "Why this stays downstream".
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { handleRequest } from "./worker.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));

const BUILD_INFO = (() => {
  try {
    return JSON.parse(readFileSync(new URL("./build-info.json", import.meta.url), "utf8"));
  } catch {
    return { upstreamSha: "unknown", upstreamRef: "unknown", builtAt: "unknown" };
  }
})();

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 32 * 1024 * 1024);

/** Your own Cursor key. When set, clients may authenticate with any token
 *  (matching how the upstream macOS app behaves: "apiKey: local"). */
const CURSOR_API_KEY = (process.env.CURSOR_API_KEY || "").trim();
/** Optional shared secret gating this container. Strongly recommended if you
 *  ever bind beyond 127.0.0.1. */
const LOCAL_API_TOKEN = (process.env.LOCAL_API_TOKEN || "").trim();

/* ------------------------------------------------------------------ bindings */

/** Cloudflare would inject a static-asset Fetcher here. This container is an
 *  API, not the marketing site, so every asset path is a JSON 404. */
const ASSETS = {
  async fetch() {
    return Response.json(
      { error: { message: "This container serves the API only. Use /v1/*.", type: "not_found", code: "not_found" } },
      { status: 404 }
    );
  }
};

/** D1 is intentionally absent. Upstream's SDK-session persistence is wrapped in
 *  try/catch and degrades silently by design; the `cmp_` hosted-key flow is not
 *  supported here and fails loudly rather than mysteriously. */
const DB = {
  prepare() {
    throw new Error(
      "No database is configured in this container. Hosted `cmp_...` proxy keys are unsupported; " +
        "send your Cursor API key as the bearer token instead."
    );
  }
};

const env = {
  ASSETS,
  DB,
  RELEASES: undefined,
  CURSOR_SDK_BRIDGE_CONTAINER: undefined, // forces the plain-HTTP bridge branch
  CURSOR_API_BASE: process.env.CURSOR_API_BASE || "https://api.cursor.com",
  CURSOR_CLIENT_VERSION: process.env.CURSOR_CLIENT_VERSION || undefined,
  CURSOR_SDK_CLIENT_VERSION: process.env.CURSOR_SDK_CLIENT_VERSION || undefined,
  CURSOR_SDK_BRIDGE_URL: process.env.CURSOR_SDK_BRIDGE_URL || undefined,
  CURSOR_SDK_BRIDGE_TOKEN: process.env.CURSOR_SDK_BRIDGE_TOKEN || undefined,
  CURSOR_SDK_BRIDGE_TIMEOUT_MS: process.env.CURSOR_SDK_BRIDGE_TIMEOUT_MS || undefined
};

/** Cloudflare's ExecutionContext. `waitUntil` exists to keep an isolate alive
 *  past the response; a long-lived Node process needs only the error sink. */
const ctx = {
  waitUntil(promise) {
    Promise.resolve(promise).catch((error) => console.error("[waitUntil]", error));
  },
  passThroughOnException() {},
  props: {}
};

/* --------------------------------------------------------------- conversion */

// Hop-by-hop headers are connection-scoped and must not be forwarded.
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authorization", "proxy-authenticate"
]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > MAX_BODY_BYTES) {
      reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Mirrors upstream's bearerToken(): Authorization header, else x-api-key. */
function headerToken(headers) {
  const match = /^Bearer\s+(.+)$/i.exec((headers.get("authorization") || "").trim());
  if (match) return match[1].trim();
  return (headers.get("x-api-key") || "").trim();
}

function toWebRequest(req, body, signal) {
  const host = req.headers.host || `localhost:${PORT}`;
  const url = new URL(req.url || "/", `http://${host}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key) || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
  }

  // Personal-container convenience: the container holds the Cursor key, so any
  // bearer token the client insists on is accepted and swapped out.
  //
  // Deliberately only swaps when the client presented *some* token. Injecting
  // unconditionally would make a tokenless request succeed, turning anything
  // that can reach this port into an authenticated caller. A `cmp_` token is
  // left alone so it still fails closed rather than being silently upgraded.
  if (CURSOR_API_KEY) {
    const presented = headerToken(headers);
    if (presented && !presented.startsWith("cmp_")) {
      headers.set("authorization", `Bearer ${CURSOR_API_KEY}`);
      headers.delete("x-api-key");
    }
  }

  const hasBody = req.method !== "GET" && req.method !== "HEAD" && body.length > 0;
  return new Request(url, { method: req.method, headers, body: hasBody ? body : undefined, signal });
}

async function writeWebResponse(res, response) {
  const headers = {};
  for (const [key, value] of response.headers) headers[key] = value;
  const setCookie = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  if (setCookie.length) headers["set-cookie"] = setCookie;

  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  // Streamed straight through so SSE deltas reach the client as they are
  // produced rather than at end-of-response.
  const stream = Readable.fromWeb(response.body);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

/* ------------------------------------------------------------------- routing */

function presentedToken(req) {
  const auth = req.headers["authorization"];
  const match = /^Bearer\s+(.+)$/i.exec(String(auth || "").trim());
  if (match) return match[1].trim();
  const apiKey = req.headers["x-api-key"];
  return apiKey ? String(apiKey).trim() : "";
}

const server = http.createServer(async (req, res) => {
  req.socket.setNoDelay(true);

  if (req.method === "GET" && (req.url === "/health" || req.url === "/healthz")) {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        baseUrl: `http://127.0.0.1:${PORT}/v1`,
        bridgeConfigured: Boolean(env.CURSOR_SDK_BRIDGE_URL),
        cursorKeyMode: CURSOR_API_KEY ? "container" : "client-supplied",
        accessGated: Boolean(LOCAL_API_TOKEN),
        upstream: BUILD_INFO
      })
    );
    return;
  }

  if (LOCAL_API_TOKEN && presentedToken(req) !== LOCAL_API_TOKEN) {
    res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({ error: { message: "Invalid LOCAL_API_TOKEN", type: "unauthorized", code: "unauthorized" } })
    );
    return;
  }

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const body = await readBody(req);
    const request = toWebRequest(req, body, controller.signal);
    const response = await handleRequest(request, env, ctx, undefined);
    await writeWebResponse(res, response);
  } catch (error) {
    const status = error?.statusCode || 500;
    console.error("[request]", error);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        error: { message: error?.message || "Internal error", type: "internal_error", code: "internal_error" }
      })
    );
  }
});

// Model turns legitimately run for minutes; the defaults would sever them.
server.requestTimeout = 0;
server.timeout = 0;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 75_000;

server.listen(PORT, HOST, () => {
  console.log(`api-for-cursor listening on http://${HOST}:${PORT}/v1`);
  console.log(`  upstream   ${BUILD_INFO.upstreamRef} @ ${String(BUILD_INFO.upstreamSha).slice(0, 12)}`);
  console.log(`  bridge     ${env.CURSOR_SDK_BRIDGE_URL || "NOT CONFIGURED (chat/responses will fail)"}`);
  console.log(`  cursor key ${CURSOR_API_KEY ? "supplied by container" : "expected from client bearer token"}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`\n${signal} received, closing`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
