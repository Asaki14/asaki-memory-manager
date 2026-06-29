import type { Env, MemoryReviewRecord, MemoryReviewRow } from '../types';
import { createMemory, getMemory, updateMemoryContent } from './memories';
import { writeMemoryEvent } from './memoryEvents';
import { mergeContent, type CandidateAction, type ProcessMemoryCandidateInput } from './candidateDecision';

function nowIso(): string {
  return new Date().toISOString();
}

function parseReview(row: MemoryReviewRecord): MemoryReviewRow {
  return {
    id: row.id,
    user_id: row.user_id,
    status: row.status,
    candidate: JSON.parse(row.candidate_json) as ProcessMemoryCandidateInput,
    resolved_action: row.resolved_action,
    memory_id: row.memory_id,
    project_id: row.project_id,
    session_id: row.session_id,
    source: row.source,
    reason: row.reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
    resolved_at: row.resolved_at,
  };
}

export async function createMemoryReviews(env: Env, candidates: ProcessMemoryCandidateInput[]): Promise<MemoryReviewRow[]> {
  const timestamp = nowIso();
  const reviews: MemoryReviewRow[] = [];

  for (const candidate of candidates) {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO memory_reviews (
        id, user_id, status, candidate_json, project_id, session_id, source, created_at, updated_at
      ) VALUES (?1, ?2, 'pending', ?3, ?4, ?5, ?6, ?7, ?8)`
    )
      .bind(id, candidate.user_id, JSON.stringify(candidate), candidate.project_id ?? null, candidate.session_id ?? null, candidate.source ?? null, timestamp, timestamp)
      .run();

    reviews.push({
      id,
      user_id: candidate.user_id,
      status: 'pending',
      candidate,
      resolved_action: null,
      memory_id: null,
      project_id: candidate.project_id ?? null,
      session_id: candidate.session_id ?? null,
      source: candidate.source ?? null,
      reason: null,
      created_at: timestamp,
      updated_at: timestamp,
      resolved_at: null,
    });
  }

  if (reviews.length > 0) {
    await writeMemoryEvent(env, {
      userId: reviews[0].user_id,
      eventType: 'review_create',
      payload: { count: reviews.length, review_ids: reviews.map((review) => review.id) },
    });
  }

  return reviews;
}

export async function listMemoryReviews(env: Env, input: { user_id: string; status: 'pending' | 'resolved' | 'all'; project_id?: string | null; session_id?: string | null; source?: string | null; limit: number; offset: number }): Promise<MemoryReviewRow[]> {
  const clauses = ['user_id = ?'];
  const bindings: unknown[] = [input.user_id];

  if (input.status !== 'all') {
    clauses.push('status = ?');
    bindings.push(input.status);
  }
  if (input.project_id) {
    clauses.push('project_id = ?');
    bindings.push(input.project_id);
  }
  if (input.session_id) {
    clauses.push('session_id = ?');
    bindings.push(input.session_id);
  }
  if (input.source) {
    clauses.push('source = ?');
    bindings.push(input.source);
  }

  const result = await env.DB.prepare(
    `SELECT * FROM memory_reviews
     WHERE ${clauses.join(' AND ')}
     ORDER BY updated_at DESC, created_at DESC
     LIMIT ? OFFSET ?`
  )
    .bind(...bindings, input.limit, input.offset)
    .all<MemoryReviewRecord>();

  return (result.results ?? []).map(parseReview);
}

export async function resolveMemoryReview(env: Env, id: string, input: { user_id: string; action: CandidateAction; memory_id?: string | null; reason?: string | null }): Promise<{ review: MemoryReviewRow; memory?: Awaited<ReturnType<typeof createMemory>> }> {
  const existing = await env.DB.prepare('SELECT * FROM memory_reviews WHERE id = ?1 AND user_id = ?2').bind(id, input.user_id).first<MemoryReviewRecord>();
  if (!existing) throw new Error('Review not found.');
  if (existing.status !== 'pending') throw new Error('Review is already resolved.');

  const review = parseReview(existing);
  let memory: Awaited<ReturnType<typeof createMemory>> | undefined;

  if (input.action === 'add') {
    memory = await createMemory(env, review.candidate);
  }

  if (input.action === 'merge') {
    if (!input.memory_id) throw new Error('memory_id is required when action is merge.');
    const target = await getMemory(env, input.memory_id, input.user_id);
    if (!target) throw new Error('Target memory not found.');
    memory = await updateMemoryContent(env, target, {
      content: mergeContent(target.content, review.candidate.content),
      importance: Math.max(target.importance, review.candidate.importance),
      confidence: Math.max(target.confidence, review.candidate.confidence),
    });
  }

  const timestamp = nowIso();
  const memoryId = memory?.id ?? input.memory_id ?? null;
  await env.DB.prepare(
    `UPDATE memory_reviews
     SET status = 'resolved', resolved_action = ?1, memory_id = ?2, reason = ?3, updated_at = ?4, resolved_at = ?5
     WHERE id = ?6 AND user_id = ?7`
  )
    .bind(input.action, memoryId, input.reason ?? null, timestamp, timestamp, id, input.user_id)
    .run();

  await writeMemoryEvent(env, {
    memoryId,
    userId: input.user_id,
    eventType: 'review_resolve',
    payload: { review_id: id, action: input.action, reason: input.reason ?? null },
  });

  return {
    review: {
      ...review,
      status: 'resolved',
      resolved_action: input.action,
      memory_id: memoryId,
      reason: input.reason ?? null,
      updated_at: timestamp,
      resolved_at: timestamp,
    },
    memory,
  };
}
