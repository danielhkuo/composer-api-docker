/**
 * Bundles this fork's worker/ into a single Node-native ESM file.
 *
 * esbuild is required for two reasons Node alone cannot cover: worker/ uses
 * extensionless relative imports (`from "./cursor"`) which Node ESM will not
 * resolve, and `@cloudflare/containers` -- the ONLY non-relative import in the
 * entire worker/ tree -- must be aliased to a stub.
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(ROOT, "dist");
mkdirSync(DIST, { recursive: true });

await build({
  entryPoints: [resolve(ROOT, "worker/index.ts")],
  outfile: resolve(DIST, "worker.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
  alias: { "@cloudflare/containers": resolve(ROOT, "stubs/cloudflare-containers.mjs") }
});

cpSync(resolve(ROOT, "server.mjs"), resolve(DIST, "server.mjs"));

const sha = process.env.SOURCE_SHA || "dev";
writeFileSync(
  resolve(DIST, "build-info.json"),
  JSON.stringify({ upstreamRepo: "fork of standardagents/composer-api", upstreamRef: sha, upstreamSha: sha, builtAt: new Date().toISOString() }, null, 2)
);
console.log(`bundled worker @ ${sha}`);
