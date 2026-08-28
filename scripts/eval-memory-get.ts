// Offline unit coverage for the batch read-by-id path: validateGetMemories()'s bounds and
// getMemoriesByIds()'s user scoping, request-order preservation, `missing` reporting, the
// last_accessed_at write (captain decision a, 2026-08-28) and the audit event. Uses a fake D1 —
// no Worker, no real D1, no network.
import { registerTsResolver } from './node-ts-resolver.mjs';

registerTsResolver();

const { getMemoriesByIds } = await import('../src/services/memories.ts');
const { validateGetMemories } = await import('../src/utils/validation.ts');

interface Recorded {
  sql: string;
  bindings: unknown[];
}

function row(id: string, userId = 'eval-user'): Record<string, unknown> {
  return {
    id,
    user_id: userId,
    scope: 'global',
    project_id: null,
    session_id: null,
    kind: 'decision',
    content: `content of ${id}`,
    status: 'active',
    index_status: 'indexed',
    importance: 0.6,
    confidence: 0.9,
    source: 'mcp',
    metadata_json: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    last_accessed_at: null,
  };
}

// m1/m2 belong to the caller; m3 belongs to somebody else and must read as missing, never leak.
const STORE = [row('m1'), row('m2'), row('m3', 'other-user')];

function fakeEnv(recorded: Recorded[]): any {
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
            return null;
          },
          async all() {
            recorded.push(entry);
            const ids = new Set(entry.bindings.map(String));
            return { results: STORE.filter((item) => ids.has(String(item.id))) };
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

// --- validation --------------------------------------------------------------------------------
const bad: Array<[string, unknown]> = [
  ['non-object body', 'nope'],
  ['missing user_id', { ids: ['m1'] }],
  ['ids not an array', { user_id: 'u', ids: 'm1' }],
  ['empty ids', { user_id: 'u', ids: [] }],
  ['over the 20-id cap', { user_id: 'u', ids: Array.from({ length: 21 }, (_, i) => `m${i}`) }],
  ['non-string id', { user_id: 'u', ids: ['m1', 7] }],
  ['blank id', { user_id: 'u', ids: ['m1', '   '] }],
  ['over-long id', { user_id: 'u', ids: ['x'.repeat(129)] }],
];
for (const [name, body] of bad) {
  const result = validateGetMemories(body);
  check(`rejects ${name}`, result.ok === false, JSON.stringify(result));
}

const exactly20 = validateGetMemories({ user_id: 'u', ids: Array.from({ length: 20 }, (_, i) => `m${i}`) });
check('accepts exactly 20 ids', exactly20.ok === true, JSON.stringify(exactly20));

const normalized = validateGetMemories({ user_id: ' eval-user ', ids: [' m1 ', 'm1', 'm2'] });
check(
  'trims and de-duplicates ids while keeping request order',
  normalized.ok === true && JSON.stringify(normalized.data.ids) === JSON.stringify(['m1', 'm2']),
  JSON.stringify(normalized)
);

// --- service -----------------------------------------------------------------------------------
const recorded: Recorded[] = [];
const result = await getMemoriesByIds(fakeEnv(recorded), { user_id: 'eval-user', ids: ['m2', 'm1', 'm3', 'nope'] });

check(
  'returns the caller-owned rows in requested order',
  result.memories.map((memory) => memory.id).join(',') === 'm2,m1',
  JSON.stringify(result.memories.map((memory) => memory.id))
);
check(
  'a foreign-owned id is reported as missing, not returned',
  result.missing.join(',') === 'm3,nope' && !result.memories.some((memory) => memory.user_id !== 'eval-user'),
  JSON.stringify(result.missing)
);
check('content is returned whole, never truncated', result.memories[0]?.content === 'content of m2', String(result.memories[0]?.content));

const accessWrites = recorded.filter((entry) => entry.sql.includes('SET last_accessed_at'));
check(
  'a read by id refreshes last_accessed_at for exactly the found rows',
  accessWrites.length === 2 && accessWrites.every((entry) => ['m1', 'm2'].includes(String(entry.bindings[1]))),
  JSON.stringify(accessWrites.map((entry) => entry.bindings))
);

const events = recorded.filter((entry) => entry.sql.includes('INSERT INTO memory_events'));
check('writes exactly one audit event', events.length === 1, String(events.length));
check('the event is typed `get`', events[0]?.bindings[3] === 'get', JSON.stringify(events[0]?.bindings[3]));
const payload = JSON.parse(String(events[0]?.bindings[4] ?? '{}'));
check(
  'the event payload records requested/found/missing',
  payload.requested === 4 && payload.found === 2 && JSON.stringify(payload.missing_ids) === JSON.stringify(['m3', 'nope']),
  JSON.stringify(payload)
);

// track_access is internal-only, but the suggestion-style read must not bump the clock.
const untracked: Recorded[] = [];
await getMemoriesByIds(fakeEnv(untracked), { user_id: 'eval-user', ids: ['m1'], track_access: false });
check(
  'track_access:false skips the last_accessed_at write',
  untracked.filter((entry) => entry.sql.includes('SET last_accessed_at')).length === 0,
  JSON.stringify(untracked.map((entry) => entry.sql))
);

// An all-missing read still audits, and writes nothing.
const empty: Recorded[] = [];
const none = await getMemoriesByIds(fakeEnv(empty), { user_id: 'eval-user', ids: ['ghost'] });
check(
  'an all-missing read returns no memories and writes nothing but the event',
  none.memories.length === 0 && none.missing.join(',') === 'ghost' && empty.filter((entry) => entry.sql.startsWith('UPDATE')).length === 0,
  JSON.stringify(none)
);

console.log(`memory-get eval: ${pass}/${pass + failures.length} checks passed`);
if (failures.length > 0) {
  console.log('fail:');
  for (const failure of failures) console.log(`- ${failure}`);
  process.exit(1);
}
