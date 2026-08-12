#!/usr/bin/env bash
# Offline eval for the MCP bundle guard.
#
# Part 1 — the decision function `asaki_bundle_input` / `asaki_bundle_inputs_touched`, sourced
#          straight out of .githooks/pre-commit via its library guard (ASAKI_BUNDLE_GUARD_LIB), so
#          this tests the shipped hook rather than a copy of it. The point of the table is the
#          boundary: everything that can change the bundle bytes must trip the guard, and ordinary
#          Worker/Pi/doc edits must not (a guard that fires on every commit gets bypassed).
#
# Part 2 — the deterministic build's two preflights (scripts/build-mcp.mjs): a nested
#          node_modules shadowing the root install must fail loudly (that was the 2026-07-21
#          CI #86-#88 root cause), and `--check` must agree with the committed bundle.
#
# No network, no model, no Worker.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ASAKI_BUNDLE_GUARD_LIB=1
export ASAKI_BUNDLE_GUARD_LIB
# shellcheck source=../.githooks/pre-commit
. "$ROOT/.githooks/pre-commit"
unset ASAKI_BUNDLE_GUARD_LIB

PASS=0
FAIL=0

check_path() {
  local path="$1" expected="$2" # expected: guard | ignore
  local actual="ignore"
  if asaki_bundle_input "$path"; then actual="guard"; fi
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $path -> $actual (expected $expected)" >&2
  fi
}

# --- bundle inputs: changing any of these can change dist/mcp-server.mjs -----------------------
check_path "integrations/mcp/asaki-memory.ts" guard
check_path "integrations/mcp/lib/helper.ts" guard
check_path "package-lock.json" guard
check_path "package.json" guard
check_path "scripts/build-mcp.mjs" guard
check_path ".githooks/pre-commit" guard

# --- not bundle inputs: the stdio bundle embeds none of these ----------------------------------
check_path "src/mcp.ts" ignore
check_path "src/services/memories.ts" ignore
check_path "integrations/pi/asaki-memory.ts" ignore
check_path "integrations/claude-code/stop-extract.sh" ignore
check_path "dist/mcp-server.mjs" ignore
check_path "AGENTS.md" ignore
check_path ".github/workflows/ci.yml" ignore

# --- the staged-set reducer ---------------------------------------------------------------------
check_set() {
  local expected="$1" # touched | untouched
  shift
  local actual="untouched"
  if printf '%s\n' "$@" | asaki_bundle_inputs_touched; then actual="touched"; fi
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: set [$*] -> $actual (expected $expected)" >&2
  fi
}

check_set untouched "README.md" "src/index.ts"
check_set touched "README.md" "integrations/mcp/asaki-memory.ts"
check_set touched "package-lock.json"
check_set untouched ""

# --- build determinism preflights ----------------------------------------------------------------
SHADOW="$ROOT/integrations/mcp/node_modules"
CREATED_SHADOW=0
if [ ! -e "$SHADOW" ]; then
  mkdir -p "$SHADOW"
  CREATED_SHADOW=1
fi
if node "$ROOT/scripts/build-mcp.mjs" --check >/dev/null 2>&1; then
  FAIL=$((FAIL + 1))
  echo "FAIL: build:mcp accepted a shadowing integrations/mcp/node_modules" >&2
else
  PASS=$((PASS + 1))
fi
[ "$CREATED_SHADOW" = "1" ] && rmdir "$SHADOW"

if node "$ROOT/scripts/build-mcp.mjs" --check >/dev/null; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "FAIL: dist/mcp-server.mjs does not match its sources (npm run build:mcp)" >&2
fi

echo "eval:bundle-guard: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
