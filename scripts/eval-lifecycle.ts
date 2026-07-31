// Offline unit coverage for the memory-lifecycle logic (captain decisions 4 + 8 + 9, 2026-07-31):
// reinforcement/recurrence bookkeeping, the correction-provenance stamp, the cross-project promotion
// lookup, the lifecycle report's arithmetic, and the invariant that standing rules are never on an
// automatic delete path. Uses a fake D1 that records every statement — no Worker, no real D1, no
// network, no model.
import { registerTsResolver } from './node-ts-resolver.mjs';

registerTsResolver();

const {
  DEFAULT_IDLE_RULE_DAYS,
  REINFORCEMENT_IMPORTANCE_CAP,
  bumpImportance,
  correctionOriginPatch,
  lifecycleReport,
  parseMemoryMetadata,
  recordCorrectionOrigin,
  reinforceMemory,
  reinforcementPatch,
} = await import('../src/services/memoryLifecycle.ts');
const { findPromotionCandidates } = await import('../src/services/reviews.ts');
const { pruneStaleMemories } = await import('../src/services/memories.ts');

interface Recorded {
  sql: string;
  bindings: unknown[];
}

const failures: string[] = [];
let pass = 0;

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    pass += 1;
    return;
  }
  failures.push(`${name}: ${detail}`);
}

// A fake D1 whose responses are chosen by matching the SQL text. `rows` maps a substring of the
// statement to the rows it should return; anything unmatched returns empty.
function fakeEnv(handlers: Array<{ match: string; first?: unknown; all?: unknown[] }> = []) {
  const recorded: Recorded[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const entry: Recorded = { sql, bindings: [] };
        const handler = handlers.find((item) => sql.includes(item.match));
        const stmt = {
          bind(...bindings: unknown[]) {
            entry.bindings = bindings;
            return stmt;
          },
          async run() {
            recorded.push(entry);
            return { meta: { changes: 1 } };
          },
          async first() {
            recorded.push(entry);
            return handler?.first ?? null;
          },
          async all() {
            recorded.push(entry);
            return { results: handler?.all ?? [] };
          },
        };
        return stmt;
      },
    },
  } as any;
  return { env, recorded };
}

function memoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mem-rule',
    user_id: 'eval-user',
    scope: 'project',
    project_id: 'p1',
    session_id: null,
    content: '不要在未获得确认前自动 commit',
    kind: 'rule',
    importance: 0.8,
    confidence: 0.9,
    status: 'active',
    source: 'claude-code:stop-classifier',
    index_status: 'indexed',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    last_accessed_at: null,
    metadata_json: null,
    ...overrides,
  } as any;
}

function correctionCandidate(overrides: Record<string, unknown> = {}) {
  return {
    content: '不要在未获得确认前自动 commit',
    user_id: 'eval-user',
    scope: 'project',
    project_id: 'p1',
    session_id: null,
    kind: 'rule',
    importance: 0.9,
    confidence: 0.7,
    source: 'claude-code:stop-classifier',
    signal: 'correction',
    signal_subtype: 'override_of_action',
    rule_form: 'prohibition',
    antecedent_source: 'trace',
    correction: { agent_did: '直接跑了 git commit', captain_verdict: '别再自动 commit 了', redirect_target: '等确认后再 commit' },
    ...overrides,
  } as any;
}

// --- 1. bounded importance bump ---------------------------------------------------------------
check('bump steps by 0.05 on the 2-decimal grid', bumpImportance(0.8) === 0.85, String(bumpImportance(0.8)));
check('bump avoids float dust', bumpImportance(0.7) === 0.75, String(bumpImportance(0.7)));
check('bump is capped', bumpImportance(0.93) === REINFORCEMENT_IMPORTANCE_CAP, String(bumpImportance(0.93)));
check('bump never lowers an above-cap importance', bumpImportance(1) === 1, String(bumpImportance(1)));

// --- 2. recurrence counter --------------------------------------------------------------------
const firstPatch = reinforcementPatch({}, correctionCandidate(), '2026-07-31T00:00:00.000Z');
check('first reinforcement counts 1', firstPatch.count === 1, JSON.stringify(firstPatch));
check('reinforcement records the subtype and source', firstPatch.last_signal_subtype === 'override_of_action' && firstPatch.last_source === 'claude-code:stop-classifier', JSON.stringify(firstPatch));
const secondPatch = reinforcementPatch({ reinforcement: firstPatch }, correctionCandidate(), '2026-08-01T00:00:00.000Z');
check('repeat reinforcement increments', secondPatch.count === 2 && secondPatch.last_reinforced_at === '2026-08-01T00:00:00.000Z', JSON.stringify(secondPatch));
check('malformed metadata parses as empty', Object.keys(parseMemoryMetadata('{not json')).length === 0, JSON.stringify(parseMemoryMetadata('{not json')));

// --- 3. reinforceMemory writes importance + metadata, and skips what it must -------------------
{
  const { env, recorded } = fakeEnv();
  const result = await reinforceMemory(env, memoryRow({ metadata_json: JSON.stringify({ reinforcement: { count: 1, last_reinforced_at: '2026-07-01T00:00:00.000Z' } }) }), correctionCandidate());
  check('reinforcement returns the new count', result?.count === 2, JSON.stringify(result));
  check('reinforcement bumps importance 0.80 -> 0.85', result?.importance_after === 0.85 && result?.importance_before === 0.8, JSON.stringify(result));

  const update = recorded.find((entry) => entry.sql.includes('UPDATE memories SET importance'));
  check('reinforcement writes importance and metadata_json in one statement', update?.sql.includes('metadata_json = ?2') === true, update?.sql ?? '(missing)');
  check('reinforcement is scoped to the memory and user', update?.sql.includes('WHERE id = ?4 AND user_id = ?5') === true, update?.sql ?? '(missing)');
  check(
    'reinforcement never rewrites content, scope, kind, or confidence',
    update !== undefined && !/content\s*=|scope\s*=|kind\s*=|confidence\s*=/.test(update.sql),
    update?.sql ?? '(missing)'
  );
  const event = recorded.find((entry) => entry.sql.includes('INSERT INTO memory_events'));
  check('reinforcement logs a reinforce event', event?.bindings[3] === 'reinforce', JSON.stringify(event?.bindings));
  check(
    'reinforce event payload carries the count and both importances, not the content',
    typeof event?.bindings[4] === 'string' && event.bindings[4].includes('"count":2') && event.bindings[4].includes('importance_after') && !event.bindings[4].includes('自动 commit'),
    String(event?.bindings[4])
  );
}
{
  const { env, recorded } = fakeEnv();
  const result = await reinforceMemory(env, memoryRow({ kind: 'decision' }), correctionCandidate());
  check('non-standing-rule kinds are not reinforced', result === null && recorded.length === 0, JSON.stringify({ result, recorded }));
}
{
  const { env, recorded } = fakeEnv();
  const result = await reinforceMemory(env, memoryRow({ status: 'deleted' }), correctionCandidate());
  check('deleted memories are not reinforced', result === null && recorded.length === 0, JSON.stringify({ result, recorded }));
}

// --- 4. provenance on activation --------------------------------------------------------------
{
  const long = 'x'.repeat(300);
  const origin = correctionOriginPatch(correctionCandidate({ correction: { agent_did: long, captain_verdict: long, redirect_target: long } }), 'rev-1', '2026-07-31T00:00:00.000Z');
  check('agent_did is capped at 120 chars', origin.agent_did.length === 120, String(origin.agent_did.length));
  check('captain_verdict is capped at 120 chars', origin.captain_verdict.length === 120, String(origin.captain_verdict.length));
  check('origin keeps the review id and evidence provenance', origin.review_id === 'rev-1' && origin.antecedent_source === 'trace' && origin.signal_subtype === 'override_of_action', JSON.stringify(origin));
  check('redirect_target is not stored on the memory', !('redirect_target' in origin), JSON.stringify(origin));
}
{
  const { env, recorded } = fakeEnv();
  const origin = await recordCorrectionOrigin(env, memoryRow(), correctionCandidate(), 'rev-2');
  const update = recorded.find((entry) => entry.sql.includes('UPDATE memories SET metadata_json'));
  check('provenance is written to metadata_json', origin !== null && update !== undefined, JSON.stringify({ origin, recorded }));
  check(
    'provenance merges rather than replaces existing metadata keys',
    typeof update?.bindings[0] === 'string' && JSON.parse(update.bindings[0] as string).correction_origin.captain_verdict === '别再自动 commit 了',
    String(update?.bindings[0])
  );
}
{
  const { env, recorded } = fakeEnv();
  const origin = await recordCorrectionOrigin(env, memoryRow(), correctionCandidate({ signal: 'preference' }), 'rev-3');
  check('non-correction candidates leave no provenance', origin === null && recorded.length === 0, JSON.stringify({ origin, recorded }));
}

// --- 5. cross-project promotion lookup --------------------------------------------------------
{
  const crossProjectRow = memoryRow({ id: 'mem-other', project_id: 'p2', content: '不要在未获得确认前自动 commit 任何仓库' });
  const { env, recorded } = fakeEnv([{ match: "scope = 'project'", all: [crossProjectRow] }]);
  const promotions = await findPromotionCandidates(env, correctionCandidate(), 'p1');
  check('a near-match rule in another project is suggested for promotion', promotions.length === 1 && promotions[0].memory_id === 'mem-other', JSON.stringify(promotions));
  check('the suggestion names the other project and the action', promotions[0]?.target_project_id === 'p2' && promotions[0]?.suggested_action === 'promote_to_global', JSON.stringify(promotions));
  const scan = recorded.find((entry) => entry.sql.includes('FROM memories'));
  check('the scan excludes the candidate\'s own project', scan?.sql.includes('project_id <> ?2') === true && scan?.bindings[1] === 'p1', JSON.stringify(scan));
  check('the scan only considers standing-rule kinds', scan?.sql.includes("kind IN ('rule', 'preference')") === true, scan?.sql ?? '(missing)');
  check('the scan only considers active memories', scan?.sql.includes("status = 'active'") === true, scan?.sql ?? '(missing)');
}
{
  const unrelated = memoryRow({ id: 'mem-unrelated', project_id: 'p2', content: '每天生成一份跨项目聚合日报' });
  const { env } = fakeEnv([{ match: "scope = 'project'", all: [unrelated] }]);
  const promotions = await findPromotionCandidates(env, correctionCandidate(), 'p1');
  check('an unrelated cross-project rule is not suggested', promotions.length === 0, JSON.stringify(promotions));
}
{
  const { env, recorded } = fakeEnv();
  const globalCandidate = await findPromotionCandidates(env, correctionCandidate({ scope: 'global', project_id: null }), null);
  const nonCorrection = await findPromotionCandidates(env, correctionCandidate({ signal: 'preference' }), 'p1');
  const noProject = await findPromotionCandidates(env, correctionCandidate({ project_id: null }), null);
  check(
    'promotion is only looked up for project-scoped corrections that know their project',
    globalCandidate.length === 0 && nonCorrection.length === 0 && noProject.length === 0 && recorded.length === 0,
    JSON.stringify({ globalCandidate, nonCorrection, noProject, queries: recorded.length })
  );
}

// --- 6. the lifecycle report ------------------------------------------------------------------
{
  const idleSince = new Date(Date.now() - 64 * 86_400_000).toISOString();
  const { env, recorded } = fakeEnv([
    { match: 'SUM(CASE WHEN', first: { active: 17, reinforced: 3, total_reinforcements: 5 } },
    {
      match: 'AS reinforce_count,\n            (CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json',
      all: [{ ...memoryRow(), reinforce_count: 3, last_reinforced_at: '2026-07-30T00:00:00.000Z', last_signal_subtype: 'explicit_negation' }],
    },
    { match: 'AS last_signal_at', all: [{ ...memoryRow({ id: 'mem-idle' }), reinforce_count: 0, last_signal_at: idleSince }] },
  ]);
  const report = await lifecycleReport(env, { user_id: 'eval-user', project_id: 'p1', idle_days: DEFAULT_IDLE_RULE_DAYS, limit: 20 });

  check('repeat rate is reinforced/active, 3 decimals', report.standing_rules.repeat_rate === 0.176, JSON.stringify(report.standing_rules));
  check('totals are reported verbatim', report.standing_rules.active === 17 && report.standing_rules.total_reinforcements === 5, JSON.stringify(report.standing_rules));
  check('recurrence rows carry the count and subtype', report.recurrence[0]?.count === 3 && report.recurrence[0]?.last_signal_subtype === 'explicit_negation', JSON.stringify(report.recurrence));
  check('idle rows report whole idle days', report.idle_rules[0]?.idle_days === 64 && report.idle_rules[0]?.id === 'mem-idle', JSON.stringify(report.idle_rules));
  check('the default idle window is 30 days', DEFAULT_IDLE_RULE_DAYS === 30 && report.idle_days_threshold === 30, String(DEFAULT_IDLE_RULE_DAYS));
  check(
    'the report only ever reads — no UPDATE/DELETE is issued',
    recorded.every((entry) => /^\s*SELECT/i.test(entry.sql)),
    recorded.map((entry) => entry.sql.slice(0, 40)).join(' | ')
  );
  check(
    'both sections are restricted to active standing rules',
    recorded.filter((entry) => /FROM memories/.test(entry.sql)).every((entry) => entry.sql.includes("status = 'active' AND kind IN ('rule', 'preference')")),
    'a lifecycle query was not restricted to active rule/preference rows'
  );
  check(
    'a project report still counts global rules',
    recorded.some((entry) => entry.sql.includes("(scope = 'global' OR (scope = 'project' AND project_id = ?))")),
    'project scoping dropped global rules'
  );
}
{
  const { env } = fakeEnv([{ match: 'SUM(CASE WHEN', first: { active: 0, reinforced: 0, total_reinforcements: 0 } }]);
  const report = await lifecycleReport(env, { user_id: 'eval-user', project_id: null, idle_days: 30, limit: 20 });
  check('an empty rule set reports repeat_rate 0, not NaN', report.standing_rules.repeat_rate === 0, JSON.stringify(report.standing_rules));
}

// --- 7. standing rules stay off the automatic delete path -------------------------------------
{
  const { env, recorded } = fakeEnv();
  await pruneStaleMemories(env, { days: 90, limit: 10, apply: true });
  const scan = recorded.find((entry) => entry.sql.includes('FROM memories'));
  check(
    'prune-stale never selects standing rules (decision 4: judged by a human, never auto-deleted)',
    scan?.sql.includes("kind NOT IN ('rule', 'preference')") === true,
    scan?.sql ?? '(missing)'
  );
}

if (failures.length > 0) {
  console.error(`lifecycle eval FAILED (${pass} passed, ${failures.length} failed)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`lifecycle eval passed (${pass}/${pass})`);
