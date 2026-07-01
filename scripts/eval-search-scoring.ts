import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreMemoryForSearch } from '../src/services/searchScoring.ts';
import type { MemoryKind, MemoryRow, MemoryScope, SearchMemoriesInput, SearchScoreDetails } from '../src/types.ts';

type MemoryFixture = {
  id: string;
  content: string;
  scope?: MemoryScope;
  project_id?: string | null;
  session_id?: string | null;
  kind?: MemoryKind;
  importance?: number;
  confidence?: number;
  semantic?: number;
  source?: SearchScoreDetails['source'];
};

type SearchCase = {
  name: string;
  query: string;
  user_id?: string;
  project_id?: string | null;
  session_id?: string | null;
  top_k?: number;
  expected_top_ids: string[];
  bad_result_ids?: string[];
  memories: MemoryFixture[];
};

type ScoredMemory = MemoryRow & ReturnType<typeof scoreMemoryForSearch> & { similarity: number };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cases = JSON.parse(readFileSync(resolve(root, 'eval/search-cases.json'), 'utf8')) as SearchCase[];

function memory(input: MemoryFixture, item: SearchCase): MemoryRow {
  return {
    id: input.id,
    user_id: item.user_id ?? 'eval-user',
    scope: input.scope ?? 'project',
    project_id: input.scope === 'global' ? null : (input.project_id ?? item.project_id ?? 'eval-project'),
    session_id: input.session_id ?? item.session_id ?? null,
    content: input.content,
    kind: input.kind ?? 'fact',
    importance: input.importance ?? 0.5,
    confidence: input.confidence ?? 0.9,
    status: 'active',
    source: 'eval',
    index_status: 'indexed',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    last_accessed_at: null,
    expires_at: null,
  };
}

function score(item: SearchCase): ScoredMemory[] {
  const input: SearchMemoriesInput = {
    query: item.query,
    user_id: item.user_id ?? 'eval-user',
    project_id: item.project_id ?? null,
    session_id: item.session_id ?? null,
    top_k: item.top_k ?? 5,
  };

  return item.memories
    .map((fixture) => {
      const row = memory(fixture, item);
      const similarity = fixture.semantic ?? 0;
      return {
        ...row,
        similarity,
        ...scoreMemoryForSearch(row, input, similarity, fixture.source ?? (similarity > 0 ? 'vector' : 'keyword')),
      };
    })
    .sort((a, b) => b.score - a.score);
}

const failures: string[] = [];

for (const item of cases) {
  const ranked = score(item);
  const topK = ranked.slice(0, item.top_k ?? 5);
  const rankById = new Map(ranked.map((result, index) => [result.id, index]));

  for (const id of item.expected_top_ids) {
    if (!topK.some((result) => result.id === id)) {
      failures.push(`${item.name}: expected ${id} in top ${(item.top_k ?? 5)}, got ${topK.map((result) => result.id).join(', ')}`);
    }
  }

  for (const badId of item.bad_result_ids ?? []) {
    const badRank = rankById.get(badId);
    if (badRank === undefined) continue;
    for (const goodId of item.expected_top_ids) {
      const goodRank = rankById.get(goodId);
      if (goodRank !== undefined && badRank < goodRank) {
        failures.push(`${item.name}: bad result ${badId} outranked ${goodId}`);
      }
    }
  }
}

console.log(`search eval: ${cases.length - failures.length}/${cases.length} passed`);

if (failures.length > 0) {
  console.log('fail:');
  for (const failure of failures) console.log(`- ${failure}`);
  process.exit(1);
}
