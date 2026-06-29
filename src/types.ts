export type MemoryScope = 'global' | 'project' | 'session';
export type MemoryKind = 'preference' | 'rule' | 'fact' | 'decision' | 'task_learning' | 'bug_fix' | 'workflow';
export type MemoryStatus = 'active' | 'archived' | 'deleted';
export type IndexStatus = 'indexed' | 'pending' | 'failed';

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

export interface ExtractMemoriesInput {
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
  }>;
  user_id: string;
  project_id?: string | null;
  session_id?: string | null;
  source?: string | null;
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
