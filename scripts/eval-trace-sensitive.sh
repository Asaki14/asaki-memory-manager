#!/usr/bin/env bash
# Offline classification eval for the trace-specific secret gate (plan §8.2b, eval E5).
#
# Contract: given ONE tool argument, does the per-line gate drop the whole trace line or keep it?
# The gate is the trace list PLUS the canonical secret list, and it always runs on the ORIGINAL
# argument — before redaction, which would otherwise rewrite `ssh -i /Users/a/.ssh/id_x` into
# `ssh -i <path>` and manufacture a false negative.
#
# Both client copies are exercised per case and must agree with the fixture:
#   1. integrations/claude-code/build-delta.mjs (Claude Code hook);
#   2. the `#region asaki-trace-builder` block of integrations/pi/asaki-memory.ts (Pi extension).
#
# A "keep" verdict does NOT mean the line leaves the machine as written — paths, URIs and hosts
# are bounded by the R1–R5 redaction rules, which scripts/eval-trace-builder.mjs asserts. This
# eval only pins pattern classification. No network, no model, no Worker.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES="$ROOT/test/fixtures/trace-sensitive-cases.json"

# One verdict pair per fixture case, in fixture order: "<claude> <pi>".
VERDICTS=$(cd "$ROOT" && node --experimental-strip-types --no-warnings -e '
import { readFileSync } from "node:fs";
const claude = await import("./integrations/claude-code/build-delta.mjs");
const { loadPiTraceBuilder } = await import("./scripts/pi-trace-region.mjs");
const { module: pi, dispose } = await loadPiTraceBuilder();
const cases = JSON.parse(readFileSync("test/fixtures/trace-sensitive-cases.json", "utf8"));
for (const item of cases) {
  const claudeVerdict = claude.containsTraceSensitive(item.text) || claude.containsSensitive(item.text) ? "drop" : "keep";
  const piVerdict = pi.containsTraceSensitiveText(item.text) || pi.containsSensitiveText(item.text) ? "drop" : "keep";
  console.log(`${claudeVerdict} ${piVerdict}`);
}
dispose();
')

if [ -z "$VERDICTS" ]; then
  echo "failed to evaluate the trace gates (see errors above)." >&2
  exit 1
fi

PASS=0
FAIL=0
FAILURES=()

CASE_COUNT=$(jq 'length' "$FIXTURES")
for i in $(seq 0 $((CASE_COUNT - 1))); do
  CASE=$(jq -c ".[$i]" "$FIXTURES")
  NAME=$(echo "$CASE" | jq -r '.name')
  EXPECT=$(echo "$CASE" | jq -r '.expect')
  read -r CLAUDE_VERDICT PI_VERDICT < <(echo "$VERDICTS" | sed -n "$((i + 1))p")

  if [ "$CLAUDE_VERDICT" = "$EXPECT" ] && [ "$PI_VERDICT" = "$EXPECT" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$NAME: expected $EXPECT, got claude-code=$CLAUDE_VERDICT pi=$PI_VERDICT")
  fi
done

echo "trace-sensitive eval: ${PASS}/${CASE_COUNT} passed"
if [ "$FAIL" -gt 0 ]; then
  echo "fail:"
  for f in "${FAILURES[@]}"; do
    echo "- $f"
  done
  exit 1
fi
