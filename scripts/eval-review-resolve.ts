// Offline unit coverage for resolveMemoryReview()'s audit-safe update content override.
// Uses a fake D1 and no Worker, Vectorize, network, or model.
import { registerTsResolver } from './node-ts-resolver.mjs';

registerTsResolver();

const { resolveMemoryReview } = await import('../src/services/reviews.ts');

const failures: string[] = [];
let pass = 0;

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    pass += 1;
    return;
  }
  failures.push(`${name}: ${detail}`);
}

function targetMemory() {
  return {
    id: 'mem-target',
    user_id: 'eval-user',
    scope: 'project',
    project_id: 'p1',
    session_id: null,
    kind: 'decision',
    content: 'Detailed active memory with rationale and constraints.',
    status: 'active',
    index_status: 'indexed',
    importance: 0.9,
    confidence: 0.95,
    source: 'manual',
    metadata_json: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    last_accessed_at: null,
  } as any;
}

function reviewRecord(id: string) {
  return {
    id,
    user_id: 'eval-user',
    status: 'pending',
    candidate_json: JSON.stringify({
      user_id: 'eval-user',
      scope: 'project',
      project_id: 'p1',
      session_id: null,
      kind: 'fact',
      content: 'Coarse candidate text.',
      importance: 0.4,
      confidence: 0.6,
      source: 'pi:agent-end-classifier',
    }),
    resolved_action: null,
    memory_id: null,
    project_id: 'p1',
    session_id: null,
    source: 'pi:agent-end-classifier',
    reason: null,
    created_at: '2026-08-20T00:00:00.000Z',
    updated_at: '2026-08-20T00:00:00.000Z',
    resolved_at: null,
  } as any;
}

function fakeEnv(reviewId: string) {
  const target = targetMemory();
  const review = reviewRecord(reviewId);
  const recorded: Array<{ sql: string; bindings: unknown[] }> = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const entry = { sql, bindings: [] as unknown[] };
        const stmt = {
          bind(...bindings: unknown[]) {
            entry.bindings = bindings;
            return stmt;
          },
          async first() {
            recorded.push(entry);
            if (sql.includes('FROM memory_reviews')) return review;
            if (sql.includes('FROM memories')) return target;
            return null;
          },
          async run() {
            recorded.push(entry);
            return { meta: { changes: 1 } };
          },
          async all() {
            recorded.push(entry);
            return { results: [] };
          },
        };
        return stmt;
      },
    },
  } as any;
  return { env, recorded, target };
}

// Explicit content is the exact resulting text and preserves target metadata by default.
{
  const { env, target } = fakeEnv('rev-content');
  const result = await resolveMemoryReview(env, 'rev-content', {
    user_id: 'eval-user',
    action: 'update',
    memory_id: target.id,
    content: 'Merged detailed text chosen by the operator.',
  });
  check('explicit content wins over candidate text', result.memory?.content === 'Merged detailed text chosen by the operator.', JSON.stringify(result.memory));
  check('explicit content does not clobber target kind', result.memory?.kind === target.kind, JSON.stringify(result.memory));
  check('explicit content preserves target importance', result.memory?.importance === target.importance, JSON.stringify(result.memory));
}

// Backward compatibility: without content, candidate content and metadata still win.
{
  const { env, target } = fakeEnv('rev-legacy');
  const result = await resolveMemoryReview(env, 'rev-legacy', {
    user_id: 'eval-user',
    action: 'update',
    memory_id: target.id,
  });
  check('legacy update still uses candidate text', result.memory?.content === 'Coarse candidate text.', JSON.stringify(result.memory));
  check('legacy update still uses candidate kind', result.memory?.kind === 'fact', JSON.stringify(result.memory));
  check('legacy update still uses candidate importance', result.memory?.importance === 0.4, JSON.stringify(result.memory));
}

// Explicit metadata remains available when the operator intentionally changes it.
{
  const { env, target } = fakeEnv('rev-explicit-metadata');
  const result = await resolveMemoryReview(env, 'rev-explicit-metadata', {
    user_id: 'eval-user',
    action: 'update',
    memory_id: target.id,
    content: 'Exact replacement.',
    kind: 'rule',
    importance: 0.8,
    confidence: 0.85,
  });
  check('explicit update metadata is honored', result.memory?.kind === 'rule' && result.memory.importance === 0.8 && result.memory.confidence === 0.85, JSON.stringify(result.memory));
}

if (failures.length > 0) {
  console.error(`review-resolve eval FAILED (${pass} passed, ${failures.length} failed)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`review-resolve eval passed (${pass}/${pass})`);
