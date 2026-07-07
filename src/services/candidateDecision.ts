import type { CreateMemoryInput, SearchResult } from '../types';

export type CandidateAction = 'add' | 'merge' | 'update' | 'delete' | 'ignore';

export interface ProcessMemoryCandidateInput extends Required<Pick<CreateMemoryInput, 'content' | 'user_id' | 'scope' | 'kind' | 'importance' | 'confidence'>> {
  project_id?: string | null;
  session_id?: string | null;
  source?: string | null;
  expires_at?: string | null;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[\s，。,.!！?？:：;；"'“”‘’（）()【】\[\]{}]/g, '');
}

// Word-level tokens for ASCII runs (so "npm" and "pnpm" don't count as near-identical just
// because they share letters), single-character tokens for CJK (no whitespace word boundaries
// to split on, so per-character bag-of-characters is the practical choice there).
function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+|[一-鿿㐀-䶿]/g) ?? [];
}

export function lexicalSimilarity(a: string, b: string): number {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
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

// Prompt-level "at most N" instructions are not reliably followed by an 8B model, so this is
// the hard backstop for extractMemoryCandidates(): when the model over-produces, keep only the
// highest-importance candidates instead of writing every one of them (the actual source of
// "4 candidates, 4 added" bloat).
export const MAX_CANDIDATES_PER_EXTRACTION = 2;

export function capCandidates<T extends { importance: number }>(candidates: T[], max: number = MAX_CANDIDATES_PER_EXTRACTION): T[] {
  if (candidates.length <= max) return candidates;
  return [...candidates].sort((a, b) => b.importance - a.importance).slice(0, max);
}

// Matches the lexical-similarity cutoff used against the DB below, so "similar enough to be
// the same fact" means the same thing whether the comparison is against an existing memory or
// a sibling candidate in the same extraction batch.
const BATCH_DEDUP_SIMILARITY_THRESHOLD = 0.5;

// Auto-extracted candidates below this importance, or scoped globally, skip straight-to-`add`
// and go to the memory_reviews queue instead — matches the standing preference to not
// auto-trust low-confidence or global rule/preference candidates. Initial default; recalibrate
// with an eval once enough auto-extract history exists.
export const AUTO_ADD_MIN_IMPORTANCE = 0.6;

// Candidates within one extraction response are never compared to each other, only to the
// existing DB — so several near-duplicate candidates from the same batch each independently
// miss finding a DB match and all get `add`ed. Merge lookalikes within the batch first.
export function dedupeCandidateBatch(candidates: ProcessMemoryCandidateInput[]): ProcessMemoryCandidateInput[] {
  const kept: ProcessMemoryCandidateInput[] = [];
  for (const candidate of candidates) {
    const match = kept.find((item) => item.scope === candidate.scope && lexicalSimilarity(item.content, candidate.content) >= BATCH_DEDUP_SIMILARITY_THRESHOLD);
    if (!match) {
      kept.push(candidate);
      continue;
    }
    match.content = mergeContent(match.content, candidate.content);
    match.importance = Math.max(match.importance, candidate.importance);
    match.confidence = Math.max(match.confidence, candidate.confidence);
  }
  return kept;
}

export function isAutoAddEligible(candidate: ProcessMemoryCandidateInput): boolean {
  return candidate.scope !== 'global' && candidate.importance >= AUTO_ADD_MIN_IMPORTANCE;
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

// Deliberately excludes a bare "not" — it matches too much plain negation ("this is not a bug")
// that isn't actually superseding anything, and would send routine candidates to the LLM.
const CONTRADICTION_SIGNALS = /\b(instead of|instead|no longer|rather than|switch(?:ed|ing)?\s+to|replace[sd]?|change[sd]?\s+to|revert(?:ed)?\s+to|versus|vs\.?)\b/i;

function hasContradictionSignal(text: string): boolean {
  return CONTRADICTION_SIGNALS.test(text);
}

const FORGET_SIGNALS = /\b(forget (that|about|it)|disregard|retract(?:ed)?|never\s?mind|delete (that|this)|remove (that|this)|scratch that|that('s| is) (not|no longer) (true|valid|correct))\b/i;

function hasForgetSignal(text: string): boolean {
  return FORGET_SIGNALS.test(text);
}

export function chooseDecision(candidate: ProcessMemoryCandidateInput, match: SearchResult | undefined, llm: { action: CandidateAction; reason: string } | null): { action: CandidateAction; reason: string } {
  const heuristic = heuristicDecision(candidate, match);
  if (!match || !llm) return heuristic;

  const existing = normalizeText(match.content);
  const incoming = normalizeText(candidate.content);
  if (incoming === existing) return heuristic;

  // Substring/token-superset/char-similarity heuristics all assume "candidate extends existing"
  // without contradicting it. Phrasing like "X instead of Y" or "switched to X" defeats that
  // assumption (it's a superset of characters/tokens while actually superseding the old fact) —
  // defer those to the LLM, which can tell "update" apart from "merge", instead of auto-merging.
  // "Forget/retract" phrasing is the same story but for deletion — never auto-merge those either.
  if (hasContradictionSignal(candidate.content) || hasForgetSignal(candidate.content)) return llm;

  const deterministic = incoming.includes(existing) || existing.includes(incoming) || tokenDecision(candidate.content, match.content) !== null || matchSimilarity(candidate, match) >= 0.95;
  return deterministic ? heuristic : llm;
}
