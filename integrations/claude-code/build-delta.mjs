// Claude Code transcript → classifier delta builder.
//
// Extracted from the inline `node -e` heredoc that used to live in stop-extract.sh so the
// producer itself is testable offline (scripts/eval-trace-builder.mjs, plan E6) — a `Tool:`
// string in a hand-written classifier fixture only proves the model can read that string, not
// that this builder ever emits it.
//
// Two output modes:
//   - action trace OFF (default): byte-for-byte the same text the previous inline builder
//     produced — plain `User: ` / `Assistant: ` lines, joined by a blank line.
//   - action trace ON (ASAKI_MEMORY_ACTION_TRACE=1): each assistant tool call also emits one
//     `Tool: <name> <one whitelisted arg>` line. Tool RESULTS are never read; thinking blocks
//     are never read.
//
// Per-line pipeline order is load-bearing (plan §3.1):
//   1. gate the ORIGINAL arg (trace-specific patterns + the canonical secret list) — on a hit
//      drop that line, not the delta;
//   2. redact path/URI/host tokens (R1–R5), including inside a `Bash` command;
//   3. truncate to 120 chars last, so truncation can neither bisect a credential into a
//      non-matching prefix nor cut away a token the gate was about to catch.
//
// KEEP IN SYNC with the Pi copies in integrations/pi/asaki-memory.ts (marked
// `#region asaki-trace-builder`): PI_TRACE_TOOLS, TRACE_SENSITIVE_RE_LIST and the R1–R5
// redaction rules must stay behaviourally identical across both clients.
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const TRACE_ARG_MAX_CHARS = 120;

// Mirrors the canonical server gate, src/utils/sensitiveContent.ts. Both holes that file fixed
// are carried here: the keyword may carry an identifier prefix/suffix (so DATABASE_PASSWORD=…
// is caught) and any fish `set -x`/`-gx`/`-Ux` flag spelling matches, not just `-gx`.
export const SENSITIVE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i,
  /\bsk-[A-Za-z0-9-]{10,}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /:\/\/[^/\s:]+:[^/\s@]{6,}@/,
  /(?:^|[^A-Za-z0-9])[A-Za-z0-9_-]{0,64}(?:api[_-]?key|token|secret|password|passwd|authorization)(?:[_-][A-Za-z0-9_-]{0,64})?\s*[:=]\s*["']?[^"'\s]{8,}/i,
  /set(?:\s+--?[A-Za-z][A-Za-z0-9-]*)+\s+\w*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\w*\s+[^$\s][^\s]{8,}/i,
];

// Trace-specific list (plan §8.2b): applied per trace line, on the ORIGINAL arg, in addition to
// the canonical list above. These shapes carry a credential in a position the canonical list
// does not look at (a flag value, a bare identifier assignment, a key-file path).
export const TRACE_SENSITIVE_PATTERNS = [
  // curl -u user:pass / --user, and -H/--header carrying an auth-ish word.
  /\bcurl\b[^\n]*\s(?:-u|--user)\s/i,
  /\bcurl\b[^\n]*\s(?:-H|--header)\s*["']?[^"'\n]*(?:key|token|secret|auth|credential)/i,
  // Password-bearing client invocations.
  /\bsshpass\b/i,
  /\bssh\b[^\n]*\s-i\s/i,
  /\bscp\b[^\n]*\s-i\s/i,
  /\bmysql\b[^\n]*\s-p\S/i,
  /\b(?:psql|mongo|mongosh)\b[^\n]*\bpassword\s*=/i,
  // Assignment/export of any identifier CONTAINING a credential word (not word-bounded), in
  // export / set -x / set -gx / env / bare FOO=bar form. Deliberately looser than the canonical
  // list: a trace line is one command, so a false drop costs one line, not a delta.
  /\b(?:export|env|setenv)\s+[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API)[A-Za-z0-9_]*\s*[=\s]\s*\S/i,
  /\bset(?:\s+--?[A-Za-z][A-Za-z0-9-]*)+\s+[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API)[A-Za-z0-9_]*\s+\S/i,
  /(?:^|[\s;&|(])[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*=\S/,
  // Secret-management commands: the command itself names the secret store.
  /\bwrangler\s+secret\b/i,
  /\bgh\s+auth\b/i,
  /\baws\s+configure\b/i,
  /\bop\s+read\b/i,
  /\bsecurity\s+find-(?:generic|internet)-password\b/i,
  // Any path/filename naming a credential store.
  /(?:^|[\s"'=:])[^\s"']*(?:\.env(?:\.[A-Za-z0-9_-]+)?|\.pem|\.p12|\.netrc|id_rsa|id_ed25519|id_ecdsa)\b/,
  /(?:^|[\s"'=:])[^\s"']*(?:\.aws\/|\.ssh\/|\.gnupg\/|credentials\b)/,
  /(?:^|[\s"'=:])[^\s"']*(?:token|secret)[^\s"']*\.(?:json|txt|yaml|yml|conf)\b/i,
];

// Per-client whitelist (plan §3.1/§3.3): tool name → the ONE argument that may be emitted.
// Claude Code spelling; Pi's table is lowercase, uses `path`, and has `find` where Claude has
// `Glob`. Anything not listed emits the tool name alone.
export const CLAUDE_TRACE_TOOLS = {
  Bash: { arg: 'command', shape: 'command' },
  Edit: { arg: 'file_path', shape: 'path' },
  Write: { arg: 'file_path', shape: 'path' },
  Read: { arg: 'file_path', shape: 'path' },
  Glob: { arg: 'pattern', shape: 'text' },
  Grep: { arg: 'pattern', shape: 'text' },
};

export function containsSensitive(text) {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

export function containsTraceSensitive(text) {
  return TRACE_SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  return value;
}

// R1's "inside the repo" half: a repo-relative path is emitted as-is, anything outside the repo
// root (or any path at all when the repo root is unknown) collapses to a placeholder.
function repoRelativeOrNull(value, repoRoot) {
  if (!repoRoot) return null;
  const absolute = resolve(repoRoot, expandHome(value));
  const rel = relative(repoRoot, absolute);
  if (rel === '') return '.';
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

function isAbsolutePathToken(token) {
  return token.startsWith('/') || token.startsWith('~/') || token === '~' || /^[A-Za-z]:[\\/]/.test(token);
}

// R1–R5 for a single whitespace-delimited command token. Surrounding quotes are stripped for
// classification and restored afterwards, so `'/Users/a/x'` still redacts.
export function redactToken(token, repoRoot) {
  if (!token) return token;

  const quoted = token.match(/^(["'])([\s\S]*)\1$/);
  if (quoted) return `${quoted[1]}${redactToken(quoted[2], repoRoot)}${quoted[1]}`;

  // `k=/abs/path` — redact the value half only, so the flag/env name survives.
  const assignment = token.match(/^([A-Za-z0-9_.-]+=)([\s\S]+)$/);
  if (assignment) return `${assignment[1]}${redactToken(assignment[2], repoRoot)}`;

  // R1: absolute path → repo-relative inside the repo, else `<path>`.
  if (isAbsolutePathToken(token)) return repoRelativeOrNull(token, repoRoot) ?? '<path>';

  // R2: URI → scheme only; host and object path are both dropped.
  const uri = token.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (uri) return `<uri:${uri[1].toLowerCase()}>`;

  // R3: user@host → `<host>`.
  if (/^[^@\s]+@[^@\s]+$/.test(token)) return '<host>';

  // R4: relative path escaping the repo.
  if (token.startsWith('../') && token.includes('/')) return '<path>';

  // R5: binary names, flags, numbers, quoted free text — verbatim.
  return token;
}

export function redactCommand(command, repoRoot) {
  return command
    .trim()
    .split(/\s+/)
    .map((token) => redactToken(token, repoRoot))
    .join(' ');
}

function truncate(value, max) {
  return value.length > max ? value.slice(0, max) : value;
}

// One transcript tool call → one trace line, or null when the line must be dropped entirely.
export function traceLineForToolUse(name, input, repoRoot) {
  const toolName = typeof name === 'string' && name.trim() ? name.trim() : '';
  if (!toolName) return null;
  const label = `Tool: ${toolName.toLowerCase()}`;

  const entry = CLAUDE_TRACE_TOOLS[toolName];
  if (!entry) return label;

  const raw = input && typeof input === 'object' ? input[entry.arg] : undefined;
  if (typeof raw !== 'string' || !raw.trim()) return label;

  // Step 1 — gate the ORIGINAL arg. Redaction rewrites `ssh -i /Users/a/.ssh/id_ed25519` into
  // `ssh -i <path>`, which no longer matches the `.ssh/` rule, so gating must come first.
  if (containsTraceSensitive(raw) || containsSensitive(raw)) return null;

  // Step 2 — redact.
  let arg;
  if (entry.shape === 'command') arg = redactCommand(raw, repoRoot);
  else if (entry.shape === 'path') arg = repoRelativeOrNull(raw.trim(), repoRoot) ?? '';
  else arg = raw.trim().replace(/\s+/g, ' ');

  // Step 3 — truncate.
  arg = truncate(arg, TRACE_ARG_MAX_CHARS);
  return arg ? `${label} ${arg}` : label;
}

// Transcript JSONL slice → the classifier delta. `lines` is the raw slice; order is preserved
// exactly, since the trace line format carries no timestamp and order is the only temporal
// signal the model gets.
export function buildDelta(lines, options = {}) {
  const { repoRoot = '', actionTrace = false } = options;
  const out = [];
  for (const line of String(lines).split('\n')) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type === 'user' && j.message && typeof j.message.content === 'string') {
      out.push('User: ' + j.message.content.trim());
    } else if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
      const text = j.message.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join(' ')
        .trim();
      if (text) out.push('Assistant: ' + text);
      if (actionTrace) {
        for (const part of j.message.content) {
          if (!part || part.type !== 'tool_use') continue;
          const traceLine = traceLineForToolUse(part.name, part.input, repoRoot);
          if (traceLine) out.push(traceLine);
        }
      }
    }
  }
  return out.join('\n\n');
}

function isMain() {
  const entry = process.argv[1] ? resolve(process.argv[1]) : '';
  return entry === resolve(new URL(import.meta.url).pathname);
}

if (isMain()) {
  let stdin = '';
  process.stdin.on('data', (chunk) => (stdin += chunk));
  process.stdin.on('end', () => {
    const actionTrace = !['', '0', 'false', 'off', 'no'].includes((process.env.ASAKI_MEMORY_ACTION_TRACE ?? '').toLowerCase());
    process.stdout.write(buildDelta(stdin, { repoRoot: process.env.ASAKI_TRACE_REPO_ROOT ?? '', actionTrace }));
  });
}
