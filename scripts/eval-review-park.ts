// Offline unit coverage for capture-time near-duplicate parking in createMemoryReviews()
// (src/services/reviews.ts): a non-correction candidate scoring >= NEAR_DUPLICATE_PARK_THRESHOLD
// against an ACTIVE memory is written as an already-resolved `ignore` row instead of pending work,
// corrections are never parked by similarity, and nothing below the threshold changes behaviour.
// Uses a fake D1 that records every statement — no Worker, no real D1, no network, no model.
import { registerTsResolver } from './node-ts-resolver.mjs';

registerTsResolver();

const { createMemoryReviews } = await import('../src/services/reviews.ts');
const { NEAR_DUPLICATE_PARK_THRESHOLD, lexicalSimilarity } = await import('../src/services/candidateDecision.ts');

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

const ACTIVE_RULE = '不要在未获得确认前自动 commit 本仓库的改动';
// Same rule, reworded past every deterministic `ignore` rule (no equality, no substring, fewer than
// three ASCII tokens so tokenDecision() abstains) — exactly the class the 2026-08-05 audit ignored.
const NEAR_DUPLICATE = '未获得确认前不要自动 commit 本仓库改动';
const BELOW_THRESHOLD = '不要在未确认的情况下自动 commit 仓库改动';
const UNRELATED = '审计流程要求每 14 天检查一次待处理 review 队列';

function memoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mem-active',
    user_id: 'eval-user',
    scope: 'project',
    project_id: 'p1',
    session_id: null,
    kind: 'rule',
    content: ACTIVE_RULE,
    status: 'active',
    index_status: 'indexed',
    importance: 0.8,
    confidence: 0.9,
    source: 'claude-code:stop-classifier',
    metadata_json: null,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    last_accessed_at: null,
    ...overrides,
  } as any;
}

function candidate(content: string, overrides: Record<string, unknown> = {}) {
  return {
    content,
    user_id: 'eval-user',
    scope: 'project',
    project_id: 'p1',
    session_id: null,
    kind: 'rule',
    importance: 0.4,
    confidence: 1,
    source: 'claude-code:stop-classifier',
    ...overrides,
  } as any;
}

// A fake D1 that serves the active memory to every `FROM memories` scan (the vector path is absent,
// so searchMemories() falls back to the lexical scan) and an empty pending-review queue.
function fakeEnv(memories: unknown[]) {
  const recorded: Recorded[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const entry: Recorded = { sql, bindings: [] };
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
            return null;
          },
          async all() {
            recorded.push(entry);
            return { results: sql.includes('FROM memories') ? memories : [] };
          },
        };
        return stmt;
      },
    },
  } as any;
  return { env, recorded };
}

function reviewInserts(recorded: Recorded[]): Recorded[] {
  return recorded.filter((entry) => entry.sql.includes('INSERT INTO memory_reviews'));
}

function events(recorded: Recorded[]): string[] {
  return recorded.filter((entry) => entry.sql.includes('INSERT INTO memory_events')).map((entry) => String(entry.bindings[3]));
}

// --- 0. the fixtures really do sit in the bands the test claims -------------------------------
const nearScore = lexicalSimilarity(ACTIVE_RULE, NEAR_DUPLICATE);
check(
  'the near-duplicate fixture sits inside the park band',
  nearScore >= NEAR_DUPLICATE_PARK_THRESHOLD && nearScore < 0.95,
  `similarity=${nearScore.toFixed(3)} (band [${NEAR_DUPLICATE_PARK_THRESHOLD}, 0.95))`
);
check(
  'the control fixture sits below the park threshold but is still a usable match',
  lexicalSimilarity(ACTIVE_RULE, BELOW_THRESHOLD) >= 0.5 && lexicalSimilarity(ACTIVE_RULE, BELOW_THRESHOLD) < NEAR_DUPLICATE_PARK_THRESHOLD,
  `similarity=${lexicalSimilarity(ACTIVE_RULE, BELOW_THRESHOLD).toFixed(3)}`
);

// --- 1. the park path ---------------------------------------------------------------------------
{
  const { env, recorded } = fakeEnv([memoryRow()]);
  const result = await createMemoryReviews(env, [candidate(NEAR_DUPLICATE)]);
  check('a near-duplicate is not queued as pending work', result.reviews.length === 0, JSON.stringify(result.reviews));
  check('a near-duplicate is reported as parked', result.parked.length === 1, JSON.stringify(result.parked));

  const parked = result.parked[0];
  check('the parked row is already resolved as ignore', parked?.status === 'resolved' && parked?.resolved_action === 'ignore', JSON.stringify(parked));
  check('the parked row points at the active memory it duplicates', parked?.memory_id === 'mem-active', JSON.stringify(parked));
  check(
    'the parked row states the reason and the score',
    typeof parked?.reason === 'string' && parked.reason.includes('mem-active') && parked.reason.includes(nearScore.toFixed(3)),
    String(parked?.reason)
  );

  const inserts = reviewInserts(recorded);
  check('exactly one review row is written', inserts.length === 1, String(inserts.length));
  const insert = inserts[0];
  check(
    'the row is inserted resolved/ignore, not pending',
    insert?.sql.includes("'resolved'") === true && insert?.sql.includes("'ignore'") === true && !insert?.sql.includes("'pending'"),
    insert?.sql ?? '(missing)'
  );
  check(
    'the insert only touches columns that already exist (no migration)',
    insert !== undefined && !/ALTER TABLE|parked|park_/i.test(insert.sql),
    insert?.sql ?? '(missing)'
  );
  check(
    'the candidate is preserved verbatim so the row stays inspectable',
    typeof insert?.bindings[2] === 'string' && JSON.parse(insert.bindings[2] as string).content === NEAR_DUPLICATE,
    String(insert?.bindings[2])
  );
  check(
    'the row carries the matched memory id and the reason',
    insert?.bindings[3] === 'mem-active' && String(insert?.bindings[7]).includes('Auto-parked'),
    JSON.stringify(insert?.bindings)
  );
  check(
    'resolved_at is stamped so the row never reads as pending work',
    insert?.bindings[10] === insert?.bindings[8],
    JSON.stringify(insert?.bindings)
  );
  check('parking logs its own audit event', events(recorded).includes('review_park_duplicate'), JSON.stringify(events(recorded)));
  check('parking is not logged as a plain review_create', !events(recorded).includes('review_create'), JSON.stringify(events(recorded)));
  check(
    'nothing is deleted and no memory is mutated by parking',
    !recorded.some((entry) => /DELETE FROM|UPDATE memories SET (importance|content|status)/.test(entry.sql)),
    recorded.map((entry) => entry.sql).join(' | ')
  );
}

// --- 2. corrections are exempt from similarity parking -----------------------------------------
{
  const { env, recorded } = fakeEnv([memoryRow()]);
  const correction = candidate(NEAR_DUPLICATE, {
    signal: 'correction',
    signal_subtype: 'override_of_action',
    rule_form: 'prohibition',
    antecedent_source: 'trace',
    importance: 0.9,
    confidence: 0.7,
  });
  const result = await createMemoryReviews(env, [correction]);
  check('a correction is never parked by similarity', result.parked.length === 0, JSON.stringify(result.parked));
  check('a correction still reaches the human as pending work', result.reviews.length === 1 && result.reviews[0].status === 'pending', JSON.stringify(result.reviews));
  const insert = reviewInserts(recorded)[0];
  check('the correction row is inserted pending', insert?.sql.includes("'pending'") === true, insert?.sql ?? '(missing)');
  check('no park event is logged for a correction', !events(recorded).includes('review_park_duplicate'), JSON.stringify(events(recorded)));
}

// --- 3. below the threshold nothing changes ----------------------------------------------------
{
  const { env, recorded } = fakeEnv([memoryRow()]);
  const result = await createMemoryReviews(env, [candidate(BELOW_THRESHOLD)]);
  check('a partial match below the threshold stays pending', result.reviews.length === 1 && result.parked.length === 0, JSON.stringify(result));
  check('the pending insert is unchanged', reviewInserts(recorded)[0]?.sql.includes("'pending'") === true, reviewInserts(recorded)[0]?.sql ?? '(missing)');
}
{
  const { env } = fakeEnv([memoryRow()]);
  const result = await createMemoryReviews(env, [candidate(UNRELATED)]);
  check('an unrelated candidate is still queued', result.reviews.length === 1 && result.parked.length === 0, JSON.stringify(result));
}

// --- 4. the pre-existing exact-duplicate skip is untouched -------------------------------------
{
  const { env, recorded } = fakeEnv([memoryRow()]);
  const result = await createMemoryReviews(env, [candidate(ACTIVE_RULE)]);
  check('an exact duplicate is still skipped without writing a row', result.reviews.length === 0 && result.parked.length === 0, JSON.stringify(result));
  check('the exact duplicate still logs review_skip_duplicate', events(recorded).includes('review_skip_duplicate'), JSON.stringify(events(recorded)));
  check('the exact-duplicate path writes no review row', reviewInserts(recorded).length === 0, String(reviewInserts(recorded).length));
}

if (failures.length > 0) {
  console.error(`review-park eval FAILED (${pass} passed, ${failures.length} failed)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`review-park eval passed (${pass}/${pass})`);
