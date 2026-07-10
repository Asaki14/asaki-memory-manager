// Server-side secret gate: rejects content before it ever reaches Workers AI (embeddings,
// extraction) or gets persisted to D1/Vectorize/memory_events. This is the canonical, corrected
// pattern list — the client-side copies in integrations/pi/asaki-memory.ts,
// integrations/claude-code/stop-extract.sh, and scripts/shadow-run-extraction.ts are a separate,
// known-stale set (miss sk-/sk-proj-/sk-ant-/xoxb-/AIza) that predates this file and still needs
// its own fix; this list intentionally does not try to stay byte-for-byte identical to them.
const SENSITIVE_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i,
  // Covers sk-, sk-proj-, sk-ant-api03- (OpenAI/Anthropic) style keys — hyphenated, not
  // underscore-separated, unlike the stale client-side regexes.
  /\bsk-[A-Za-z0-9-]{10,}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  // scheme://user:password@host style credential URLs.
  /:\/\/[^/\s:]+:[^/\s@]{6,}@/,
  /\b(?:api[_-]?key|token|secret|password|passwd|authorization)\b\s*[:=]\s*["']?[^"'\s]{8,}/i,
  /set\s+-gx\s+\w*(?:KEY|TOKEN|SECRET|PASSWORD)\w*\s+[^$\s][^\s]{8,}/i,
];

export function containsSensitiveContent(text: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}
