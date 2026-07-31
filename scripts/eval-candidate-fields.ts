// Offline unit coverage for the correction-classifier candidate fields: the enum coercion table,
// the evidence caps, the sensitive gate on all four evidence strings, and the two server-side
// derivations. Pure functions only — no Worker, no D1, no network.
import type { CandidateAntecedentSource, CandidateSignal, CandidateSignalSubtype, MemoryKind } from '../src/types.ts';
import { registerTsResolver } from './node-ts-resolver.mjs';

// validation.ts imports candidateDecision.ts extensionlessly (bundler resolution); register the
// resolver hook before the value imports so node can follow that edge.
registerTsResolver();

const { confidenceForAntecedent, importanceForSignal } = await import('../src/services/candidateDecision.ts');
const { validateCreateMemory, validateProcessCandidates } = await import('../src/utils/validation.ts');

let pass = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    pass += 1;
    return;
  }
  failures.push(`${name}: expected ${b}, got ${a}`);
}

function validated(overrides: Record<string, unknown>): Record<string, unknown> {
  const result = validateCreateMemory({ content: 'captain corrected the agent', user_id: 'eval-user', ...overrides });
  if (!result.ok) throw new Error(`unexpected validation failure: ${result.error}`);
  return result.data as unknown as Record<string, unknown>;
}

function rejected(overrides: Record<string, unknown>): string | null {
  const result = validateCreateMemory({ content: 'captain corrected the agent', user_id: 'eval-user', ...overrides });
  return result.ok ? null : result.error;
}

// --- importanceForSignal: the §6.1 table, exactly ---------------------------------------------
const importanceRows: Array<[CandidateSignal | undefined, CandidateSignalSubtype | '' | undefined, number | null]> = [
  ['correction', 'explicit_negation', 0.9],
  ['correction', 'override_of_action', 0.9],
  ['correction', 'repeat_complaint', 0.9],
  ['correction', 'terse_redirect', 0.8],
  ['correction', 'futility_verdict', 0.8],
  ['correction', 'approval_after_change', 0.7],
  ['correction', '', 0.8],
  ['correction', undefined, 0.8],
  ['preference', '', 0.4],
  ['preference', undefined, 0.4],
  ['outcome', undefined, 0.4],
  ['none', undefined, null],
  [undefined, undefined, null],
];
for (const [signal, subtype, expected] of importanceRows) {
  check(`importanceForSignal(${signal}, ${subtype})`, importanceForSignal(signal, subtype, 'rule' as MemoryKind), expected);
}

// --- confidenceForAntecedent: the §9.1 table --------------------------------------------------
const confidenceRows: Array<[CandidateAntecedentSource | undefined, number | null]> = [
  ['prose', 0.85],
  ['trace', 0.7],
  ['prior_tail', 0.65],
  ['candidate', 0.75],
  ['none', null],
  [undefined, null],
];
for (const [source, expected] of confidenceRows) {
  check(`confidenceForAntecedent(${source})`, confidenceForAntecedent(source), expected);
}

// --- coercion table: what gets stored, and whether derivation runs ----------------------------
check('signal correction stored', validated({ signal: 'correction', signal_subtype: 'override_of_action' }).signal, 'correction');
check('signal correction importance', validated({ signal: 'correction', signal_subtype: 'override_of_action' }).importance, 0.9);
check('signal preference demoted to 0.4', validated({ signal: 'preference' }).importance, 0.4);
check('signal outcome demoted to 0.4', validated({ signal: 'outcome' }).importance, 0.4);
check('signal none keeps default importance', validated({ signal: 'none' }).importance, 0.5);
check('signal none stored as none', validated({ signal: 'none' }).signal, 'none');
check('absent signal stays absent', 'signal' in validated({}), false);
check('absent signal keeps default importance', validated({}).importance, 0.5);
check('unknown signal coerced to none', validated({ signal: 'corection' }).signal, 'none');
check('unknown signal runs no derivation', validated({ signal: 'corection' }).importance, 0.5);
check('empty signal treated as absent', 'signal' in validated({ signal: '  ' }), false);
check('unknown subtype coerced to empty', validated({ signal: 'correction', signal_subtype: 'shouting' }).signal_subtype, '');
check('unknown subtype falls back to 0.8', validated({ signal: 'correction', signal_subtype: 'shouting' }).importance, 0.8);
check('unknown rule_form coerced to preference', validated({ rule_form: 'edict' }).rule_form, 'preference');
check('known rule_form preserved', validated({ rule_form: 'prohibition' }).rule_form, 'prohibition');
check('unknown antecedent_source coerced to none', validated({ antecedent_source: 'vibes' }).antecedent_source, 'none');
check('antecedent_source none keeps default confidence', validated({ antecedent_source: 'none' }).confidence, 1);
check('antecedent_source trace derives 0.7', validated({ antecedent_source: 'trace' }).confidence, 0.7);
check('absent antecedent_source keeps default confidence', validated({}).confidence, 1);

// --- supplied numbers always win over derivation ----------------------------------------------
check('supplied importance wins', validated({ signal: 'correction', signal_subtype: 'explicit_negation', importance: 0.2 }).importance, 0.2);
check('supplied confidence wins', validated({ antecedent_source: 'trace', confidence: 1 }).confidence, 1);
check('out-of-range importance still rejects', rejected({ importance: 2 }), 'importance must be between 0 and 1.');
check('out-of-range confidence still rejects', rejected({ confidence: -1 }), 'confidence must be between 0 and 1.');

// --- evidence strings: coerced and capped, never rejected for length --------------------------
const long = 'x'.repeat(400);
const cappedCorrection = validated({ correction: { agent_did: long, captain_verdict: long, redirect_target: long } }).correction as Record<string, string>;
check('agent_did capped at 300', cappedCorrection.agent_did.length, 300);
check('captain_verdict capped at 300', cappedCorrection.captain_verdict.length, 300);
check('redirect_target capped at 300', cappedCorrection.redirect_target.length, 300);
check('missing correction members coerced to empty strings', validated({ correction: { agent_did: '跑了 git commit' } }).correction, {
  agent_did: '跑了 git commit',
  captain_verdict: '',
  redirect_target: '',
});
check('non-object correction coerced, not rejected', validated({ correction: 'nope' }).correction, { agent_did: '', captain_verdict: '', redirect_target: '' });
check('supersedes_query capped at 300', (validated({ supersedes_query: long }).supersedes_query as string).length, 300);
check('empty supersedes_query becomes null', validated({ supersedes_query: '   ' }).supersedes_query, null);
check('supersedes_pending_review_id capped at 64', (validated({ supersedes_pending_review_id: long }).supersedes_pending_review_id as string).length, 64);
check('project_context capped at 128', (validated({ project_context: long }).project_context as string).length, 128);
check('non-string project_context becomes null', validated({ project_context: 42 }).project_context, null);
check('project_context does not touch project_id', validated({ project_context: 'asaki-memory-manager' }).project_id, null);

// --- the sensitive gate covers all four evidence strings, incl. supersedes_query ---------------
const secret = 'export DATABASE_PASSWORD=supersecret123';
const sensitiveError = 'content looks like it contains a secret or credential; refusing to store it.';
check('gate: agent_did', rejected({ correction: { agent_did: secret, captain_verdict: '', redirect_target: '' } }), sensitiveError);
check('gate: captain_verdict', rejected({ correction: { agent_did: '', captain_verdict: secret, redirect_target: '' } }), sensitiveError);
check('gate: redirect_target', rejected({ correction: { agent_did: '', captain_verdict: '', redirect_target: secret } }), sensitiveError);
check('gate: supersedes_query', rejected({ supersedes_query: secret }), sensitiveError);
// Gate runs on the original string, before truncation, so a cap cannot bisect a credential into a
// non-matching prefix.
check('gate: secret past the 300-char cap', rejected({ supersedes_query: `${'a '.repeat(200)}${secret}` }), sensitiveError);

// --- the batch endpoint threads the same fields -----------------------------------------------
const batch = validateProcessCandidates({
  user_id: 'eval-user',
  source: 'claude-code:stop-classifier',
  candidates: [
    {
      content: '不要在未获得确认前自动 commit 本仓库的改动',
      scope: 'project',
      project_id: 'asaki-memory-manager',
      kind: 'rule',
      signal: 'correction',
      signal_subtype: 'override_of_action',
      rule_form: 'prohibition',
      antecedent_source: 'trace',
      correction: { agent_did: '直接跑了 git commit -m "wip"', captain_verdict: '别再自动 commit 了', redirect_target: '' },
      supersedes_query: '每次编辑完成后自动 commit 并推送',
      project_context: 'asaki-memory-manager',
    },
  ],
});
if (!batch.ok) throw new Error(`unexpected batch validation failure: ${batch.error}`);
const item = batch.data[0] as unknown as Record<string, unknown>;
check('batch: signal threaded', item.signal, 'correction');
check('batch: rule_form threaded', item.rule_form, 'prohibition');
check('batch: supersedes_query threaded', item.supersedes_query, '每次编辑完成后自动 commit 并推送');
check('batch: project_context threaded', item.project_context, 'asaki-memory-manager');
check('batch: importance derived', item.importance, 0.9);
check('batch: confidence derived', item.confidence, 0.7);
check('batch: candidate_json round-trip keeps fields', JSON.parse(JSON.stringify(item)).correction, {
  agent_did: '直接跑了 git commit -m "wip"',
  captain_verdict: '别再自动 commit 了',
  redirect_target: '',
});

// --- legacy callers are untouched --------------------------------------------------------------
const legacy = validated({ kind: 'preference', source: 'pi' });
check('legacy candidate importance unchanged', legacy.importance, 0.5);
check('legacy candidate confidence unchanged', legacy.confidence, 1);
check('legacy candidate carries no evidence fields', Object.keys(legacy).sort(), ['confidence', 'content', 'importance', 'kind', 'project_id', 'scope', 'session_id', 'source', 'user_id']);

const total = pass + failures.length;
console.log(`candidate-fields eval: ${pass}/${total} passed`);
if (failures.length > 0) {
  console.log('fail:');
  for (const failure of failures) console.log(`- ${failure}`);
  process.exit(1);
}
