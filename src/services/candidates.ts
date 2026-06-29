import type { CreateMemoryInput, Env, MemoryRow, SearchResult } from '../types';
import { createMemory, searchMemories, updateMemoryContent } from './memories';
import { writeMemoryEvent } from './memoryEvents';

type CandidateAction = 'add' | 'merge' | 'ignore';

export interface ProcessMemoryCandidateInput extends Required<Pick<CreateMemoryInput, 'content' | 'user_id' | 'scope' | 'kind' | 'importance' | 'confidence'>> {
  project_id?: string | null;
  session_id?: string | null;
  source?: string | null;
  expires_at?: string | null;
}

export interface CandidateDecision {
  action: CandidateAction;
  candidate: ProcessMemoryCandidateInput;
  memory?: MemoryRow;
  matched_memory?: SearchResult;
  reason: string;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[\s，。,.!！?？:：;；"'“”‘’（）()【】\[\]{}]/g, '');
}

function lexicalSimilarity(a: string, b: string): number {
  const left = new Set(normalizeText(a));
  const right = new Set(normalizeText(b));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const char of left) {
    if (right.has(char)) intersection += 1;
  }
  return intersection / Math.max(left.size, right.size);
}

const stopTokens = new Set(['a', 'an', 'and', 'be', 'by', 'for', 'in', 'into', 'is', 'not', 'of', 'on', 'or', 'should', 'the', 'to', 'using', 'with', 'without', 'introducing']);

function asciiTokens(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[a-z0-9][a-z0-9@_-]*/g) ?? []).filter((token) => !stopTokens.has(token)));
}

function containsAll(container: Set<string>, contained: Set<string>): boolean {
  if (contained.size === 0) return false;
  for (const token of contained) {
    if (!container.has(token)) return false;
  }
  return true;
}

function tokenDecision(candidate: string, existing: string): CandidateAction | null {
  const incoming = asciiTokens(candidate);
  const current = asciiTokens(existing);
  if (incoming.size < 3 || current.size < 3) return null;
  if (containsAll(current, incoming)) return 'ignore';
  if (containsAll(incoming, current)) return 'merge';
  return null;
}

function matchSimilarity(candidate: ProcessMemoryCandidateInput, match: SearchResult): number {
  const lexical = lexicalSimilarity(candidate.content, match.content);
  const semantic = match.similarity >= 0.78 ? match.similarity : 0;
  return Math.max(lexical, semantic);
}

function usableMatch(candidate: ProcessMemoryCandidateInput, match?: SearchResult): SearchResult | undefined {
  if (!match) return undefined;
  if (normalizeText(candidate.content) === normalizeText(match.content)) return match;
  if (tokenDecision(candidate.content, match.content) !== null) return match;
  return matchSimilarity(candidate, match) >= 0.5 ? match : undefined;
}

function heuristicDecision(candidate: ProcessMemoryCandidateInput, match?: SearchResult): { action: CandidateAction; reason: string } {
  if (!match) return { action: 'add', reason: 'No similar memory found.' };

  const existing = normalizeText(match.content);
  const incoming = normalizeText(candidate.content);
  const similarity = matchSimilarity(candidate, match);
  const tokenAction = tokenDecision(candidate.content, match.content);
  if (incoming === existing) {
    return { action: 'ignore', reason: `Duplicate memory detected. similarity=${similarity.toFixed(3)}` };
  }
  if (tokenAction === 'ignore') {
    return { action: 'ignore', reason: `Candidate tokens already covered by existing memory. similarity=${similarity.toFixed(3)}` };
  }
  if (tokenAction === 'merge') {
    return { action: 'merge', reason: `Candidate adds tokens to existing memory. similarity=${similarity.toFixed(3)}` };
  }
  if (incoming.includes(existing) && incoming.length > existing.length) {
    return { action: 'merge', reason: `Candidate extends existing memory. similarity=${similarity.toFixed(3)}` };
  }
  if (existing.includes(incoming)) {
    return { action: 'ignore', reason: `Candidate already covered by existing memory. similarity=${similarity.toFixed(3)}` };
  }
  if (similarity >= 0.95) {
    return { action: 'ignore', reason: `Duplicate memory detected. similarity=${similarity.toFixed(3)}` };
  }
  if (similarity >= 0.6) {
    return { action: 'merge', reason: `Similar memory should be merged. similarity=${similarity.toFixed(3)}` };
  }
  return { action: 'add', reason: `Similarity below threshold. similarity=${similarity.toFixed(3)}` };
}

function mergeContent(existing: string, candidate: string): string {
  if (normalizeText(existing).includes(normalizeText(candidate))) return existing;
  if (normalizeText(candidate).includes(normalizeText(existing))) return candidate;
  return `${existing}\n${candidate}`;
}

async function llmDecision(env: Env, candidate: ProcessMemoryCandidateInput, match?: SearchResult): Promise<{ action: CandidateAction; reason: string } | null> {
  if (!env.AI || !env.MEMORY_LLM_MODEL || !match) return null;
  try {
    const response = await env.AI.run(env.MEMORY_LLM_MODEL, {
      messages: [
        {
          role: 'system',
          content: 'Decide whether a memory candidate should be added, merged into an existing memory, or ignored as duplicate. Ignore when the candidate is the same durable fact/preference/rule, a paraphrase, translation, or subset of the existing memory. Merge only when the candidate adds genuinely new future-useful detail to the same memory. If they merely share project names or broad terms but describe different facts, choose add. Return strict JSON: {"action":"add|merge|ignore","reason":"short reason"}.',
        },
        {
          role: 'user',
          content: JSON.stringify({ candidate: candidate.content, existing_memory: match.content }),
        },
      ],
    });
    const raw = typeof response === 'string' ? response : (response as any)?.response ?? (response as any)?.result?.response ?? '';
    const parsed = JSON.parse(String(raw).match(/\{[\s\S]*\}/)?.[0] ?? '{}') as { action?: CandidateAction; reason?: string };
    if (parsed.action === 'add' || parsed.action === 'merge' || parsed.action === 'ignore') {
      return { action: parsed.action, reason: parsed.reason ?? 'LLM decision.' };
    }
  } catch (error) {
    await writeMemoryEvent(env, {
      userId: candidate.user_id,
      eventType: 'llm_dedup_failed',
      payload: { message: error instanceof Error ? error.message : String(error) },
    });
  }
  return null;
}

async function findLexicalMatch(env: Env, candidate: ProcessMemoryCandidateInput): Promise<SearchResult | undefined> {
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
      best = { ...row, similarity, score: similarity };
    }
  }
  return best && best.similarity >= 0.5 ? best : undefined;
}

function bestUsableMatch(candidate: ProcessMemoryCandidateInput, matches: Array<SearchResult | undefined>): SearchResult | undefined {
  let best: SearchResult | undefined;
  for (const match of matches) {
    const usable = usableMatch(candidate, match);
    if (!usable) continue;
    if (!best || matchSimilarity(candidate, usable) > matchSimilarity(candidate, best)) best = usable;
  }
  return best;
}

function chooseDecision(candidate: ProcessMemoryCandidateInput, match: SearchResult | undefined, llm: { action: CandidateAction; reason: string } | null): { action: CandidateAction; reason: string } {
  const heuristic = heuristicDecision(candidate, match);
  if (!match || !llm) return heuristic;

  const existing = normalizeText(match.content);
  const incoming = normalizeText(candidate.content);
  const deterministic = incoming === existing || incoming.includes(existing) || existing.includes(incoming) || tokenDecision(candidate.content, match.content) !== null || matchSimilarity(candidate, match) >= 0.95;
  if (deterministic) return heuristic;

  return llm;
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
