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
}
