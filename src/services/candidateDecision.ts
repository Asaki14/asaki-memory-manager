import type { CreateMemoryInput, SearchResult } from '../types';

export type CandidateAction = 'add' | 'merge' | 'ignore';

export interface ProcessMemoryCandidateInput extends Required<Pick<CreateMemoryInput, 'content' | 'user_id' | 'scope' | 'kind' | 'importance' | 'confidence'>> {
  project_id?: string | null;
  session_id?: string | null;
  source?: string | null;
  expires_at?: string | null;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[\s，。,.!！?？:：;；"'“”‘’（）()【】\[\]{}]/g, '');
}

export function lexicalSimilarity(a: string, b: string): number {
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

export function heuristicDecision(candidate: ProcessMemoryCandidateInput, match?: SearchResult): { action: CandidateAction; reason: string } {
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
  return { action: 'add', reason: `No deterministic duplicate or extension. similarity=${similarity.toFixed(3)}` };
}

export function mergeContent(existing: string, candidate: string): string {
  if (normalizeText(existing).includes(normalizeText(candidate))) return existing;
  if (normalizeText(candidate).includes(normalizeText(existing))) return candidate;
  return `${existing}\n${candidate}`;
}

export function bestUsableMatch(candidate: ProcessMemoryCandidateInput, matches: Array<SearchResult | undefined>): SearchResult | undefined {
  let best: SearchResult | undefined;
  for (const match of matches) {
    const usable = usableMatch(candidate, match);
    if (!usable) continue;
    if (!best || matchSimilarity(candidate, usable) > matchSimilarity(candidate, best)) best = usable;
  }
  return best;
}

export function chooseDecision(candidate: ProcessMemoryCandidateInput, match: SearchResult | undefined, llm: { action: CandidateAction; reason: string } | null): { action: CandidateAction; reason: string } {
  const heuristic = heuristicDecision(candidate, match);
  if (!match || !llm) return heuristic;

  const existing = normalizeText(match.content);
  const incoming = normalizeText(candidate.content);
  const deterministic = incoming === existing || incoming.includes(existing) || existing.includes(incoming) || tokenDecision(candidate.content, match.content) !== null || matchSimilarity(candidate, match) >= 0.95;
  if (deterministic) return heuristic;

  return llm;
}
