// Offline eval for the two delta builders (plan E6).
//
// A `Tool:` line inside a hand-written classifier fixture only proves the model can read that
// line. This eval checks the PRODUCER: a captured Claude Code transcript slice and a synthetic
// Pi AgentMessage[] go through the shipped builders and the emitted text is asserted verbatim —
// tool/arg selection per client, R1–R5 redaction, the gate-before-redact order, truncation,
// ordering, the prior/current delimiters, `toolResult` never being read, and the byte identity
// of the trace-off output.
//
// Claude Code's builder is imported directly; the Pi builder lives inside a single publishable
// file, so its `#region asaki-trace-builder` block is loaded via scripts/pi-trace-region.mjs.
// No network, no model, no Worker.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDelta, redactCommand, redactToken, traceLineForToolUse } from '../integrations/claude-code/build-delta.mjs';
import { loadPiTraceBuilder } from './pi-trace-region.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = '/repo';

const claudeTranscript = readFileSync(join(ROOT, 'test/fixtures/trace-builder-claude-transcript.jsonl'), 'utf8');
const piMessages = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/trace-builder-pi-messages.json'), 'utf8'));

const { module: pi, dispose } = await loadPiTraceBuilder();

let pass = 0;
const failures = [];

function check(name, actual, expected) {
  if (actual === expected) {
    pass += 1;
    return;
  }
  failures.push(`${name}:\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
}

// --- Claude Code: trace OFF is byte-identical to the pre-feature builder -----------------------
const claudeTraceOff = [
  'User: 改一下 src/index.ts 的排序',
  'Assistant: 好的，我先读一下文件。',
  'Assistant: 已提交改动。',
  'User: 别再自动 commit 了',
].join('\n\n');
check('claude-code / trace off is byte-identical to today', buildDelta(claudeTranscript, { repoRoot: REPO_ROOT, actionTrace: false }), claudeTraceOff);
check(
  'claude-code / trace off ignores the repo root entirely',
  buildDelta(claudeTranscript, { repoRoot: '', actionTrace: false }),
  claudeTraceOff,
);

// --- Claude Code: trace ON --------------------------------------------------------------------
const claudeTraceOn = [
  'User: 改一下 src/index.ts 的排序',
  'Assistant: 好的，我先读一下文件。',
  // R1, inside the repo → repo-relative.
  'Tool: read src/index.ts',
  // R1, outside the repo → the tool name alone, never the customer directory.
  'Tool: read',
  // Free text survives: this is exactly what §8.4 warns is NOT bounded.
  'Tool: bash git commit -m "wip"',
  // `ssh -i <keyfile>` is dropped by the per-line gate, which runs BEFORE redaction would have
  // rewritten the key path into `<path>` and hidden it.
  // R2: scheme only — the private bucket name does not leave.
  'Tool: bash aws s3 cp <uri:s3> .',
  // R3: user@host → <host>; the quoted remote command is R5 free text and survives.
  "Tool: bash ssh <host> 'systemctl restart api'",
  // Not in the whitelist → name only, no argument.
  'Tool: todowrite',
  'Tool: edit src/index.ts',
  'Tool: grep importanceForSignal',
  // Truncated to 120 chars, last, so truncation can never bisect a credential.
  'Tool: bash node scripts/eval-candidates.ts --report --verbose --seed 12345 --label aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'Assistant: 已提交改动。',
  'User: 别再自动 commit 了',
].join('\n\n');
check('claude-code / trace on emits the expected lines', buildDelta(claudeTranscript, { repoRoot: REPO_ROOT, actionTrace: true }), claudeTraceOn);

const traceOnText = buildDelta(claudeTranscript, { repoRoot: REPO_ROOT, actionTrace: true });
check('claude-code / tool results are never read', String(traceOnText.includes('DATABASE_PASSWORD')), 'false');
check('claude-code / thinking is never read', String(traceOnText.includes('internal reasoning')), 'false');
check('claude-code / the gated ssh key line is absent', String(traceOnText.includes('id_ed25519')), 'false');
check(
  'claude-code / no emitted trace arg exceeds 120 chars',
  String(
    traceOnText
      .split('\n')
      .filter((line) => line.startsWith('Tool: '))
      .every((line) => line.replace(/^Tool: [a-z]+ ?/, '').length <= 120),
  ),
  'true',
);

// --- Claude Code: R1–R5 worked examples from plan §3.1 ----------------------------------------
check('R1 outside repo', traceLineForToolUse('Bash', { command: 'cat /Users/alice/Clients/Acme/2026-layoffs-list.xlsx' }, REPO_ROOT), 'Tool: bash cat <path>');
check('R2 uri', traceLineForToolUse('Bash', { command: 'aws s3 cp s3://acme-private-legal/settlement.pdf .' }, REPO_ROOT), 'Tool: bash aws s3 cp <uri:s3> .');
check('R3 user@host', traceLineForToolUse('Bash', { command: "ssh deploy@acme-prod.internal 'systemctl restart api'" }, REPO_ROOT), "Tool: bash ssh <host> 'systemctl restart api'");
check('R5 verbatim', traceLineForToolUse('Bash', { command: 'git commit -m "wip"' }, REPO_ROOT), 'Tool: bash git commit -m "wip"');
check('R1 inside repo', traceLineForToolUse('Edit', { file_path: '/repo/src/index.ts' }, REPO_ROOT), 'Tool: edit src/index.ts');
check('R1 path arg outside repo', traceLineForToolUse('Read', { file_path: '/Users/alice/Clients/Acme/2026-layoffs-list.xlsx' }, REPO_ROOT), 'Tool: read');
check('R4 relative escape', redactToken('../../other-repo/secrets.ts', REPO_ROOT), '<path>');
check('R1 as the value half of k=v', redactCommand('rsync --exclude=/Users/alice/private ./out', REPO_ROOT), 'rsync --exclude=<path> ./out');
check('quoted absolute path still redacts', redactToken('"/Users/alice/private/file.txt"', REPO_ROOT), '"<path>"');
check('unknown tool emits the name alone', traceLineForToolUse('WebFetch', { url: 'https://internal.acme.test/x' }, REPO_ROOT), 'Tool: webfetch');
check('gated arg drops the whole line', traceLineForToolUse('Bash', { command: 'wrangler secret put ADMIN_API_KEY' }, REPO_ROOT), null);
check('missing repo root bounds every path', traceLineForToolUse('Read', { file_path: '/repo/src/index.ts' }, ''), 'Tool: read');

// --- Pi: same discipline, its own whitelist ---------------------------------------------------
const piTraceOff = [
  'User: 改一下 src/index.ts 的排序',
  'Assistant: 好的，我先读一下文件。',
  'Assistant: 已提交改动。',
  'User: 别再自动 commit 了',
].join('\n\n');
check('pi / trace off, correction off is byte-identical to today', pi.buildExtractionText(piMessages, {}), piTraceOff);

const piTraceOn = [
  'User: 改一下 src/index.ts 的排序',
  'Assistant: 好的，我先读一下文件。',
  'Tool: read src/index.ts',
  'Tool: read',
  'Tool: bash git commit -m "wip"',
  'Tool: bash aws s3 cp <uri:s3> .',
  "Tool: bash ssh <host> 'systemctl restart api'",
  'Tool: todowrite',
  'Tool: edit src/index.ts',
  // Pi has `find`, not `Glob`, and its whitelisted arg is `pattern`.
  'Tool: find src/**/*.ts',
  'Assistant: 已提交改动。',
  'User: 别再自动 commit 了',
].join('\n\n');
check('pi / trace on emits the expected lines', pi.buildExtractionText(piMessages, { actionTrace: true, repoRoot: REPO_ROOT }), piTraceOn);
check('pi / toolResult messages are never read', String(pi.buildExtractionText(piMessages, { actionTrace: true, repoRoot: REPO_ROOT }).includes('DATABASE_PASSWORD')), 'false');
check('pi / thinking is never read', String(pi.buildExtractionText(piMessages, { actionTrace: true, repoRoot: REPO_ROOT }).includes('internal reasoning')), 'false');
check('pi / path arg key is `path`, not `file_path`', pi.traceLineForToolCall({ type: 'toolCall', name: 'edit', arguments: { file_path: '/repo/src/index.ts' } }, REPO_ROOT), 'Tool: edit');
check('pi / ls is whitelisted', pi.traceLineForToolCall({ type: 'toolCall', name: 'ls', arguments: { path: '/repo/src' } }, REPO_ROOT), 'Tool: ls src');
check('pi / Claude-style tool names are not in Pi table', pi.traceLineForToolCall({ type: 'toolCall', name: 'Glob', arguments: { pattern: 'src/**' } }, REPO_ROOT), 'Tool: glob');

// --- Pi: the prior/current boundary the correction prompt depends on --------------------------
const piCorrection = pi.buildExtractionText(piMessages, { actionTrace: true, correctionMode: true, repoRoot: REPO_ROOT });
const priorLines = piTraceOn.split('\n\n').slice(0, -1);
const currentLines = piTraceOn.split('\n\n').slice(-1);
check(
  'pi / correction mode labels prior context and delimits the current turn',
  piCorrection,
  [pi.PRIOR_BLOCK_HEADER, ...priorLines, pi.CURRENT_DELTA_DELIMITER, ...currentLines].join('\n\n'),
);
check(
  'pi / the prior memory candidate line lands inside the prior block',
  pi
    .buildExtractionText(piMessages, { actionTrace: true, correctionMode: true, repoRoot: REPO_ROOT, priorCandidate: '每次编辑完成后自动 commit 并推送' })
    .split('\n\n')
    .at(-3),
  'Prior memory candidate: 每次编辑完成后自动 commit 并推送',
);
check(
  'pi / a single-turn delta has no prior block at all',
  pi.buildExtractionText([{ role: 'user', content: [{ type: 'text', text: '别再自动 commit 了' }] }], { correctionMode: true }),
  'User: 别再自动 commit 了',
);
check(
  'pi / transcript order is preserved, nothing is deduplicated',
  pi.buildExtractionText(
    [
      { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'edit', arguments: { path: '/repo/src/a.ts' } }] },
      { role: 'user', content: [{ type: 'text', text: '不对' }] },
      { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'edit', arguments: { path: '/repo/src/a.ts' } }] },
    ],
    { actionTrace: true, correctionMode: true, repoRoot: REPO_ROOT },
  ),
  [pi.PRIOR_BLOCK_HEADER, 'Tool: edit src/a.ts', pi.CURRENT_DELTA_DELIMITER, 'User: 不对', 'Tool: edit src/a.ts'].join('\n\n'),
);

// --- Cross-client agreement on the shared rules ------------------------------------------------
for (const command of [
  'cat /Users/alice/Clients/Acme/2026-layoffs-list.xlsx',
  'aws s3 cp s3://acme-private-legal/settlement.pdf .',
  "ssh deploy@acme-prod.internal 'systemctl restart api'",
  'git commit -m "wip"',
  'rsync --exclude=/Users/alice/private ./out',
]) {
  check(
    `both clients redact identically: ${command}`,
    pi.traceLineForToolCall({ type: 'toolCall', name: 'bash', arguments: { command } }, REPO_ROOT),
    traceLineForToolUse('Bash', { command }, REPO_ROOT),
  );
}

dispose();

const total = pass + failures.length;
console.log(`trace-builder eval: ${pass}/${total} passed`);
if (failures.length > 0) {
  console.log('fail:');
  for (const failure of failures) console.log(`- ${failure}`);
  process.exit(1);
}
