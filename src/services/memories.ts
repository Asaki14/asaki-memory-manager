import { generateEmbedding } from '../ai/embeddings';
import type { CreateMemoryInput, Env, MemoryRow, SearchMemoriesInput, SearchResult } from '../types';
import { writeMemoryEvent } from './memoryEvents';

function nowIso(): string {
  return new Date().toISOString();
}

function metadataFor(memory: Pick<MemoryRow, 'id' | 'user_id' | 'scope' | 'project_id' | 'session_id' | 'kind'>): Record<string, string> {
  return {
    memory_id: memory.id,
    user_id: memory.user_id,
    scope: memory.scope,
    project_id: memory.project_id ?? '',
    session_id: memory.session_id ?? '',
    kind: memory.kind,
  };
}

async function upsertVector(env: Env, memory: MemoryRow, embedding: number[] | null): Promise<'indexed' | 'pending' | 'failed'> {
  if (!embedding || !env.VECTORIZE) return 'pending';
  try {
    await (env.VECTORIZE as any).upsert([
      {
        id: memory.id,
        values: embedding,
        metadata: metadataFor(memory),
      },
    ]);
    return 'indexed';
  } catch (error) {
    await writeMemoryEvent(env, {
      memoryId: memory.id,
      userId: memory.user_id,
      eventType: 'vectorize_failed',
      payload: { message: error instanceof Error ? error.message : String(error) },
    });
    return 'failed';
  }
}

export async function createMemory(env: Env, input: Required<Pick<CreateMemoryInput, 'content' | 'user_id' | 'scope' | 'kind' | 'importance' | 'confidence'>> & Omit<CreateMemoryInput, 'content' | 'user_id' | 'scope' | 'kind' | 'importance' | 'confidence'>): Promise<MemoryRow> {
  const id = crypto.randomUUID();
  const timestamp = nowIso();
  const baseMemory: MemoryRow = {
    id,
    user_id: input.user_id,
    scope: input.scope,
    project_id: input.project_id ?? null,
    session_id: input.session_id ?? null,
    content: input.content,
    kind: input.kind,
    importance: input.importance,
    confidence: input.confidence,
    status: 'active',
    source: input.source ?? null,
    index_status: 'pending',
    created_at: timestamp,
    updated_at: timestamp,
    last_accessed_at: null,
    expires_at: input.expires_at ?? null,
  };

  const embedding = await generateEmbedding(env, input.content);

  await env.DB.prepare(
    `INSERT INTO memories (
      id, user_id, scope, project_id, session_id, content, kind, importance, confidence,
      status, source, index_status, created_at, updated_at, expires_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`
  )
    .bind(
      baseMemory.id,
      baseMemory.user_id,
      baseMemory.scope,
      baseMemory.project_id,
      baseMemory.session_id,
      baseMemory.content,
      baseMemory.kind,
      baseMemory.importance,
      baseMemory.confidence,
      baseMemory.status,
      baseMemory.source,
      baseMemory.index_status,
      baseMemory.created_at,
      baseMemory.updated_at,
      baseMemory.expires_at
    )
    .run();

  const indexStatus = await upsertVector(env, baseMemory, embedding);
  if (indexStatus !== 'pending') {
    await env.DB.prepare('UPDATE memories SET index_status = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(indexStatus, nowIso(), id)
      .run();
    baseMemory.index_status = indexStatus;
  }

  await writeMemoryEvent(env, {
    memoryId: id,
    userId: input.user_id,
    eventType: 'add',
    payload: {
      scope: input.scope,
      kind: input.kind,
      index_status: baseMemory.index_status,
    },
  });

  return baseMemory;
}

function scopeWeight(memory: MemoryRow, input: SearchMemoriesInput): number {
  if (memory.scope === 'project' && input.project_id && memory.project_id === input.project_id) return 0.08;
  if (memory.scope === 'global') return 0.04;
  if (memory.scope === 'session' && input.session_id && memory.session_id === input.session_id) return 0.03;
  return 0;
}

function recencyWeight(memory: MemoryRow): number {
  const created = Date.parse(memory.updated_at || memory.created_at);
  if (Number.isNaN(created)) return 0;
  const ageDays = Math.max(0, (Date.now() - created) / 86_400_000);
  return Math.max(0, 0.04 - ageDays * 0.001);
}

function fuseScore(memory: MemoryRow, similarity: number, input: SearchMemoriesInput): number {
  return Math.min(1, similarity * 0.82 + memory.importance * 0.05 + memory.confidence * 0.05 + scopeWeight(memory, input) + recencyWeight(memory));
}

function isVisibleInScope(memory: MemoryRow, input: SearchMemoriesInput): boolean {
  if (memory.user_id !== input.user_id || memory.status !== 'active') return false;
  if (input.scope) {
    if (memory.scope !== input.scope) return false;
    if (input.scope === 'project' && input.project_id && memory.project_id !== input.project_id) return false;
    if (input.scope === 'session' && input.session_id && memory.session_id !== input.session_id) return false;
    return true;
  }

  if (memory.scope === 'global') return true;
  if (memory.scope === 'project') return Boolean(input.project_id && memory.project_id === input.project_id);
  if (memory.scope === 'session') return Boolean(input.session_id && memory.session_id === input.session_id);
  return false;
}

async function selectMemoriesByIds(env: Env, ids: string[]): Promise<MemoryRow[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(', ');
  const result = await env.DB.prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`).bind(...ids).all<MemoryRow>();
  return result.results ?? [];
}

async function vectorSearch(env: Env, input: Required<Pick<SearchMemoriesInput, 'query' | 'user_id' | 'top_k'>> & Omit<SearchMemoriesInput, 'query' | 'user_id' | 'top_k'>): Promise<SearchResult[] | null> {
  if (!env.VECTORIZE) return null;
  const embedding = await generateEmbedding(env, input.query);
  if (!embedding) return null;

  const filter: Record<string, string> = { user_id: input.user_id };
  if (input.scope) filter.scope = input.scope;
  if (input.scope === 'project' && input.project_id) filter.project_id = input.project_id;
  if (input.scope === 'session' && input.session_id) filter.session_id = input.session_id;

  const response = await (env.VECTORIZE as any).query(embedding, {
    topK: Math.max(input.top_k * 3, input.top_k),
    returnMetadata: 'all',
    filter,
  });
  const matches = Array.isArray(response?.matches) ? response.matches : [];
  const ids = matches.map((match: any) => String(match.id)).filter(Boolean);
  const rows = await selectMemoriesByIds(env, ids);
  const rowById = new Map(rows.map((row) => [row.id, row]));

  const results: SearchResult[] = [];
  for (const match of matches) {
    const row = rowById.get(String(match.id));
    if (!row || !isVisibleInScope(row, input)) continue;
    const similarity = typeof match.score === 'number' ? match.score : 0;
    results.push({
      ...row,
      similarity,
      score: fuseScore(row, similarity, input),
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, input.top_k);
}

function lexicalSimilarityForSearch(query: string, content: string): number {
  const normalize = (value: string) => value.toLowerCase().replace(/[\s，。,.!！?？:：;；"'“”‘’（）()【】\[\]{}]/g, '');
  const left = new Set(normalize(query));
  const right = new Set(normalize(content));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const char of left) {
    if (right.has(char)) intersection += 1;
  }
  return intersection / Math.max(left.size, right.size);
}

async function fallbackSearch(env: Env, input: Required<Pick<SearchMemoriesInput, 'query' | 'user_id' | 'top_k'>> & Omit<SearchMemoriesInput, 'query' | 'user_id' | 'top_k'>): Promise<SearchResult[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM memories
     WHERE user_id = ?1 AND status = 'active'
     ORDER BY importance DESC, updated_at DESC
     LIMIT ?2`
  )
    .bind(input.user_id, Math.max(input.top_k * 20, 100))
    .all<MemoryRow>();

  return (result.results ?? [])
    .filter((row) => isVisibleInScope(row, input))
    .map((row) => {
      const similarity = lexicalSimilarityForSearch(input.query, row.content);
      return { ...row, similarity, score: fuseScore(row, similarity, input) };
    })
    .filter((row) => row.similarity > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.top_k);
}

function mergeSearchResults(results: SearchResult[][], topK: number): SearchResult[] {
  const byId = new Map<string, SearchResult>();
  for (const group of results) {
    for (const result of group) {
      const current = byId.get(result.id);
      if (!current || result.score > current.score) byId.set(result.id, result);
    }
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, topK);
}

export async function searchMemories(env: Env, input: Required<Pick<SearchMemoriesInput, 'query' | 'user_id' | 'top_k'>> & Omit<SearchMemoriesInput, 'query' | 'user_id' | 'top_k'>): Promise<SearchResult[]> {
  let vectorResults: SearchResult[] | null = null;
  try {
    vectorResults = await vectorSearch(env, input);
  } catch (error) {
    await writeMemoryEvent(env, {
      userId: input.user_id,
      eventType: 'vector_search_failed',
      payload: { message: error instanceof Error ? error.message : String(error) },
    });
  }

  const lexicalResults = await fallbackSearch(env, input);
  const results = vectorResults ? mergeSearchResults([vectorResults, lexicalResults], input.top_k) : lexicalResults;

  if (results.length > 0) {
    const timestamp = nowIso();
    await Promise.all(
      results.map((memory) => env.DB.prepare('UPDATE memories SET last_accessed_at = ?1 WHERE id = ?2').bind(timestamp, memory.id).run())
    );
  }

  await writeMemoryEvent(env, {
    userId: input.user_id,
    eventType: 'search',
    payload: { query: input.query, top_k: input.top_k, result_count: results.length },
  });

  return results;
}

export async function updateMemoryContent(env: Env, memory: MemoryRow, input: { content: string; importance: number; confidence: number }): Promise<MemoryRow> {
  const updatedAt = nowIso();
  const updated: MemoryRow = {
    ...memory,
    content: input.content,
    importance: input.importance,
    confidence: input.confidence,
    index_status: 'pending',
    updated_at: updatedAt,
  };
  const embedding = await generateEmbedding(env, updated.content);
  const indexStatus = await upsertVector(env, updated, embedding);
  updated.index_status = indexStatus;

  await env.DB.prepare(
    `UPDATE memories
     SET content = ?1, importance = ?2, confidence = ?3, index_status = ?4, updated_at = ?5
     WHERE id = ?6 AND user_id = ?7`
  )
    .bind(updated.content, updated.importance, updated.confidence, updated.index_status, updated.updated_at, updated.id, updated.user_id)
    .run();

  return updated;
}
