// Offline coverage for the two review-line formatters (plan E9): src/mcp.ts's `formatReviewLine`
// and the copy in integrations/pi/asaki-memory.ts. Pure string assertions — no Worker, no D1, no
// network, no model.
//
// The Pi extension must stay a single file that imports Pi host modules this repo does not depend
// on, so its formatter is loaded out of the `// #region asaki-review-format` block by
// scripts/pi-trace-region.mjs — the eval executes the shipped source text, not a copy of it.
//
// What is pinned:
//   1. a correction row with supersedes_candidates + supersedes_pending_review_id renders the exact
//      block from plan §7.1 (rule line, correction moment with the antecedent source, supersession
//      suggestion with the target's current scope/kind/confidence, the contradicts line, meta);
//   2. a non-correction row is byte-identical to the pre-change output (golden strings below);
//   3. the deliberate asymmetry survives: only the Pi fallback line prints importance/confidence;
//   4. the correction block is character-identical between the two copies.
import { loadPiReviewFormatter } from './pi-trace-region.mjs';

// src/mcp.ts has type-only imports, so importing it strips to a side-effect-free module load; if
// that ever stops being true this import is where it surfaces.
const { formatReviewLine: mcpFormat } = await import('../src/mcp.ts');
const { module: pi, dispose } = await loadPiReviewFormatter();
const piFormat = pi.formatReviewLine as (item: unknown, index?: number) => string;

let pass = 0;
const failures: string[] = [];

function check(name: string, actual: string, expected: string): void {
  if (actual === expected) {
    pass += 1;
    return;
  }
  failures.push(`${name}:\n  expected:\n${expected.replace(/^/gm, '    | ')}\n  actual:\n${actual.replace(/^/gm, '    | ')}`);
}

// --- 1. the correction block, exactly as specified -------------------------------------------
const correctionRow = {
  id: 'rev_91c',
  source: 'claude-code:stop-classifier',
  created_at: '2026-07-31T02:11Z',
  candidate: {
    content: '不要在未获得确认前自动 commit 本仓库的改动',
    scope: 'project',
    kind: 'rule',
    importance: 0.9,
    confidence: 0.7,
    signal: 'correction',
    signal_subtype: 'override_of_action',
    rule_form: 'prohibition',
    antecedent_source: 'trace',
    correction: {
      agent_did: '直接跑了 git commit -m "wip"',
      captain_verdict: '「别再自动 commit 了」',
      redirect_target: '等确认后再 commit',
    },
    supersedes_query: '每次编辑完成后自动 commit 并推送',
    supersedes_pending_review_id: 'rev_44b',
  },
  supersedes_candidates: [
    {
      memory_id: 'mem_7f3a',
      content: '每次编辑完成后自动 commit 并推送',
      score: 0.62,
      target_scope: 'global',
      target_kind: 'fact',
      target_confidence: 0.95,
      suggested_action: 'update',
    },
  ],
};

const correctionBlock = [
  '1. [correction · override_of_action · prohibition] 不要在未获得确认前自动 commit 本仓库的改动',
  '   ⤷ agent: 直接跑了 git commit -m "wip"   →   captain: 「别再自动 commit 了」   (antecedent: trace)',
  '   ⤷ supersedes: mem_7f3a [scope=global kind=fact confidence=0.95] "每次编辑完成后自动 commit 并推送"  (score=0.62 suggest: update)',
  '   ⤷ contradicts pending review rev_44b',
  '   id=rev_91c scope=project kind=rule importance=0.90 confidence=0.70',
  '   source=claude-code:stop-classifier created_at=2026-07-31T02:11Z',
].join('\n');

check('mcp / correction block', mcpFormat(correctionRow, 0), correctionBlock);
check('pi / correction block', piFormat(correctionRow, 0), correctionBlock);
// 4. the two copies must not drift — same input, same characters.
check('correction block is identical across both copies', mcpFormat(correctionRow, 0), piFormat(correctionRow, 0));

// A real pending row also carries status; the queue's own fields stay on the meta line.
const pendingRow = { ...correctionRow, status: 'pending', supersedes_candidates: null };
const pendingBlock = [
  '1. [correction · override_of_action · prohibition] 不要在未获得确认前自动 commit 本仓库的改动',
  '   ⤷ agent: 直接跑了 git commit -m "wip"   →   captain: 「别再自动 commit 了」   (antecedent: trace)',
  '   ⤷ supersedes: not computed (suggestion cap reached on this page; re-list with a narrower filter)',
  '   ⤷ contradicts pending review rev_44b',
  '   id=rev_91c status=pending scope=project kind=rule importance=0.90 confidence=0.70',
  '   source=claude-code:stop-classifier created_at=2026-07-31T02:11Z',
].join('\n');
check('mcp / suggestion cap reached', mcpFormat(pendingRow, 0), pendingBlock);
check('pi / suggestion cap reached', piFormat(pendingRow, 0), pendingBlock);

// Evidence is optional at the row level (coercion is total server-side), so a correction with no
// recoverable antecedent must still render — visibly weak, not crashed or hidden.
const bareCorrection = {
  id: 'rev_bare',
  candidate: { content: '别再自动 commit', scope: 'global', kind: 'rule', importance: 0.8, confidence: 1, signal: 'correction' },
};
const bareBlock = [
  '[correction · unspecified · unspecified] 别再自动 commit',
  '   ⤷ agent: (unrecorded)   →   captain: (unrecorded)   (antecedent: none)',
  '   id=rev_bare scope=global kind=rule importance=0.80 confidence=1.00',
].join('\n');
check('mcp / correction without evidence', mcpFormat(bareCorrection), bareBlock);
check('pi / correction without evidence', piFormat(bareCorrection), bareBlock);

// --- 2 + 3. the non-correction fallback, byte-identical to the pre-change output --------------
const plainRow = {
  id: 'rev_02',
  status: 'pending',
  source: 'pi:agent-end-classifier',
  created_at: '2026-07-30T09:00Z',
  updated_at: '2026-07-30T09:05Z',
  candidate: { content: '偏好短句输出', scope: 'global', kind: 'preference', importance: 0.4, confidence: 1 },
  potential_duplicate: { memory_id: 'mem_11', content: '偏好短句输出', action: 'ignore', reason: 'near-duplicate' },
};

check(
  'mcp / non-correction line unchanged',
  mcpFormat(plainRow, 1),
  '2. 偏好短句输出 id=rev_02 status=pending scope=global kind=preference source=pi:agent-end-classifier created_at=2026-07-30T09:00Z updated_at=2026-07-30T09:05Z potential_duplicate=[memory_id=mem_11 suggested=ignore reason="near-duplicate"]',
);
check(
  'pi / non-correction line unchanged (keeps importance/confidence)',
  piFormat(plainRow, 1),
  '2. 偏好短句输出 id=rev_02 status=pending scope=global kind=preference importance=0.40 confidence=1.00 source=pi:agent-end-classifier created_at=2026-07-30T09:00Z updated_at=2026-07-30T09:05Z potential_duplicate=[memory_id=mem_11 suggested=ignore reason="near-duplicate"]',
);

// A resolved row and a row whose signal was coerced to 'none' both stay on the fallback line.
const resolvedRow = {
  id: 'rev_03',
  status: 'resolved',
  resolved_action: 'update',
  memory_id: 'mem_9',
  candidate: { content: '统一用 pnpm', scope: 'project', kind: 'decision', importance: 0.5, confidence: 1, signal: 'none' },
};
check('mcp / resolved non-correction row', mcpFormat(resolvedRow), '统一用 pnpm id=rev_03 status=resolved action=update memory_id=mem_9 scope=project kind=decision');
check(
  'pi / resolved non-correction row',
  piFormat(resolvedRow),
  '统一用 pnpm id=rev_03 status=resolved action=update memory_id=mem_9 scope=project kind=decision importance=0.50 confidence=1.00',
);

// A resolved CORRECTION keeps the block, so an audit of resolved rows still shows what was decided.
check(
  'mcp / resolved correction still renders the block',
  mcpFormat({ ...correctionRow, status: 'resolved', resolved_action: 'update', memory_id: 'mem_7f3a', supersedes_candidates: undefined }),
  [
    '[correction · override_of_action · prohibition] 不要在未获得确认前自动 commit 本仓库的改动',
    '   ⤷ agent: 直接跑了 git commit -m "wip"   →   captain: 「别再自动 commit 了」   (antecedent: trace)',
    '   ⤷ contradicts pending review rev_44b',
    '   id=rev_91c status=resolved action=update memory_id=mem_7f3a scope=project kind=rule importance=0.90 confidence=0.70',
    '   source=claude-code:stop-classifier created_at=2026-07-31T02:11Z',
  ].join('\n'),
);

// Long supersession targets are quoted, not dumped: 160 chars then an ellipsis.
const longTarget = 'x'.repeat(200);
const longRow = {
  id: 'rev_04',
  candidate: { content: '不要再用旧规则', scope: 'project', kind: 'rule', importance: 0.9, confidence: 0.85, signal: 'correction', signal_subtype: 'explicit_negation', rule_form: 'retract', antecedent_source: 'prose' },
  supersedes_candidates: [
    { memory_id: 'mem_long', content: longTarget, score: 0.5, target_scope: 'project', target_kind: 'rule', target_confidence: 0.6, suggested_action: 'delete' },
  ],
};
const longBlock = [
  '[correction · explicit_negation · retract] 不要再用旧规则',
  '   ⤷ agent: (unrecorded)   →   captain: (unrecorded)   (antecedent: prose)',
  `   ⤷ supersedes: mem_long [scope=project kind=rule confidence=0.60] "${'x'.repeat(160)}…"  (score=0.50 suggest: delete)`,
  '   id=rev_04 scope=project kind=rule importance=0.90 confidence=0.85',
].join('\n');
check('mcp / long supersession target is truncated', mcpFormat(longRow), longBlock);
check('pi / long supersession target is truncated', piFormat(longRow), longBlock);

dispose();

if (failures.length > 0) {
  console.error(`review-format eval FAILED (${pass} passed, ${failures.length} failed)`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`review-format eval: PASS (${pass} assertions)`);
