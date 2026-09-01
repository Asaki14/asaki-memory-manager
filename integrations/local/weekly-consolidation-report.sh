#!/bin/bash
# Asaki Memory weekly consolidation report — local runner (source of truth).
#
# Ported from the retired cloud routine `asaki-memory-weekly-consolidation-report`
# (trig_01TySBjA96EWNeUJnmV63DcY), which died on the cloud sandbox's egress proxy
# because its credential store is UI-only. Same job, same READ-ONLY contract:
#   1. fetch pending reviews + all active global-scope memories,
#   2. have a headless `claude -p` analyse them for duplicates / contradictions /
#      staleness / wrong scope / noise,
#   3. emit a dry-run report with KEEP / UPDATE(rescope) / MERGE / DELETE labels.
# Nothing here calls a write endpoint, and the analysing model gets no tools and
# no credentials — it only ever sees the two JSON payloads this script fetched.
#
# Env:
#   ASAKI_MEMORY_BASE_URL   required (no default — never hardcode the endpoint)
#   ASAKI_MEMORY_API_KEY    required; falls back to the login fish env
#   ASAKI_MEMORY_USER_ID    default "asaki"
#   ASAKI_MEMORY_REPORT_DIR default "$HOME/.local/state/asaki-memory/weekly-reports"
#   ASAKI_MEMORY_REPORT_MODEL default "sonnet"
# The API key is never printed, never passed on a command line, and never written
# into the prompt or the report.
set -u
set -o pipefail

USER_ID="${ASAKI_MEMORY_USER_ID:-asaki}"
REPORT_DIR="${ASAKI_MEMORY_REPORT_DIR:-$HOME/.local/state/asaki-memory/weekly-reports}"
MODEL="${ASAKI_MEMORY_REPORT_MODEL:-sonnet}"
FISH_BIN="${ASAKI_MEMORY_FISH_BIN:-/opt/homebrew/bin/fish}"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "ERROR: $*"; exit 1; }

# --- credentials -------------------------------------------------------------
# A launchd job starts with an empty environment, so fall back to the captain's
# login shell, which sources ~/.config/fish/conf.d/api_keys.local.fish. The value
# is captured straight into a variable; it is never echoed to stdout/stderr.
if [ -z "${ASAKI_MEMORY_API_KEY:-}" ] && [ -x "$FISH_BIN" ]; then
  ASAKI_MEMORY_API_KEY="$("$FISH_BIN" -l -c 'if set -q ASAKI_MEMORY_API_KEY; echo -n $ASAKI_MEMORY_API_KEY; end' 2>/dev/null)"
fi
[ -n "${ASAKI_MEMORY_API_KEY:-}" ] || die "ASAKI_MEMORY_API_KEY is not set (env, nor login fish)"
[ -n "${ASAKI_MEMORY_BASE_URL:-}" ] || die "ASAKI_MEMORY_BASE_URL is not set"
export ASAKI_MEMORY_API_KEY
BASE_URL="${ASAKI_MEMORY_BASE_URL%/}"

command -v claude >/dev/null 2>&1 || die "claude CLI not found on PATH"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/asaki-weekly-report.XXXXXX")" || die "mktemp failed"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

# --- fetch (read-only) -------------------------------------------------------
# The key goes in via --config-header @file so it never appears in argv/ps.
HDR_FILE="$WORK_DIR/headers"
umask 077
{
  printf 'header = "Content-Type: application/json"\n'
  printf 'header = "Authorization: Bearer %s"\n' "$ASAKI_MEMORY_API_KEY"
} > "$HDR_FILE"

fetch() { # fetch <path> <json-body> <out-file>
  local path="$1" body="$2" out="$3" code
  code="$(curl -sS -o "$out" -w '%{http_code}' -X POST "$BASE_URL$path" \
    --config "$HDR_FILE" -d "$body")" || die "request to $path failed (network)"
  [ "$code" = "200" ] || die "request to $path returned HTTP $code"
  log "GET-ok $path -> HTTP $code ($(wc -c < "$out" | tr -d ' ') bytes)"
}

REVIEWS_JSON="$WORK_DIR/reviews.json"
MEMORIES_JSON="$WORK_DIR/memories.json"
fetch /v1/memories/reviews/list \
  "{\"user_id\":\"$USER_ID\",\"status\":\"pending\",\"limit\":100}" "$REVIEWS_JSON"
fetch /v1/memories/list \
  "{\"user_id\":\"$USER_ID\",\"scope\":\"global\",\"status\":\"active\",\"limit\":100}" "$MEMORIES_JSON"

# --- analyse (no tools, no credentials, no network for the model) ------------
PROMPT_FILE="$WORK_DIR/prompt.txt"
{
  cat <<'PROMPT'
You are producing the weekly Asaki Memory consolidation report. This is a
READ-ONLY, dry-run analysis: you have no tools and must not attempt any action —
just read the two JSON payloads below and write the report.

Global scope discipline (the recurring failure mode this exists to catch):
global memories get pulled into every project's context, so the bar is "genuinely
useful in ANY conversation regardless of project" — cross-project dev
preferences, communication/output style, secret-handling rules, this memory
system's own operating rules, and durable personal/identity facts. It is NOT a
dumping ground for system/tool troubleshooting (dotfiles, window manager
configs, app-specific bugs) that only happened to be captured while not inside a
recognizable git repo — that content belongs in scope=project with project_id set
to the relevant repo's basename, even if captured elsewhere. For every global
item ask "would this help in an unrelated project?" — if no, label it
UPDATE(rescope) rather than KEEP.

Analyse for: near-duplicate content, contradictory statements (two memories
asserting different values for the same fact/preference/decision), stale items
(old updated_at/last_accessed_at combined with low importance*confidence), wrong
kind/scope (see Global scope discipline above), low-value or noisy items, and any
pending reviews needing attention.

Produce a concise report: for each finding, state the memory id(s), a one-line
reason, and a suggested label (KEEP / UPDATE(rescope) / MERGE / DELETE — labels
only, they are NOT executed). If nothing stands out, say so plainly.

Start your reply with exactly this line:
Asaki Memory weekly consolidation report — dry-run, no changes applied.

=== PENDING REVIEWS (POST /v1/memories/reviews/list) ===
PROMPT
  cat "$REVIEWS_JSON"
  printf '\n\n=== ACTIVE GLOBAL MEMORIES (POST /v1/memories/list) ===\n'
  cat "$MEMORIES_JSON"
} > "$PROMPT_FILE"

mkdir -p "$REPORT_DIR" || die "cannot create $REPORT_DIR"
REPORT_FILE="$REPORT_DIR/$(date '+%Y-%m-%d').md"

log "running claude -p (model=$MODEL, no tools)"
if ! claude -p --safe-mode --model "$MODEL" \
      --disallowedTools Bash Read Write Edit WebFetch WebSearch Task \
      < "$PROMPT_FILE" > "$REPORT_FILE.tmp"; then
  rm -f "$REPORT_FILE.tmp"
  die "claude -p failed"
fi
[ -s "$REPORT_FILE.tmp" ] || { rm -f "$REPORT_FILE.tmp"; die "claude -p produced an empty report"; }
mv "$REPORT_FILE.tmp" "$REPORT_FILE"
log "report written: $REPORT_FILE ($(wc -l < "$REPORT_FILE" | tr -d ' ') lines)"

# Best-effort desktop notification — the local stand-in for the routine's push.
if [ "${ASAKI_MEMORY_REPORT_NOTIFY:-1}" = "1" ] && command -v osascript >/dev/null 2>&1; then
  osascript -e 'display notification "Weekly consolidation report ready" with title "Asaki Memory"' >/dev/null 2>&1 || true
fi

exit 0
