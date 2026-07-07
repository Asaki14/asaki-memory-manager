import type { Env, MemoryRow, SearchResult } from '../types';
import { createMemory, deleteMemory, searchMemories, updateMemoryContent } from './memories';
import { writeMemoryEvent } from './memoryEvents';

import { bestUsableMatch, chooseDecision, heuristicDecision, lexicalSimilarity, mergeContent, type CandidateAction, type ProcessMemoryCandidateInput } from './candidateDecision';
export type { CandidateAction, ProcessMemoryCandidateInput } from './candidateDecision';
export { heuristicDecision, mergeContent, dedupeCandidateBatch, isAutoAddEligible, AUTO_ADD_MIN_IMPORTANCE } from './candidateDecision';

export interface CandidateDecision {
  action: CandidateAction;
  candidate: ProcessMemoryCandidateInput;
  memory?: MemoryRow;
  matched_memory?: SearchResult;
  reason: string;
}

const DEDUP_SYSTEM_PROMPT =
  'Decide what to do with a memory candidate given an existing similar memory. Choose "ignore" when the candidate is the same durable fact/preference/rule, a paraphrase, translation, or subset of the existing memory. Choose "update" when the candidate contradicts or supersedes the existing memory — a changed decision, preference, or value for the same fact (e.g. existing says "use npm", candidate says "use pnpm instead") — the existing memory\'s content should be replaced by the candidate\'s. Choose "delete" when the candidate explicitly asks to forget, retract, or invalidate the existing memory itself, rather than replace it with a new value (e.g. "forget that I prefer dark mode", "that decision is no longer valid"). Choose "merge" only when the candidate adds genuinely new, non-contradictory detail to the same memory. If they merely share project names or broad terms but describe different facts, choose "add". Return strict JSON: {"action":"add|merge|update|delete|ignore","reason":"short reason"}.';

async function requestDedupDecision(env: Env, candidate: ProcessMemoryCandidateInput, match: SearchResult): Promise<{ action: CandidateAction; reason: string } | { invalidRaw: string }> {
  const response = await env.AI!.run(env.MEMORY_LLM_MODEL!, {
    messages: [
      { role: 'system', content: DEDUP_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ candidate: candidate.content, existing_memory: match.content }) },
    ],
  });
  const raw = typeof response === 'string' ? response : (response as any)?.response ?? (response as any)?.result?.response ?? '';
  const parsed = JSON.parse(String(raw).match(/\{[\s\S]*\}/)?.[0] ?? '{}') as { action?: CandidateAction; reason?: string };
  if (parsed.action === 'add' || parsed.action === 'merge' || parsed.action === 'update' || parsed.action === 'delete' || parsed.action === 'ignore') {
    return { action: parsed.action, reason: parsed.reason ?? 'LLM decision.' };
  }
  return { invalidRaw: String(raw) };
}

// The small model occasionally returns a response with no parseable/valid "action" — silently
// falling back to heuristics on the first miss would defeat the update/delete detection these
// exist for, so retry once before giving up, and log either way for visibility.
async function llmDecision(env: Env, candidate: ProcessMemoryCandidateInput, match?: SearchResult): Promise<{ action: CandidateAction; reason: string } | null> {
  if (!env.AI || !env.MEMORY_LLM_MODEL || !match) return null;
  let lastInvalidRaw: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await requestDedupDecision(env, candidate, match);
      if ('action' in result) return result;
      lastInvalidRaw = result.invalidRaw;
    } catch (error) {
      await writeMemoryEvent(env, {
        userId: candidate.user_id,
        eventType: 'llm_dedup_failed',
        payload: { attempt, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  await writeMemoryEvent(env, {
    userId: candidate.user_id,
    eventType: 'llm_dedup_invalid_response',
    payload: { raw: lastInvalidRaw?.slice(0, 500) ?? null },
  });
  return null;
}

export async function findLexicalMatch(env: Env, candidate: ProcessMemoryCandidateInput): Promise<SearchResult | undefined> {
  const result = await env.DB.prepare(
    `SELECT * FROM memories
     WHERE user_id = ?1 AND status = 'active' AND scope = ?2
     ORDER BY updated_at DESC
     LIMIT 100`
  )
    .bind(candidate.user_id, candidate.scope)
    .all<MemoryRow>();

  let best: SearchResult | undefined;
  for (const row of result.results ?? []) {
    if (row.scope === 'project' && candidate.project_id && row.project_id !== candidate.project_id) continue;
    if (row.scope === 'session' && candidate.session_id && row.session_id !== candidate.session_id) continue;
    const similarity = lexicalSimilarity(candidate.content, row.content);
    if (!best || similarity > best.similarity) {
      best = { ...row, similarity, score: similarity, score_details: { semantic: 0, keyword: similarity, entity: 0, metadata: 0, source: 'keyword' } };
    }
  }
  return best && best.similarity >= 0.5 ? best : undefined;
}

export async function processMemoryCandidate(env: Env, candidate: ProcessMemoryCandidateInput): Promise<CandidateDecision> {
  const similar = await searchMemories(env, {
    query: candidate.content,
    user_id: candidate.user_id,
    scope: candidate.scope,
    project_id: candidate.project_id ?? null,
    session_id: candidate.session_id ?? null,
    top_k: 5,
  });
  const match = bestUsableMatch(candidate, [...similar, await findLexicalMatch(env, candidate)]);
  const decision = chooseDecision(candidate, match, await llmDecision(env, candidate, match));

  if (decision.action === 'ignore') {
    await writeMemoryEvent(env, {
      memoryId: match?.id ?? null,
      userId: candidate.user_id,
      eventType: 'ignore',
      payload: { candidate, matched_memory_id: match?.id, reason: decision.reason },
    });
    return { action: 'ignore', candidate, matched_memory: match, reason: decision.reason };
  }

  if (decision.action === 'merge' && match) {
    const memory = await updateMemoryContent(env, match, {
      content: mergeContent(match.content, candidate.content),
      importance: Math.max(match.importance, candidate.importance),
      confidence: Math.max(match.confidence, candidate.confidence),
    });
    await writeMemoryEvent(env, {
      memoryId: memory.id,
      userId: candidate.user_id,
      eventType: 'merge',
      payload: { candidate, matched_memory_id: match.id, reason: decision.reason },
    });
    return { action: 'merge', candidate, memory, matched_memory: match, reason: decision.reason };
  }

  if (decision.action === 'update' && match) {
    const memory = await updateMemoryContent(env, match, {
      content: candidate.content,
      importance: candidate.importance,
      confidence: candidate.confidence,
    });
    await writeMemoryEvent(env, {
      memoryId: memory.id,
      userId: candidate.user_id,
      eventType: 'supersede',
      payload: { candidate, matched_memory_id: match.id, previous_content: match.content, reason: decision.reason },
    });
    return { action: 'update', candidate, memory, matched_memory: match, reason: decision.reason };
  }

  if (decision.action === 'delete' && match) {
    const memory = await deleteMemory(env, match.id, candidate.user_id);
    if (memory) {
      return { action: 'delete', candidate, memory, matched_memory: match, reason: decision.reason };
    }
  }

  const memory = await createMemory(env, candidate);
  return { action: 'add', candidate, memory, matched_memory: match, reason: decision.reason };
}

export async function processMemoryCandidates(env: Env, candidates: ProcessMemoryCandidateInput[]): Promise<CandidateDecision[]> {
  const decisions: CandidateDecision[] = [];
  for (const candidate of candidates) {
    decisions.push(await processMemoryCandidate(env, candidate));
  }
  return decisions;
}
