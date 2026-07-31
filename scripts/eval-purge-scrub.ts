// Offline unit coverage for purgeMemory()'s destruction paths: the memories row blanking, the
// memory_events wipe, and the memory_reviews.candidate_json scrub. Uses a fake D1 that records
// every statement — no Worker, no real D1, no network.
import { registerTsResolver } from './node-ts-resolver.mjs';

registerTsResolver();

const { purgeMemory } = await import('../src/services/memories.ts');

interface Recorded {
  sql: string;
  bindings: unknown[];
}

const MEMORY_ROW = {
  id: 'mem-1',
  user_id: 'eval-user',
  scope: 'project',
  project_id: 'p1',
  session_id: null,
  kind: 'rule',
  content: 'a leaked credential',
  status: 'active',
  index_status: 'indexed',
  importance: 0.5,
  confidence: 0.5,
  source: 'claude-code:stop-classifier',
  metadata_json: null,
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
  last_accessed_at: null,
};

const recorded: Recorded[] = [];

function fakeEnv(): any {
  return {
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
            return sql.includes('FROM memories') ? MEMORY_ROW : null;
          },
          async all() {
            recorded.push(entry);
            return { results: [] };
          },
        };
        return stmt;
      },
    },
  };
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

const result = await purgeMemory(fakeEnv(), 'mem-1', 'eval-user', 'leaked credential');

check('returns purged row', result?.content === '[purged]' && result?.status === 'deleted', JSON.stringify(result));

const reviewScrub = recorded.find((entry) => entry.sql.includes('UPDATE memory_reviews'));
check('scrubs memory_reviews', reviewScrub !== undefined, 'no UPDATE memory_reviews statement issued');
check(
  'scrub writes the purged sentinel',
  reviewScrub?.sql.includes(`candidate_json = '{"purged":true}'`) === true,
  reviewScrub?.sql ?? '(missing)'
);
check(
  'scrub is scoped to this memory and user',
  reviewScrub?.sql.includes('WHERE memory_id = ?2 AND user_id = ?3') === true &&
    reviewScrub?.bindings[1] === 'mem-1' &&
    reviewScrub?.bindings[2] === 'eval-user',
  JSON.stringify(reviewScrub)
);
check(
  'scrub never deletes review rows',
  recorded.every((entry) => !/DELETE\s+FROM\s+memory_reviews/i.test(entry.sql)),
  'a DELETE FROM memory_reviews was issued — reviews are retained permanently'
);
check(
  'prior memory_events are still deleted',
  recorded.some((entry) => entry.sql.includes('DELETE FROM memory_events')),
  'no memory_events wipe'
);

const purgeEvent = recorded.find((entry) => entry.sql.includes('INSERT INTO memory_events'));
check(
  'purge event records the scrub count without content',
  typeof purgeEvent !== 'undefined' &&
    purgeEvent.bindings.some((b) => typeof b === 'string' && b.includes('scrubbed_reviews')) &&
    !purgeEvent.bindings.some((b) => typeof b === 'string' && b.includes('a leaked credential')),
  JSON.stringify(purgeEvent?.bindings)
);

if (failures.length > 0) {
  console.error(`purge-scrub eval FAILED (${pass} passed, ${failures.length} failed)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`purge-scrub eval passed (${pass}/${pass})`);
