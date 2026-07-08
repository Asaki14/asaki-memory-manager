import { generateEmbedding } from '../ai/embeddings';
import type { CreateMemoryInput, Env, ListMemoriesInput, MemoryRow, SearchMemoriesInput, SearchResult, UpdateMemoryInput } from '../types';
import { writeMemoryEvent } from './memoryEvents';
import { scoreMemoryForSearch } from './searchScoring';

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

export async function upsertVector(env: Env, memory: MemoryRow, embedding: number[] | null): Promise<'indexed' | 'pending' | 'failed'> {
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
  };

  const embedding = await generateEmbedding(env, input.content);

  await env.DB.prepare(
    `INSERT INTO memories (
      id, user_id, scope, project_id, session_id, content, kind, importance, confidence,
      status, source, index_status, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
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
      baseMemory.updated_at
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
      ...scoreMemoryForSearch(row, input, similarity, 'vector'),
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, input.top_k);
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
    .map((row) => ({ ...row, similarity: 0, ...scoreMemoryForSearch(row, input, 0, 'keyword') }))
    .filter((row) => row.score_details.keyword > 0 || row.score_details.entity > 0)
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
  const merged = vectorResults ? mergeSearchResults([vectorResults, lexicalResults], input.top_k) : lexicalResults;
  const results = typeof input.min_score === 'number' ? merged.filter((result) => result.score >= input.min_score!) : merged;

  if (results.length > 0) {
    const timestamp = nowIso();
    await Promise.all(
      results.map((memory) => env.DB.prepare('UPDATE memories SET last_accessed_at = ?1 WHERE id = ?2').bind(timestamp, memory.id).run())
    );
  }

  await writeMemoryEvent(env, {
    userId: input.user_id,
    eventType: 'search',
    payload: {
      query: input.query,
      top_k: input.top_k,
      min_score: input.min_score,
      result_count: results.length,
      result_ids: results.map((result) => result.id),
      score_details: results.map((result) => result.score_details),
    },
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

export async function getMemory(env: Env, id: string, userId: string): Promise<MemoryRow | null> {
  const result = await env.DB.prepare('SELECT * FROM memories WHERE id = ?1 AND user_id = ?2').bind(id, userId).first<MemoryRow>();
  return result ?? null;
}

export async function listMemories(env: Env, input: Required<Pick<ListMemoriesInput, 'user_id' | 'status' | 'limit' | 'offset'>> & Omit<ListMemoriesInput, 'user_id' | 'status' | 'limit' | 'offset'>): Promise<MemoryRow[]> {
  const clauses = ['user_id = ?'];
  const bindings: unknown[] = [input.user_id];

  if (input.status !== 'all') {
    clauses.push('status = ?');
    bindings.push(input.status);
  }
  if (input.scope) {
    clauses.push('scope = ?');
    bindings.push(input.scope);
    if (input.scope === 'project') {
      clauses.push('project_id = ?');
      bindings.push(input.project_id);
    }
    if (input.scope === 'session') {
      clauses.push('session_id = ?');
      bindings.push(input.session_id);
    }
  } else {
    const scopeClauses = ['scope = ?'];
    bindings.push('global');
    if (input.project_id) {
      scopeClauses.push('(scope = ? AND project_id = ?)');
      bindings.push('project', input.project_id);
    }
    if (input.session_id) {
      scopeClauses.push('(scope = ? AND session_id = ?)');
      bindings.push('session', input.session_id);
    }
    clauses.push(`(${scopeClauses.join(' OR ')})`);
  }
  if (input.kind) {
    clauses.push('kind = ?');
    bindings.push(input.kind);
  }
  if (input.source) {
    clauses.push('source = ?');
    bindings.push(input.source);
  }

  const result = await env.DB.prepare(
    `SELECT * FROM memories
     WHERE ${clauses.join(' AND ')}
     ORDER BY updated_at DESC, created_at DESC
     LIMIT ? OFFSET ?`
  )
    .bind(...bindings, input.limit, input.offset)
    .all<MemoryRow>();

  await writeMemoryEvent(env, {
    userId: input.user_id,
    eventType: 'list',
    payload: { scope: input.scope, project_id: input.project_id, session_id: input.session_id, kind: input.kind, status: input.status, count: result.results?.length ?? 0 },
  });

  return result.results ?? [];
}

export async function updateMemory(env: Env, id: string, input: UpdateMemoryInput): Promise<MemoryRow | null> {
  const existing = await getMemory(env, id, input.user_id);
  if (!existing) return null;

  const updated: MemoryRow = {
    ...existing,
    content: input.content ?? existing.content,
    scope: input.scope ?? existing.scope,
    project_id: input.project_id !== undefined ? input.project_id : existing.project_id,
    session_id: input.session_id !== undefined ? input.session_id : existing.session_id,
    kind: input.kind ?? existing.kind,
    importance: input.importance ?? existing.importance,
    confidence: input.confidence ?? existing.confidence,
    status: input.status ?? existing.status,
    source: input.source !== undefined ? input.source : existing.source,
    updated_at: nowIso(),
  };

  if (updated.scope === 'global') {
    updated.project_id = null;
    updated.session_id = null;
  }
  if (updated.scope === 'project' && !updated.project_id) throw new Error('project_id is required when scope is project.');
  if (updated.scope === 'session' && !updated.session_id) throw new Error('session_id is required when scope is session.');

  const shouldReindex =
    updated.status === 'active' &&
    (updated.content !== existing.content ||
      updated.scope !== existing.scope ||
      updated.project_id !== existing.project_id ||
      updated.session_id !== existing.session_id ||
      updated.kind !== existing.kind);

  if (shouldReindex) {
    updated.index_status = await upsertVector(env, updated, await generateEmbedding(env, updated.content));
  }

  await env.DB.prepare(
    `UPDATE memories
     SET scope = ?1, project_id = ?2, session_id = ?3, content = ?4, kind = ?5,
         importance = ?6, confidence = ?7, status = ?8, source = ?9, index_status = ?10,
         updated_at = ?11
     WHERE id = ?12 AND user_id = ?13`
  )
    .bind(
      updated.scope,
      updated.project_id,
      updated.session_id,
      updated.content,
      updated.kind,
      updated.importance,
      updated.confidence,
      updated.status,
      updated.source,
      updated.index_status,
      updated.updated_at,
      updated.id,
      updated.user_id
    )
    .run();

  await writeMemoryEvent(env, {
    memoryId: updated.id,
    userId: updated.user_id,
    eventType: 'update',
    payload: { before: existing, after: updated },
  });

  return updated;
}

export async function backfillPendingIndex(env: Env, limit: number): Promise<{ checked: number; indexed: number; remaining: number; remaining_ids: string[] }> {
  const result = await env.DB.prepare(
    `SELECT * FROM memories WHERE status = 'active' AND index_status IN ('pending', 'failed') ORDER BY created_at ASC LIMIT ?1`
  )
    .bind(limit)
    .all<MemoryRow>();
  const rows = result.results ?? [];

  let indexed = 0;
  const remainingIds: string[] = [];
  for (const row of rows) {
    const embedding = await generateEmbedding(env, row.content);
    const indexStatus = await upsertVector(env, row, embedding);
    if (indexStatus !== row.index_status) {
      await env.DB.prepare('UPDATE memories SET index_status = ?1, updated_at = ?2 WHERE id = ?3')
        .bind(indexStatus, nowIso(), row.id)
        .run();
    }
    if (indexStatus === 'indexed') indexed++;
    else remainingIds.push(row.id);
  }

  return { checked: rows.length, indexed, remaining: remainingIds.length, remaining_ids: remainingIds };
}

async function softDeleteMemory(env: Env, memory: MemoryRow, eventType: string, payload: unknown): Promise<string> {
  const updatedAt = nowIso();
  await env.DB.prepare(`UPDATE memories SET status = 'deleted', updated_at = ?1 WHERE id = ?2`).bind(updatedAt, memory.id).run();

  if (env.VECTORIZE) {
    try {
      await (env.VECTORIZE as any).deleteByIds([memory.id]);
    } catch (error) {
      await writeMemoryEvent(env, {
        memoryId: memory.id,
        userId: memory.user_id,
        eventType: 'vectorize_delete_failed',
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  await writeMemoryEvent(env, { memoryId: memory.id, userId: memory.user_id, eventType, payload });
  return updatedAt;
}

export async function deleteMemory(env: Env, id: string, userId: string): Promise<MemoryRow | null> {
  const existing = await getMemory(env, id, userId);
  if (!existing) return null;
  const updatedAt = await softDeleteMemory(env, existing, 'delete', { before: existing });
  return { ...existing, status: 'deleted', updated_at: updatedAt };
}

export type StaleMemoryCandidate = Pick<MemoryRow, 'id' | 'user_id' | 'scope' | 'content' | 'kind' | 'importance' | 'last_accessed_at' | 'created_at'>;

export async function pruneStaleMemories(env: Env, params: { days: number; limit: number; apply: boolean }): Promise<{ checked: number; deleted: number; candidates: StaleMemoryCandidate[] }> {
  const cutoff = new Date(Date.now() - params.days * 86_400_000).toISOString();
  const result = await env.DB.prepare(
    `SELECT * FROM memories
     WHERE status = 'active' AND COALESCE(last_accessed_at, created_at) < ?1
     ORDER BY COALESCE(last_accessed_at, created_at) ASC
     LIMIT ?2`
  )
    .bind(cutoff, params.limit)
    .all<MemoryRow>();
  const rows = result.results ?? [];

  if (params.apply) {
    for (const row of rows) {
      await softDeleteMemory(env, row, 'prune_stale', { last_accessed_at: row.last_accessed_at, created_at: row.created_at, days: params.days });
    }
  }

  return {
    checked: rows.length,
    deleted: params.apply ? rows.length : 0,
    candidates: rows.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      scope: row.scope,
      content: row.content,
      kind: row.kind,
      importance: row.importance,
      last_accessed_at: row.last_accessed_at,
      created_at: row.created_at,
    })),
  };
}
