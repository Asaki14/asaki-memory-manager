import type { CreateMemoryInput, ExtractMemoriesInput, ListMemoriesInput, MemoryIdInput, MemoryKind, MemoryScope, MemoryStatus, SearchMemoriesInput, UpdateMemoryInput } from '../types';

const scopes = new Set<MemoryScope>(['global', 'project', 'session']);
const kinds = new Set<MemoryKind>(['preference', 'rule', 'fact', 'decision', 'task_learning', 'bug_fix', 'workflow']);
const statuses = new Set<MemoryStatus>(['active', 'archived', 'deleted']);
const reviewStatuses = new Set(['pending', 'resolved']);
const reviewActions = new Set(['add', 'merge', 'ignore']);

function validateUserId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function validateScopeIds(input: { scope?: MemoryScope; project_id?: string | null; session_id?: string | null }): string | null {
  if (input.scope === 'project' && !input.project_id) return 'project_id is required when scope is project.';
  if (input.scope === 'session' && !input.session_id) return 'session_id is required when scope is session.';
  return null;
}

export function validateCreateMemory(value: unknown): { ok: true; data: Required<Pick<CreateMemoryInput, 'content' | 'user_id' | 'scope' | 'kind' | 'importance' | 'confidence'>> & Omit<CreateMemoryInput, 'content' | 'user_id' | 'scope' | 'kind' | 'importance' | 'confidence'> } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Body must be a JSON object.' };
  const input = value as CreateMemoryInput;
  if (typeof input.content !== 'string' || input.content.trim().length === 0) return { ok: false, error: 'content is required.' };
  if (input.content.length > 8000) return { ok: false, error: 'content must be <= 8000 characters.' };
  if (typeof input.user_id !== 'string' || input.user_id.trim().length === 0) return { ok: false, error: 'user_id is required.' };

  const scope = input.scope ?? 'global';
  if (!scopes.has(scope)) return { ok: false, error: 'scope must be global, project, or session.' };
  if (scope === 'project' && !input.project_id) return { ok: false, error: 'project_id is required when scope is project.' };
  if (scope === 'session' && !input.session_id) return { ok: false, error: 'session_id is required when scope is session.' };

  const kind = input.kind ?? 'fact';
  if (!kinds.has(kind)) return { ok: false, error: 'kind is invalid.' };

  const importance = input.importance ?? 0.5;
  if (typeof importance !== 'number' || importance < 0 || importance > 1) return { ok: false, error: 'importance must be between 0 and 1.' };

  const confidence = input.confidence ?? 1;
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) return { ok: false, error: 'confidence must be between 0 and 1.' };

  return {
    ok: true,
    data: {
      content: input.content.trim(),
      user_id: input.user_id.trim(),
      scope,
      project_id: input.project_id ?? null,
      session_id: input.session_id ?? null,
      kind,
      importance,
      confidence,
      source: input.source ?? null,
      expires_at: input.expires_at ?? null,
    },
  };
}

export function validateSearchMemories(value: unknown): { ok: true; data: Required<Pick<SearchMemoriesInput, 'query' | 'user_id' | 'top_k'>> & Omit<SearchMemoriesInput, 'query' | 'user_id' | 'top_k'> } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Body must be a JSON object.' };
  const input = value as SearchMemoriesInput;
  if (typeof input.query !== 'string' || input.query.trim().length === 0) return { ok: false, error: 'query is required.' };
  if (typeof input.user_id !== 'string' || input.user_id.trim().length === 0) return { ok: false, error: 'user_id is required.' };
  const topK = input.top_k ?? 10;
  if (!Number.isInteger(topK) || topK < 1 || topK > 50) return { ok: false, error: 'top_k must be an integer between 1 and 50.' };
  if (input.scope && !scopes.has(input.scope)) return { ok: false, error: 'scope must be global, project, or session.' };
  if (input.scope === 'project' && !input.project_id) return { ok: false, error: 'project_id is required when scope is project.' };
  if (input.scope === 'session' && !input.session_id) return { ok: false, error: 'session_id is required when scope is session.' };
  if (input.min_score !== undefined && (typeof input.min_score !== 'number' || input.min_score < 0 || input.min_score > 1)) {
    return { ok: false, error: 'min_score must be a number between 0 and 1.' };
  }

  return {
    ok: true,
    data: {
      query: input.query.trim(),
      user_id: input.user_id.trim(),
      scope: input.scope,
      project_id: input.project_id ?? null,
      session_id: input.session_id ?? null,
      top_k: topK,
      min_score: input.min_score,
    },
  };
}

export function validateListMemories(value: unknown): { ok: true; data: Required<Pick<ListMemoriesInput, 'user_id' | 'status' | 'limit' | 'offset'>> & Omit<ListMemoriesInput, 'user_id' | 'status' | 'limit' | 'offset'> } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Body must be a JSON object.' };
  const input = value as ListMemoriesInput;
  const userId = validateUserId(input.user_id);
  if (!userId) return { ok: false, error: 'user_id is required.' };
  if (input.scope && !scopes.has(input.scope)) return { ok: false, error: 'scope must be global, project, or session.' };
  const scopeError = validateScopeIds(input);
  if (scopeError) return { ok: false, error: scopeError };
  if (input.kind && !kinds.has(input.kind)) return { ok: false, error: 'kind is invalid.' };
  const status = input.status ?? 'active';
  if (status !== 'all' && !statuses.has(status)) return { ok: false, error: 'status must be active, archived, deleted, or all.' };
  if (input.source != null && (typeof input.source !== 'string' || input.source.trim().length === 0)) return { ok: false, error: 'source must be a non-empty string when provided.' };
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { ok: false, error: 'limit must be an integer between 1 and 100.' };
  const offset = input.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) return { ok: false, error: 'offset must be a non-negative integer.' };

  return {
    ok: true,
    data: {
      user_id: userId,
      scope: input.scope,
      project_id: input.project_id ?? null,
      session_id: input.session_id ?? null,
      kind: input.kind,
      status,
      source: input.source?.trim() ?? null,
      limit,
      offset,
    },
  };
}

export function validateMemoryIdInput(value: unknown): { ok: true; data: MemoryIdInput } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Body must be a JSON object.' };
  const input = value as MemoryIdInput;
  const userId = validateUserId(input.user_id);
  if (!userId) return { ok: false, error: 'user_id is required.' };
  return { ok: true, data: { user_id: userId } };
}

export function validateUpdateMemory(value: unknown): { ok: true; data: UpdateMemoryInput } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Body must be a JSON object.' };
  const input = value as UpdateMemoryInput;
  const userId = validateUserId(input.user_id);
  if (!userId) return { ok: false, error: 'user_id is required.' };

  const data: UpdateMemoryInput = { user_id: userId };
  if (input.content !== undefined) {
    if (typeof input.content !== 'string' || input.content.trim().length === 0) return { ok: false, error: 'content must be a non-empty string when provided.' };
    if (input.content.length > 8000) return { ok: false, error: 'content must be <= 8000 characters.' };
    data.content = input.content.trim();
  }
  if (input.scope !== undefined) {
    if (!scopes.has(input.scope)) return { ok: false, error: 'scope must be global, project, or session.' };
    data.scope = input.scope;
  }
  if (input.project_id !== undefined) data.project_id = input.project_id;
  if (input.session_id !== undefined) data.session_id = input.session_id;
  const scopeError = validateScopeIds({ scope: data.scope, project_id: data.project_id ?? input.project_id, session_id: data.session_id ?? input.session_id });
  if (scopeError) return { ok: false, error: scopeError };
  if (input.kind !== undefined) {
    if (!kinds.has(input.kind)) return { ok: false, error: 'kind is invalid.' };
    data.kind = input.kind;
  }
  if (input.importance !== undefined) {
    if (typeof input.importance !== 'number' || input.importance < 0 || input.importance > 1) return { ok: false, error: 'importance must be between 0 and 1.' };
    data.importance = input.importance;
  }
  if (input.confidence !== undefined) {
    if (typeof input.confidence !== 'number' || input.confidence < 0 || input.confidence > 1) return { ok: false, error: 'confidence must be between 0 and 1.' };
    data.confidence = input.confidence;
  }
  if (input.status !== undefined) {
    if (!statuses.has(input.status)) return { ok: false, error: 'status must be active, archived, or deleted.' };
    data.status = input.status;
  }
  if (input.source !== undefined) {
    if (input.source !== null && (typeof input.source !== 'string' || input.source.trim().length === 0)) return { ok: false, error: 'source must be a non-empty string when provided.' };
    data.source = input.source?.trim() ?? null;
  }
  if (input.expires_at !== undefined) {
    if (input.expires_at !== null && (typeof input.expires_at !== 'string' || input.expires_at.trim().length === 0)) return { ok: false, error: 'expires_at must be a non-empty string when provided.' };
    data.expires_at = input.expires_at?.trim() ?? null;
  }
  if (Object.keys(data).length === 1) return { ok: false, error: 'At least one update field is required.' };

  return { ok: true, data };
}

export function validateExtractMemories(value: unknown): { ok: true; data: ExtractMemoriesInput } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Body must be a JSON object.' };
  const input = value as ExtractMemoriesInput;
  if (typeof input.text !== 'string' || input.text.trim().length === 0) return { ok: false, error: 'text is required.' };
  if (input.text.length > 20000) return { ok: false, error: 'text must be <= 20000 characters.' };
  const userId = validateUserId(input.user_id);
  if (!userId) return { ok: false, error: 'user_id is required.' };
  if (input.scope && !scopes.has(input.scope)) return { ok: false, error: 'scope must be global, project, or session.' };
  const scopeError = validateScopeIds(input);
  if (scopeError) return { ok: false, error: scopeError };
  if (input.source != null && (typeof input.source !== 'string' || input.source.trim().length === 0)) return { ok: false, error: 'source must be a non-empty string when provided.' };
  if (input.dry_run !== undefined && typeof input.dry_run !== 'boolean') return { ok: false, error: 'dry_run must be a boolean.' };

  return {
    ok: true,
    data: {
      text: input.text.trim(),
      user_id: userId,
      scope: input.scope,
      project_id: input.project_id ?? null,
      session_id: input.session_id ?? null,
      source: input.source?.trim() ?? null,
      dry_run: input.dry_run ?? false,
    },
  };
}

export function validateProcessCandidates(value: unknown): { ok: true; data: Array<Required<Pick<CreateMemoryInput, 'content' | 'user_id' | 'scope' | 'kind' | 'importance' | 'confidence'>> & Omit<CreateMemoryInput, 'content' | 'user_id' | 'scope' | 'kind' | 'importance' | 'confidence'>> } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Body must be a JSON object.' };
  const body = value as { candidates?: unknown; user_id?: unknown; project_id?: unknown; session_id?: unknown; source?: unknown };
  if (!Array.isArray(body.candidates) || body.candidates.length === 0) return { ok: false, error: 'candidates is required.' };
  if (body.candidates.length > 20) return { ok: false, error: 'candidates must contain <= 20 items.' };
  const data = [];
  for (const item of body.candidates) {
    const merged = {
      ...(item && typeof item === 'object' ? item : {}),
      user_id: (item as CreateMemoryInput)?.user_id ?? body.user_id,
      project_id: (item as CreateMemoryInput)?.project_id ?? body.project_id ?? null,
      session_id: (item as CreateMemoryInput)?.session_id ?? body.session_id ?? null,
      source: (item as CreateMemoryInput)?.source ?? body.source ?? 'candidate',
    };
    const validation = validateCreateMemory(merged);
    if (!validation.ok) return validation;
    data.push(validation.data);
  }
  return { ok: true, data };
}

export const validateCreateMemoryReviews = validateProcessCandidates;

export function validateListMemoryReviews(value: unknown): { ok: true; data: { user_id: string; status: 'pending' | 'resolved' | 'all'; project_id?: string | null; session_id?: string | null; source?: string | null; limit: number; offset: number } } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Body must be a JSON object.' };
  const input = value as { user_id?: unknown; status?: unknown; project_id?: unknown; session_id?: unknown; source?: unknown; limit?: unknown; offset?: unknown };
  const userId = validateUserId(input.user_id);
  if (!userId) return { ok: false, error: 'user_id is required.' };
  const status = input.status ?? 'pending';
  if (status !== 'all' && (typeof status !== 'string' || !reviewStatuses.has(status))) return { ok: false, error: 'status must be pending, resolved, or all.' };
  if (input.project_id != null && (typeof input.project_id !== 'string' || input.project_id.trim().length === 0)) return { ok: false, error: 'project_id must be a non-empty string when provided.' };
  if (input.session_id != null && (typeof input.session_id !== 'string' || input.session_id.trim().length === 0)) return { ok: false, error: 'session_id must be a non-empty string when provided.' };
  if (input.source != null && (typeof input.source !== 'string' || input.source.trim().length === 0)) return { ok: false, error: 'source must be a non-empty string when provided.' };
  const limit = input.limit == null ? 50 : input.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) return { ok: false, error: 'limit must be an integer between 1 and 100.' };
  const offset = input.offset == null ? 0 : input.offset;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) return { ok: false, error: 'offset must be a non-negative integer.' };
  return {
    ok: true,
    data: {
      user_id: userId,
      status: status as 'pending' | 'resolved' | 'all',
      project_id: typeof input.project_id === 'string' ? input.project_id.trim() : null,
      session_id: typeof input.session_id === 'string' ? input.session_id.trim() : null,
      source: typeof input.source === 'string' ? input.source.trim() : null,
      limit,
      offset,
    },
  };
}

export function validateResolveMemoryReview(value: unknown): { ok: true; data: { user_id: string; action: 'add' | 'merge' | 'ignore'; memory_id?: string | null; reason?: string | null } } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Body must be a JSON object.' };
  const input = value as { user_id?: unknown; action?: unknown; memory_id?: unknown; reason?: unknown };
  const userId = validateUserId(input.user_id);
  if (!userId) return { ok: false, error: 'user_id is required.' };
  if (typeof input.action !== 'string' || !reviewActions.has(input.action)) return { ok: false, error: 'action must be add, merge, or ignore.' };
  if (input.memory_id != null && (typeof input.memory_id !== 'string' || input.memory_id.trim().length === 0)) return { ok: false, error: 'memory_id must be a non-empty string when provided.' };
  if (input.reason != null && (typeof input.reason !== 'string' || input.reason.trim().length === 0)) return { ok: false, error: 'reason must be a non-empty string when provided.' };
  if (input.action === 'merge' && !input.memory_id) return { ok: false, error: 'memory_id is required when action is merge.' };
  return { ok: true, data: { user_id: userId, action: input.action as 'add' | 'merge' | 'ignore', memory_id: input.memory_id?.trim() ?? null, reason: input.reason?.trim() ?? null } };
}
