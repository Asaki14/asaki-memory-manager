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
}

export interface CreateMemoryInput {
  content: string;
  user_id: string;
  scope?: MemoryScope;
  project_id?: string | null;
  session_id?: string | null;
  kind?: MemoryKind;
  importance?: number;
  confidence?: number;
  source?: string | null;
  expires_at?: string | null;
}

export interface SearchMemoriesInput {
  query: string;
  user_id: string;
  scope?: MemoryScope;
  project_id?: string | null;
  session_id?: string | null;
  top_k?: number;
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
  expires_at?: string | null;
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
  expires_at: string | null;
}

export interface SearchResult extends MemoryRow {
  similarity: number;
  score: number;
}

export interface MemoryReviewRecord {
  id: string;
  user_id: string;
  status: MemoryReviewStatus;
  candidate_json: string;
  resolved_action: 'add' | 'merge' | 'ignore' | null;
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
}
