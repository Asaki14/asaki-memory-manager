// Offline regression coverage for audit-facing read reliability: bounded review suggestions,
// whole-store project discovery, and one global pending-review count.
import { readFileSync } from 'node:fs';
import { registerTsResolver } from './node-ts-resolver.mjs';

registerTsResolver();

// Cloudflare Workers adds crypto.subtle.timingSafeEqual; Node's WebCrypto does not.
if (!(crypto.subtle as any).timingSafeEqual) {
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    value(a: ArrayBufferView, b: ArrayBufferView) {
      const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      const right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      if (left.length !== right.length) return false;
      let difference = 0;
      for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
      return difference === 0;
    },
  });
}

const { validateListMemoryReviews, validateListMemoryProjects } = await import('../src/utils/validation.ts');
const { listMemoryProjects } = await import('../src/services/memories.ts');
const { listMemoryReviews } = await import('../src/services/reviews.ts');
const { default: app } = await import('../src/index.ts');

const failures: string[] = [];
let passes = 0;
function check(name: string, condition: boolean, detail: string): void {
  if (condition) passes += 1;
  else failures.push(`${name}: ${detail}`);
}

const oversized = validateListMemoryReviews({
  user_id: 'audit-user',
  status: 'pending',
  include_suggestions: true,
  limit: 100,
  offset: 12,
});
check(
  'previously crashing suggestion shape is rejected before service work',
  !oversized.ok && oversized.error === 'limit must be <= 12 when include_suggestions is true; page with offset to bound similarity lookup work.',
  JSON.stringify(oversized),
);
const crashShapeResponse = await app.fetch(
  new Request('https://memory.test/v1/memories/reviews/list', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: 'audit-user', status: 'pending', include_suggestions: true, limit: 100, offset: 12 }),
  }),
  { ADMIN_API_KEY: 'test-key' } as any,
);
check(
  'previously crashing call shape returns fast HTTP 400',
  crashShapeResponse.status === 400 && (await crashShapeResponse.json() as any).error === 'limit must be <= 12 when include_suggestions is true; page with offset to bound similarity lookup work.',
  `status=${crashShapeResponse.status}`,
);

check(
  'bounded suggestion page remains valid',
  validateListMemoryReviews({ user_id: 'audit-user', include_suggestions: true, limit: 12, offset: 12 }).ok,
  'limit=12 should pass',
);
check(
  'ordinary review pages retain limit=100',
  validateListMemoryReviews({ user_id: 'audit-user', limit: 100, offset: 12 }).ok,
  'non-suggestion limit=100 should pass',
);

const projectValidation = validateListMemoryProjects({ user_id: ' audit-user ', limit: 100, offset: 3 });
check(
  'project enumeration validates paging',
  projectValidation.ok && projectValidation.data.user_id === 'audit-user' && projectValidation.data.offset === 3,
  JSON.stringify(projectValidation),
);

const statements: Array<{ sql: string; bindings: unknown[] }> = [];
const projectRows = [
  { project_id: 'hidden-project', memory_count: 4, active_memory_count: 3, pending_review_count: 7 },
  { project_id: 'known-project', memory_count: 9, active_memory_count: 8, pending_review_count: 2 },
];
const env = {
  DB: {
    prepare(sql: string) {
      const record = { sql, bindings: [] as unknown[] };
      const stmt = {
        bind(...bindings: unknown[]) {
          record.bindings = bindings;
          return stmt;
        },
        async all() {
          statements.push(record);
          if (sql.includes('GROUP BY m.project_id')) return { results: projectRows };
          if (sql.includes('FROM memory_reviews')) return { results: [] };
          return { results: [] };
        },
        async first() {
          statements.push(record);
          if (sql.includes('COUNT(*) AS count FROM memory_reviews')) return { count: 113 };
          return null;
        },
        async run() {
          statements.push(record);
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  },
} as any;

const projects = await listMemoryProjects(env, { user_id: 'audit-user', limit: 100, offset: 0 });
check('project enumeration returns unregistered project ids', projects[0]?.project_id === 'hidden-project', JSON.stringify(projects));
const projectSql = statements.find((item) => item.sql.includes('GROUP BY m.project_id'));
check(
  'project enumeration is user-scoped and includes active/pending counts',
  Boolean(projectSql?.sql.includes("m.user_id = ?1") && projectSql.sql.includes("m.status = 'active'") && projectSql.sql.includes("r.pending_review_count")),
  projectSql?.sql ?? 'missing SQL',
);
check(
  'project enumeration binds user and page',
  JSON.stringify(projectSql?.bindings) === JSON.stringify(['audit-user', 100, 0]),
  JSON.stringify(projectSql?.bindings),
);

const reviewResult = await listMemoryReviews(env, {
  user_id: 'audit-user',
  status: 'pending',
  project_id: 'known-project',
  limit: 100,
  offset: 0,
  include_suggestions: false,
});
check(
  'pending_count is global even when page is project-filtered and empty',
  reviewResult.reviews.length === 0 && reviewResult.pending_count === 113,
  JSON.stringify(reviewResult),
);
const countSql = statements.find((item) => item.sql.includes('COUNT(*) AS count FROM memory_reviews'));
check(
  'canonical pending count includes exactly user + pending status',
  countSql?.sql.includes("WHERE user_id = ?1 AND status = 'pending'") === true && JSON.stringify(countSql.bindings) === JSON.stringify(['audit-user']),
  JSON.stringify(countSql),
);

const remoteMcp = readFileSync(new URL('../src/mcp.ts', import.meta.url), 'utf8');
const stdioMcp = readFileSync(new URL('../integrations/mcp/asaki-memory.ts', import.meta.url), 'utf8');
for (const [name, source] of [['remote MCP', remoteMcp], ['stdio MCP', stdioMcp]] as const) {
  check(`${name} exposes project enumeration`, source.includes('asaki_memory_project_list') && source.includes('/v1/memories/projects'), 'tool or route missing');
  check(`${name} documents suggestion bound`, source.includes('requires limit <= 12'), 'limit contract missing');
  check(`${name} documents pending count`, source.includes('pending_count always means all pending rows'), 'count contract missing');
  check(`${name} documents omitted-scope visibility`, source.includes('with neither id it returns only global memories'), 'scope contract missing');
}

if (failures.length > 0) {
  console.error(`audit read API eval failed (${passes} passed, ${failures.length} failed)`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`audit read API eval passed (${passes} checks)`);
