export type MemoryScope = 'global' | 'project' | 'session';
export type MemoryKind = 'preference' | 'rule' | 'fact' | 'decision' | 'task_learning' | 'bug_fix' | 'workflow';
export type MemoryStatus = 'active' | 'archived' | 'deleted';
export type IndexStatus = 'indexed' | 'pending' | 'failed';
export type MemoryReviewStatus = 'pending' | 'resolved';

export interface Env {
  DB: D1Database;
  VECTORIZE?: VectorizeIndex;
  AI?: Ai;
  EMBEDDING_MODEL?: string;
  MEMORY_LLM_MODEL?: string;
  ADMIN_API_KEY?: string;
  RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

export type CandidateSignal = 'correction' | 'preference' | 'outcome' | 'none';
export type CandidateSignalSubtype =
  | 'explicit_negation'
  | 'override_of_action'
  | 'terse_redirect'
  | 'repeat_complaint'
  | 'approval_after_change'
  | 'futility_verdict';
export type CandidateRuleForm = 'prohibition' | 'preference' | 'procedure' | 'retract';
export type CandidateAntecedentSource = 'prose' | 'trace' | 'prior_tail' | 'candidate' | 'none';

export interface CandidateCorrectionEvidence {
  agent_did: string;
  captain_verdict: string;
  redirect_target: string;
}

// Correction-classifier evidence carried alongside a candidate. None of these are columns on
// `memories` (createMemory binds explicit columns), so they survive only inside
// memory_reviews.candidate_json — which is free-form TEXT, hence no migration.
// `supersedes_pending_review_id` is written server-side when a correction refuses to merge into a
// non-correction pending review; `project_context` is a scope-neutral client hint that must never
// be used for scope validation, visibility, or the memory_reviews.project_id column.
export interface CandidateEvidenceFields {
  signal?: CandidateSignal;
  signal_subtype?: CandidateSignalSubtype | '';
  rule_form?: CandidateRuleForm;
  antecedent_source?: CandidateAntecedentSource;
  correction?: CandidateCorrectionEvidence;
  supersedes_query?: string | null;
  supersedes_pending_review_id?: string | null;
  project_context?: string | null;
}

export interface CreateMemoryInput extends CandidateEvidenceFields {
  content: string;
  user_id: string;
  scope?: MemoryScope;
  project_id?: string | null;
  session_id?: string | null;
  kind?: MemoryKind;
  importance?: number;
  confidence?: number;
  source?: string | null;
}

export interface ExtractMemoriesInput {
  text: string;
  user_id: string;
  scope?: MemoryScope;
  project_id?: string | null;
  session_id?: string | null;
  source?: string | null;
  dry_run?: boolean;
}

export interface SearchMemoriesInput {
  query: string;
  user_id: string;
  scope?: MemoryScope;
  project_id?: string | null;
  session_id?: string | null;
  top_k?: number;
  min_score?: number;
  // Internal-only (never read off a request body: validateSearchMemories returns an explicit
  // whitelist). `false` means "this search is a suggestion lookup, not a retrieval" — it skips the
  // last_accessed_at write so merely proposing a memory as a dedup/supersession target doesn't
  // make it look recently used to pruneStaleMemories().
  track_access?: boolean;
}

export interface ListMemoriesInput {
  user_id: string;
  scope?: MemoryScope;
  project_id?: string | null;
  session_id?: string | null;
  kind?: MemoryKind;
  status?: MemoryStatus | 'all';
  source?: string | null;
  limit?: number;
  offset?: number;
}

export interface GetMemoriesInput {
  user_id: string;
  ids: string[];
  // Internal-only, same contract as SearchMemoriesInput.track_access: a read by id IS a retrieval,
  // so it refreshes last_accessed_at by default (captain decision a, 2026-08-28). Never read off a
  // request body — validateGetMemories returns an explicit whitelist.
  track_access?: boolean;
}

export interface ListMemoryProjectsInput {
  user_id: string;
  limit?: number;
  offset?: number;
}

export interface MemoryProjectRow {
  project_id: string;
  memory_count: number;
  active_memory_count: number;
  pending_review_count: number;
}

export interface UpdateMemoryInput {
  user_id: string;
  content?: string;
  scope?: MemoryScope;
  project_id?: string | null;
  session_id?: string | null;
  kind?: MemoryKind;
  importance?: number;
  confidence?: number;
  status?: MemoryStatus;
  source?: string | null;
}

export interface MemoryIdInput {
  user_id: string;
}

// Lifecycle metadata persisted in memories.metadata_json (migration 0006). Kept as the raw JSON
// string on MemoryRow — every read path is a `SELECT *` into MemoryRow, so parsing at the row level
// would mean touching all of them; callers that need the object use parseMemoryMetadata().
export interface MemoryReinforcement {
  count: number;
  last_reinforced_at: string;
  last_signal_subtype?: CandidateSignalSubtype | '' | null;
  last_source?: string | null;
}

// Compressed correction provenance written when a correction review is resolved into an active
// memory (captain decision 9): each quote is capped at 120 chars so the memory carries its origin
// after the review row stops being consulted, without becoming a transcript.
export interface MemoryCorrectionOrigin {
  agent_did: string;
  captain_verdict: string;
  signal_subtype?: CandidateSignalSubtype | '' | null;
  antecedent_source?: CandidateAntecedentSource | null;
  review_id: string;
  recorded_at: string;
}

export interface MemoryMetadata {
  reinforcement?: MemoryReinforcement;
  correction_origin?: MemoryCorrectionOrigin;
}

export interface MemoryRow {
  id: string;
  user_id: string;
  scope: MemoryScope;
  project_id: string | null;
  session_id: string | null;
  content: string;
  kind: MemoryKind;
  importance: number;
  confidence: number;
  status: MemoryStatus;
  source: string | null;
  index_status: IndexStatus;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  metadata_json?: string | null;
}

export interface SearchScoreDetails {
  semantic: number;
  keyword: number;
  entity: number;
  metadata: number;
  source: 'vector' | 'keyword';
}

export interface SearchResult extends MemoryRow {
  similarity: number;
  score: number;
  score_details: SearchScoreDetails;
}

export interface MemoryReviewRecord {
  id: string;
  user_id: string;
  status: MemoryReviewStatus;
  candidate_json: string;
  resolved_action: 'add' | 'merge' | 'update' | 'delete' | 'ignore' | null;
  memory_id: string | null;
  project_id: string | null;
  session_id: string | null;
  source: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface MemoryReviewRow extends Omit<MemoryReviewRecord, 'candidate_json'> {
  candidate: import('./services/candidateDecision').ProcessMemoryCandidateInput;
  potential_duplicate?: {
    memory_id: string;
    content: string;
    action: import('./services/candidateDecision').CandidateAction;
    reason: string;
  } | null;
  // Display-time only (no column, no migration): active memories this correction candidate looks
  // like it invalidates. `null` means "eligible but not computed" — the per-response cap was hit.
  supersedes_candidates?: Array<{
    memory_id: string;
    content: string;
    score: number;
    target_scope: MemoryScope;
    target_kind: MemoryKind;
    target_confidence: number;
    suggested_action: 'update' | 'delete';
  }> | null;
  // Display-time only (no column, no migration): the same rule already exists as a project-scoped
  // rule/preference in a DIFFERENT project, so this project correction is probably a global rule
  // (captain decision 8). A suggestion only — resolving with `promote_to_global` is the human's
  // call. `null` means "eligible but not computed" (per-response cap hit), same as above.
  promotion_candidates?: Array<{
    memory_id: string;
    content: string;
    score: number;
    target_project_id: string | null;
    target_kind: MemoryKind;
    suggested_action: 'promote_to_global';
  }> | null;
}
