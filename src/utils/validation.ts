import type { CreateMemoryInput, ExtractMemoriesInput, MemoryKind, MemoryScope, SearchMemoriesInput } from '../types';

const scopes = new Set<MemoryScope>(['global', 'project', 'session']);
const kinds = new Set<MemoryKind>(['preference', 'rule', 'fact', 'decision', 'task_learning', 'bug_fix', 'workflow']);

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

  return {
    ok: true,
    data: {
      query: input.query.trim(),
      user_id: input.user_id.trim(),
      scope: input.scope,
      project_id: input.project_id ?? null,
      session_id: input.session_id ?? null,
      top_k: topK,
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

export function validateExtractMemories(value: unknown): { ok: true; data: ExtractMemoriesInput } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Body must be a JSON object.' };
  const input = value as ExtractMemoriesInput;
  if (!Array.isArray(input.messages) || input.messages.length === 0) return { ok: false, error: 'messages is required.' };
  if (input.messages.length > 100) return { ok: false, error: 'messages must contain <= 100 items.' };
  if (typeof input.user_id !== 'string' || input.user_id.trim().length === 0) return { ok: false, error: 'user_id is required.' };
  if (input.project_id != null && (typeof input.project_id !== 'string' || input.project_id.trim().length === 0)) return { ok: false, error: 'project_id must be a non-empty string when provided.' };
  if (input.session_id != null && (typeof input.session_id !== 'string' || input.session_id.trim().length === 0)) return { ok: false, error: 'session_id must be a non-empty string when provided.' };
  if (input.source != null && (typeof input.source !== 'string' || input.source.trim().length === 0)) return { ok: false, error: 'source must be a non-empty string when provided.' };

  const messages = [];
  for (const message of input.messages) {
    if (!message || typeof message !== 'object') return { ok: false, error: 'each message must be an object.' };
    if (!['system', 'user', 'assistant', 'tool'].includes(message.role)) return { ok: false, error: 'message.role is invalid.' };
    if (typeof message.content !== 'string' || message.content.trim().length === 0) return { ok: false, error: 'message.content is required.' };
    if (message.content.length > 12000) return { ok: false, error: 'message.content must be <= 12000 characters.' };
    messages.push({ role: message.role, content: message.content.trim() });
  }

  return {
    ok: true,
    data: {
      messages,
      user_id: input.user_id.trim(),
      project_id: input.project_id?.trim() ?? null,
      session_id: input.session_id?.trim() ?? null,
      source: input.source?.trim() ?? 'extract',
    },
  };
}
