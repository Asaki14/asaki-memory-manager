#!/usr/bin/env node
/**
 * Points this clone's git hooks at the tracked `.githooks/` directory.
 *
 * Runs automatically from the npm `prepare` lifecycle (i.e. on `npm install`), which is the only
 * way a *tracked* hook actually reaches a fresh clone — `.git/hooks` is never checked out.
 *
 * Deliberately best-effort: it must never fail an install. It no-ops outside a git worktree, in CI
 * (hooks there would be pure noise — the CI drift job is the check), and when `core.hooksPath`
 * already points somewhere else the developer chose.
 *
 * It also no-ops in a LINKED WORKTREE: `git config core.hooksPath` there writes the repository's
 * *shared* config, so an `npm install` inside a throwaway worktree would silently repoint hooks
 * for the primary checkout and every sibling worktree — and on any branch without `.githooks/`
 * that means every hook is silently disabled. Not a side effect an install is allowed to have.
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_PATH = ".githooks";

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

if (process.env.CI || process.env.ASAKI_SKIP_HOOK_INSTALL) process.exit(0);

try {
  git(["rev-parse", "--is-inside-work-tree"]);
} catch {
  process.exit(0); // not a git checkout (tarball install, vendored copy) — nothing to wire up
}

try {
  const gitDir = git(["rev-parse", "--absolute-git-dir"]);
  const commonDir = resolve(ROOT, git(["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  if (gitDir !== commonDir) {
    console.log("install-git-hooks: linked worktree detected; not touching the shared core.hooksPath.");
    console.log(`install-git-hooks: run hooks from here with: git -c core.hooksPath=${HOOKS_PATH} commit ...`);
    process.exit(0);
  }
} catch {
  process.exit(0);
}

let current = "";
try {
  current = git(["config", "--get", "core.hooksPath"]);
} catch {
  current = "";
}

if (current === HOOKS_PATH) process.exit(0);
if (current) {
  console.log(`install-git-hooks: core.hooksPath is already set to "${current}"; leaving it alone.`);
  console.log(`install-git-hooks: to enable the MCP bundle guard: git config core.hooksPath ${HOOKS_PATH}`);
  process.exit(0);
}

try {
  git(["config", "core.hooksPath", HOOKS_PATH]);
  console.log(`install-git-hooks: core.hooksPath -> ${HOOKS_PATH} (MCP bundle guard active)`);
} catch {
  process.exit(0);
}
