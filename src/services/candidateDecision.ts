import type { CandidateAntecedentSource, CandidateEvidenceFields, CandidateSignal, CandidateSignalSubtype, CreateMemoryInput, MemoryKind, SearchResult } from '../types';

export type CandidateAction = 'add' | 'merge' | 'update' | 'delete' | 'ignore';

export interface ProcessMemoryCandidateInput extends Required<Pick<CreateMemoryInput, 'content' | 'user_id' | 'scope' | 'kind' | 'importance' | 'confidence'>>, CandidateEvidenceFields {
  project_id?: string | null;
  session_id?: string | null;
  source?: string | null;
}

// Corrections outrank everything else, and every non-correction signal is demoted to 0.4 so a
// correction cannot be crowded out by routine candidates queued in the same window.
const CORRECTION_SUBTYPE_IMPORTANCE: Record<CandidateSignalSubtype, number> = {
  explicit_negation: 0.9,
  override_of_action: 0.9,
  repeat_complaint: 0.9,
  terse_redirect: 0.8,
  futility_verdict: 0.8,
  approval_after_change: 0.7,
};
const CORRECTION_DEFAULT_IMPORTANCE = 0.8;
const NON_CORRECTION_IMPORTANCE = 0.4;

// `null` means "no derivation" — a representable state, distinct from any number, so the caller
// can fall back to today's default (0.5) without a signal-less candidate ever being re-priced.
// `kind` is part of the contract signature (it selects the intended kind per signal) but does not
// change the number today; keep it so a kind-sensitive tuning stays a body-only change.
export function importanceForSignal(
  signal: CandidateSignal | undefined,
  signalSubtype: CandidateSignalSubtype | '' | undefined,
  kind: MemoryKind,
): number | null {
  if (signal === 'correction') {
    if (signalSubtype && signalSubtype in CORRECTION_SUBTYPE_IMPORTANCE) return CORRECTION_SUBTYPE_IMPORTANCE[signalSubtype];
    return CORRECTION_DEFAULT_IMPORTANCE;
  }
  if (signal === 'preference' || signal === 'outcome') return NON_CORRECTION_IMPORTANCE;
  return null;
}

// A rule inferred from a lossy 120-char tool trace must not land at confidence 1.0 and then
// overwrite a human-set confidence on the memory it supersedes. `null` = no derivation, so every
// existing caller (which sends no antecedent_source) keeps today's default of 1.
export function confidenceForAntecedent(source: CandidateAntecedentSource | undefined): number | null {
  switch (source) {
    case 'prose':
      return 0.85;
    case 'candidate':
      return 0.75;
    case 'trace':
      return 0.7;
    case 'prior_tail':
      return 0.65;
    default:
      return null;
  }
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

export function matchSimilarity(candidate: ProcessMemoryCandidateInput, match: SearchResult): number {
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
// the same fact" means the same thing whether the comparison is against an existing memory, a
// sibling candidate in the same extraction batch, or (via reviews.ts) an existing pending review.
export const BATCH_DEDUP_SIMILARITY_THRESHOLD = 0.5;

// Capture-time near-duplicate parking (2026-08-05 memory audit: 57 pending reviews resolved, 48 of
// them ignored). One recurring noise class was a candidate restating a rule that is ALREADY active
// but not word-for-word, so none of heuristicDecision()'s deterministic `ignore` rules fire and the
// row lands in the pending queue like a fresh fact. The display-time hints on that queue put a true
// duplicate at similarity 0.824 and an unrelated pair at 0.138 — a wide, empty gap. 0.8 sits just
// under the observed duplicate and far above the observed non-duplicate; the existing `ignore` band
// (>= 0.95, plus the substring/token-superset rules) is untouched and still decides first.
export const NEAR_DUPLICATE_PARK_THRESHOLD = 0.8;

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

// Unsupervised background classifiers (no human/agent judgment in the loop before the write —
// Pi's agent_end classifier, Claude Code's Stop-hook classifier) must never auto-add, merge,
// update, or delete an active memory directly: their candidates always go to the review queue,
// regardless of scope/importance. KEEP IN SYNC with the source strings used in
// integrations/pi/asaki-memory.ts (writeClassifiedMemory) and
// integrations/claude-code/stop-extract.sh (the classifier write branch).
const UNSUPERVISED_CANDIDATE_SOURCES = new Set(['pi:agent-end-classifier', 'claude-code:stop-classifier']);

export function isUnsupervisedSource(source: string | null | undefined): boolean {
  return typeof source === 'string' && UNSUPERVISED_CANDIDATE_SOURCES.has(source);
}

// Plural sibling of bestUsableMatch(): same usableMatch() gate (normalized equality, token
// decision, lexical/semantic >= 0.5), same matchSimilarity() score, ordered best-first. The
// supersession lookup needs the top few candidates rather than the single best one, and both
// callers must agree on what "usable" means — hence one implementation, not two.
export function usableMatches(
  candidate: ProcessMemoryCandidateInput,
  matches: Array<SearchResult | undefined>,
): Array<{ match: SearchResult; score: number }> {
  const out: Array<{ match: SearchResult; score: number }> = [];
  for (const match of matches) {
    const usable = usableMatch(candidate, match);
    if (!usable) continue;
    out.push({ match: usable, score: matchSimilarity(candidate, usable) });
  }
  // Array.prototype.sort is stable, so equal scores keep input order.
  out.sort((a, b) => b.score - a.score);
  return out;
}

export function bestUsableMatch(candidate: ProcessMemoryCandidateInput, matches: Array<SearchResult | undefined>): SearchResult | undefined {
  return usableMatches(candidate, matches)[0]?.match;
}

// Deliberately excludes a bare "not" — it matches too much plain negation ("this is not a bug")
// that isn't actually superseding anything, and would send routine candidates to the LLM.
const CONTRADICTION_SIGNALS = /\b(instead of|instead|no longer|rather than|switch(?:ed|ing)?\s+to|replace[sd]?|change[sd]?\s+to|revert(?:ed)?\s+to|versus|vs\.?)\b/i;

// CJK has no word boundaries, so these can't ride in the \b-anchored pattern above. Same care as
// the English side: no bare 不 / 不要 (plain negation is not supersession — "这不是 bug" must not
// route to the LLM), only phrasings that assert a replacement of an earlier state. 不用…了 is
// bounded to one clause so it can't span a whole paragraph.
const CONTRADICTION_SIGNALS_CJK = /(改回|还是原来的|换成|别再|不要再|不用[^。！？!?\n]{0,20}了)/;

export function hasContradictionSignal(text: string): boolean {
  return CONTRADICTION_SIGNALS.test(text) || CONTRADICTION_SIGNALS_CJK.test(text);
}

const FORGET_SIGNALS = /\b(forget (that|about|it)|disregard|retract(?:ed)?|never\s?mind|delete (that|this)|remove (that|this)|scratch that|that('s| is) (not|no longer) (true|valid|correct))\b/i;

const FORGET_SIGNALS_CJK = /(去掉|之前那条不算了|撤销|作废)/;

export function hasForgetSignal(text: string): boolean {
  return FORGET_SIGNALS.test(text) || FORGET_SIGNALS_CJK.test(text);
}

// Whether chooseDecision() would actually use an LLM decision if given one — callers use this to
// skip the LLM call entirely when the deterministic heuristic already has the answer, instead of
// paying for a decision that would just be discarded.
export function needsLlmDecision(candidate: ProcessMemoryCandidateInput, match?: SearchResult): boolean {
  if (!match) return false;

  const existing = normalizeText(match.content);
  const incoming = normalizeText(candidate.content);
  if (incoming === existing) return false;

  // Substring/token-superset/char-similarity heuristics all assume "candidate extends existing"
  // without contradicting it. Phrasing like "X instead of Y" or "switched to X" defeats that
  // assumption (it's a superset of characters/tokens while actually superseding the old fact) —
  // defer those to the LLM, which can tell "update" apart from "merge", instead of auto-merging.
  // "Forget/retract" phrasing is the same story but for deletion — never auto-merge those either.
  if (hasContradictionSignal(candidate.content) || hasForgetSignal(candidate.content)) return true;

  const deterministic = incoming.includes(existing) || existing.includes(incoming) || tokenDecision(candidate.content, match.content) !== null || matchSimilarity(candidate, match) >= 0.95;
  return !deterministic;
}

export function chooseDecision(candidate: ProcessMemoryCandidateInput, match: SearchResult | undefined, llm: { action: CandidateAction; reason: string } | null): { action: CandidateAction; reason: string } {
  const heuristic = heuristicDecision(candidate, match);
  if (!match || !llm) return heuristic;
  return needsLlmDecision(candidate, match) ? llm : heuristic;
}
