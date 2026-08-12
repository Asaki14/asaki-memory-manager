#!/usr/bin/env node
/**
 * Deterministic build of the stdio MCP bundle (`dist/mcp-server.mjs`, consumed by Codex and other
 * stdio clients — Claude Code talks to the Worker's remote MCP endpoint instead).
 *
 * This replaces the bare `esbuild ...` CLI invocation because that invocation was only
 * *accidentally* deterministic. esbuild writes one `// <path>` comment per bundled module, and
 * that path is the module's real resolved location relative to the working directory. Two things
 * can therefore change the bytes without a single source line changing:
 *
 *   1. A stray nested `node_modules` between the entry file and the repo root. That is exactly
 *      what broke CI #86-#88 on 2026-07-21: a leftover `integrations/mcp/node_modules` from an
 *      older layout shadowed the root install, so every path comment came out as
 *      `integrations/mcp/node_modules/ajv/...` instead of `node_modules/ajv/...` — a 222-line
 *      diff with no source change behind it (fixed by 06ee0a7).
 *   2. A locally installed esbuild that does not match the lockfile pin (the caret range in
 *      package.json means an old `npm install` can leave a different patch behind, and esbuild
 *      output is not stable across versions).
 *
 * Both are turned into loud preflight failures here, and `absWorkingDir` is pinned to the repo
 * root so the output no longer depends on where the build was invoked from.
 *
 * Usage:
 *   node scripts/build-mcp.mjs            # write dist/mcp-server.mjs
 *   node scripts/build-mcp.mjs --check    # build to a temp file and diff, never touch dist/
 */

import { build } from "esbuild";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "integrations/mcp/asaki-memory.ts");
const OUTFILE = join(ROOT, "dist/mcp-server.mjs");

const CHECK = process.argv.includes("--check");

function fail(message) {
  console.error(`build:mcp: ${message}`);
  process.exit(1);
}

/**
 * Any `node_modules` below the repo root but at or above the entry file wins Node resolution over
 * the root install, which silently rewrites every bundled path comment.
 */
function assertNoShadowingNodeModules() {
  const shadowing = [];
  let dir = dirname(ENTRY);
  while (dir !== ROOT && dir.startsWith(ROOT)) {
    const candidate = join(dir, "node_modules");
    if (existsSync(candidate)) shadowing.push(relative(ROOT, candidate));
    dir = dirname(dir);
  }
  if (shadowing.length > 0) {
    fail(
      `nested dependency directories shadow the root install and change the bundle bytes:\n` +
        shadowing.map((p) => `  ${p}`).join("\n") +
        `\nremove them and rebuild:\n  rm -rf ${shadowing.join(" ")} && npm run build:mcp`,
    );
  }
}

/**
 * The lockfile is the only pin CI honours (`npm ci`); a local `npm install` against the caret
 * range can leave a different esbuild behind and produce a bundle CI will never reproduce.
 */
function assertPinnedEsbuild() {
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  const pinned = lock.packages?.["node_modules/esbuild"]?.version;
  const installed = JSON.parse(
    readFileSync(join(ROOT, "node_modules/esbuild/package.json"), "utf8"),
  ).version;
  if (!pinned) fail("package-lock.json does not pin esbuild");
  if (pinned !== installed) {
    fail(
      `installed esbuild ${installed} does not match the lockfile pin ${pinned}; ` +
        `esbuild output is not stable across versions.\n  fix: npm ci`,
    );
  }
}

async function bundleTo(outfile) {
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    // Pinned so the emitted `// <path>` comments are relative to the repo root no matter which
    // directory the build was started from.
    absWorkingDir: ROOT,
    logLevel: "warning",
  });
}

assertNoShadowingNodeModules();
assertPinnedEsbuild();

if (!CHECK) {
  await bundleTo(OUTFILE);
  console.log(`build:mcp: wrote ${relative(ROOT, OUTFILE)}`);
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), "asaki-mcp-build-"));
try {
  const candidate = join(tmp, "mcp-server.mjs");
  await bundleTo(candidate);
  const built = readFileSync(candidate);
  const committed = existsSync(OUTFILE) ? readFileSync(OUTFILE) : Buffer.alloc(0);
  if (!built.equals(committed)) {
    fail(
      `dist/mcp-server.mjs is out of date with its sources.\n` +
        `  fix: npm run build:mcp && git add dist/mcp-server.mjs`,
    );
  }
  console.log("build:mcp: dist/mcp-server.mjs matches its sources");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
