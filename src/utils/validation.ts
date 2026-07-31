import type { CandidateAntecedentSource, CandidateCorrectionEvidence, CandidateEvidenceFields, CandidateRuleForm, CandidateSignal, CandidateSignalSubtype, CreateMemoryInput, ExtractMemoriesInput, ListMemoriesInput, MemoryIdInput, MemoryKind, MemoryScope, MemoryStatus, SearchMemoriesInput, UpdateMemoryInput } from '../types';
import { confidenceForAntecedent, importanceForSignal } from '../services/candidateDecision';
import { DEFAULT_IDLE_RULE_DAYS } from '../services/memoryLifecycle';
import { containsSensitiveContent } from './sensitiveContent';

const SENSITIVE_CONTENT_ERROR = 'content looks like it contains a secret or credential; refusing to store it.';

const scopes = new Set<MemoryScope>(['global', 'project', 'session']);
const kinds = new Set<MemoryKind>(['preference', 'rule', 'fact', 'decision', 'task_learning', 'bug_fix', 'workflow']);
const statuses = new Set<MemoryStatus>(['active', 'archived', 'deleted']);
const reviewStatuses = new Set(['pending', 'resolved']);
const reviewActions = new Set(['add', 'merge', 'update', 'delete', 'ignore']);

const candidateSignals = new Set<CandidateSignal>(['correction', 'preference', 'outcome', 'none']);
const candidateSignalSubtypes = new Set<CandidateSignalSubtype | ''>(['explicit_negation', 'override_of_action', 'terse_redirect', 'repeat_complaint', 'approval_after_change', 'futility_verdict']);
const candidateRuleForms = new Set<CandidateRuleForm>(['prohibition', 'preference', 'procedure', 'retract']);
const candidateAntecedentSources = new Set<CandidateAntecedentSource>(['prose', 'trace', 'prior_tail', 'candidate', 'none']);

// Evidence strings are truncated, never rejected for length: a deterministic 400 on this path
// costs the classifier a consumed transcript delta, which is a worse outcome than a clipped quote.
// A secret is the one exception — refusing to store that is correct (handled below).
const EVIDENCE_MAX_CHARS = 300;
const SUPERSEDES_REVIEW_ID_MAX_CHARS = 64;
const PROJECT_CONTEXT_MAX_CHARS = 128;

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function coerceEvidenceString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// Trimmed, capped, or null — never a 400.
function coerceOptionalId(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? truncate(trimmed, max) : null;
}

// Enum coercion is deliberately total: an unrecognised value degrades to the inert member of its
// enum rather than rejecting the candidate. An absent field stays absent, so "no signal" and
// "signal: none" are both representable and both mean "run no server-side derivation".
function coerceEnum<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
  const raw = typeof value === 'string' ? value.trim() : '';
  return allowed.has(raw as T) ? (raw as T) : fallback;
}

// Threads the correction-classifier evidence fields through instead of letting the whitelist below
// drop them. The sensitive gate applies to all four evidence strings (agent_did, captain_verdict,
// redirect_target AND supersedes_query) and runs on the ORIGINAL string, before truncation, so a
// cap can never bisect a credential into a non-matching prefix.
function validateCandidateEvidence(input: CreateMemoryInput): { ok: true; data: CandidateEvidenceFields } | { ok: false; error: string } {
  const data: CandidateEvidenceFields = {};

  if (input.signal !== undefined && input.signal !== null) {
    const raw = typeof input.signal === 'string' ? input.signal.trim() : '';
    if (raw.length > 0) data.signal = coerceEnum<CandidateSignal>(raw, candidateSignals, 'none');
  }
  if (input.signal_subtype !== undefined && input.signal_subtype !== null) {
    data.signal_subtype = coerceEnum<CandidateSignalSubtype | ''>(input.signal_subtype, candidateSignalSubtypes, '');
  }
  if (input.rule_form !== undefined && input.rule_form !== null) {
    data.rule_form = coerceEnum<CandidateRuleForm>(input.rule_form, candidateRuleForms, 'preference');
  }
  if (input.antecedent_source !== undefined && input.antecedent_source !== null) {
    data.antecedent_source = coerceEnum<CandidateAntecedentSource>(input.antecedent_source, candidateAntecedentSources, 'none');
  }

  if (input.correction !== undefined && input.correction !== null) {
    const raw = (typeof input.correction === 'object' ? input.correction : {}) as Partial<CandidateCorrectionEvidence>;
    const parts: CandidateCorrectionEvidence = {
      agent_did: coerceEvidenceString(raw.agent_did),
      captain_verdict: coerceEvidenceString(raw.captain_verdict),
      redirect_target: coerceEvidenceString(raw.redirect_target),
    };
    for (const part of Object.values(parts)) {
      if (containsSensitiveContent(part)) return { ok: false, error: SENSITIVE_CONTENT_ERROR };
    }
    data.correction = {
      agent_did: truncate(parts.agent_did, EVIDENCE_MAX_CHARS),
      captain_verdict: truncate(parts.captain_verdict, EVIDENCE_MAX_CHARS),
      redirect_target: truncate(parts.redirect_target, EVIDENCE_MAX_CHARS),
    };
  }

  if (input.supersedes_query !== undefined) {
    const raw = coerceEvidenceString(input.supersedes_query);
    if (containsSensitiveContent(raw)) return { ok: false, error: SENSITIVE_CONTENT_ERROR };
    data.supersedes_query = raw.trim().length > 0 ? truncate(raw, EVIDENCE_MAX_CHARS) : null;
  }
  if (input.supersedes_pending_review_id !== undefined) {
    data.supersedes_pending_review_id = coerceOptionalId(input.supersedes_pending_review_id, SUPERSEDES_REVIEW_ID_MAX_CHARS);
  }
  if (input.project_context !== undefined) {
    data.project_context = coerceOptionalId(input.project_context, PROJECT_CONTEXT_MAX_CHARS);
  }

  return { ok: true, data };
}

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
  if (containsSensitiveContent(input.content)) return { ok: false, error: SENSITIVE_CONTENT_ERROR };
  if (typeof input.user_id !== 'string' || input.user_id.trim().length === 0) return { ok: false, error: 'user_id is required.' };

  const scope = input.scope ?? 'global';
  if (!scopes.has(scope)) return { ok: false, error: 'scope must be global, project, or session.' };
  if (scope === 'project' && !input.project_id) return { ok: false, error: 'project_id is required when scope is project.' };
  if (scope === 'session' && !input.session_id) return { ok: false, error: 'session_id is required when scope is session.' };

  const kind = input.kind ?? 'fact';
  if (!kinds.has(kind)) return { ok: false, error: 'kind is invalid.' };

  const evidence = validateCandidateEvidence(input);
  if (!evidence.ok) return evidence;

  // A supplied importance/confidence always wins, so the supervised asaki_memory_add path and every
  // existing caller are untouched. Only a candidate carrying a recognised signal / antecedent_source
  // gets a derived number; everything else falls through to today's defaults.
  const suppliedImportance = input.importance ?? null;
  if (suppliedImportance !== null && (typeof suppliedImportance !== 'number' || suppliedImportance < 0 || suppliedImportance > 1)) {
    return { ok: false, error: 'importance must be between 0 and 1.' };
  }
  const importance = suppliedImportance ?? importanceForSignal(evidence.data.signal, evidence.data.signal_subtype, kind) ?? 0.5;

  const suppliedConfidence = input.confidence ?? null;
  if (suppliedConfidence !== null && (typeof suppliedConfidence !== 'number' || suppliedConfidence < 0 || suppliedConfidence > 1)) {
    return { ok: false, error: 'confidence must be between 0 and 1.' };
  }
  const confidence = suppliedConfidence ?? confidenceForAntecedent(evidence.data.antecedent_source) ?? 1;

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
      ...evidence.data,
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
    if (containsSensitiveContent(input.content)) return { ok: false, error: SENSITIVE_CONTENT_ERROR };
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
  if (Object.keys(data).length === 1) return { ok: false, error: 'At least one update field is required.' };

  return { ok: true, data };
}

export function validateExtractMemories(value: unknown): { ok: true; data: ExtractMemoriesInput } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Body must be a JSON object.' };
  const input = value as ExtractMemoriesInput;
  if (typeof input.text !== 'string' || input.text.trim().length === 0) return { ok: false, error: 'text is required.' };
  if (input.text.length > 20000) return { ok: false, error: 'text must be <= 20000 characters.' };
  if (containsSensitiveContent(input.text)) return { ok: false, error: SENSITIVE_CONTENT_ERROR };
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

export function validateListMemoryReviews(value: unknown): { ok: true; data: { user_id: string; status: 'pending' | 'resolved' | 'all'; project_id?: string | null; session_id?: string | null; source?: string | null; signal?: CandidateSignal | null; limit: number; offset: number; include_suggestions: boolean } } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Body must be a JSON object.' };
  const input = value as { user_id?: unknown; status?: unknown; project_id?: unknown; session_id?: unknown; source?: unknown; signal?: unknown; limit?: unknown; offset?: unknown; include_suggestions?: unknown };
  const userId = validateUserId(input.user_id);
  if (!userId) return { ok: false, error: 'user_id is required.' };
  const status = input.status ?? 'pending';
  if (status !== 'all' && (typeof status !== 'string' || !reviewStatuses.has(status))) return { ok: false, error: 'status must be pending, resolved, or all.' };
  if (input.project_id != null && (typeof input.project_id !== 'string' || input.project_id.trim().length === 0)) return { ok: false, error: 'project_id must be a non-empty string when provided.' };
  if (input.session_id != null && (typeof input.session_id !== 'string' || input.session_id.trim().length === 0)) return { ok: false, error: 'session_id must be a non-empty string when provided.' };
  if (input.source != null && (typeof input.source !== 'string' || input.source.trim().length === 0)) return { ok: false, error: 'source must be a non-empty string when provided.' };
  // Unlike the candidate-write path (where an unknown enum is coerced, never rejected), this is a
  // human/agent query: a typo'd filter should say so instead of silently returning everything.
  if (input.signal != null && (typeof input.signal !== 'string' || !candidateSignals.has(input.signal as CandidateSignal))) {
    return { ok: false, error: 'signal must be correction, preference, outcome, or none when provided.' };
  }
  const limit = input.limit == null ? 50 : input.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) return { ok: false, error: 'limit must be an integer between 1 and 100.' };
  const offset = input.offset == null ? 0 : input.offset;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) return { ok: false, error: 'offset must be a non-negative integer.' };
  if (input.include_suggestions !== undefined && typeof input.include_suggestions !== 'boolean') return { ok: false, error: 'include_suggestions must be a boolean.' };
  return {
    ok: true,
    data: {
      user_id: userId,
      status: status as 'pending' | 'resolved' | 'all',
      project_id: typeof input.project_id === 'string' ? input.project_id.trim() : null,
      session_id: typeof input.session_id === 'string' ? input.session_id.trim() : null,
      source: typeof input.source === 'string' ? input.source.trim() : null,
      signal: typeof input.signal === 'string' ? (input.signal as CandidateSignal) : null,
      limit,
      offset,
      include_suggestions: input.include_suggestions === true,
    },
  };
}

export function validateBackfillIndex(value: unknown): { ok: true; data: { limit: number } } | { ok: false; error: string } {
  const input = (value && typeof value === 'object' ? value : {}) as { limit?: unknown };
  const limit = input.limit == null ? 50 : input.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 500) return { ok: false, error: 'limit must be an integer between 1 and 500.' };
  return { ok: true, data: { limit } };
}

export function validatePruneStale(value: unknown): { ok: true; data: { days: number; limit: number; apply: boolean } } | { ok: false; error: string } {
  const input = (value && typeof value === 'object' ? value : {}) as { days?: unknown; limit?: unknown; apply?: unknown };
  const days = input.days == null ? 90 : input.days;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 3650) return { ok: false, error: 'days must be an integer between 1 and 3650.' };
  const limit = input.limit == null ? 100 : input.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 500) return { ok: false, error: 'limit must be an integer between 1 and 500.' };
  if (input.apply !== undefined && typeof input.apply !== 'boolean') return { ok: false, error: 'apply must be a boolean.' };
  return { ok: true, data: { days, limit, apply: input.apply === true } };
}

export function validateResolveMemoryReview(value: unknown): { ok: true; data: { user_id: string; action: 'add' | 'merge' | 'update' | 'delete' | 'ignore'; memory_id?: string | null; reason?: string | null; promote_to_global?: boolean } } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Body must be a JSON object.' };
  const input = value as { user_id?: unknown; action?: unknown; memory_id?: unknown; reason?: unknown; promote_to_global?: unknown };
  const userId = validateUserId(input.user_id);
  if (!userId) return { ok: false, error: 'user_id is required.' };
  if (typeof input.action !== 'string' || !reviewActions.has(input.action)) return { ok: false, error: 'action must be add, merge, update, delete, or ignore.' };
  if (input.memory_id != null && (typeof input.memory_id !== 'string' || input.memory_id.trim().length === 0)) return { ok: false, error: 'memory_id must be a non-empty string when provided.' };
  if (input.reason != null && (typeof input.reason !== 'string' || input.reason.trim().length === 0)) return { ok: false, error: 'reason must be a non-empty string when provided.' };
  if ((input.action === 'merge' || input.action === 'update' || input.action === 'delete') && !input.memory_id) return { ok: false, error: 'memory_id is required when action is merge, update, or delete.' };
  // Accepts the review row's `promotion_candidates` hint in the same call that activates the rule.
  // The action check lives in resolveMemoryReview() (it is the invariant, not the input shape).
  if (input.promote_to_global !== undefined && typeof input.promote_to_global !== 'boolean') return { ok: false, error: 'promote_to_global must be a boolean.' };
  return { ok: true, data: { user_id: userId, action: input.action as 'add' | 'merge' | 'update' | 'delete' | 'ignore', memory_id: input.memory_id?.trim() ?? null, reason: input.reason?.trim() ?? null, promote_to_global: input.promote_to_global === true } };
}

export function validateLifecycleReport(value: unknown): { ok: true; data: { user_id: string; project_id: string | null; idle_days: number; limit: number } } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Body must be a JSON object.' };
  const input = value as { user_id?: unknown; project_id?: unknown; idle_days?: unknown; limit?: unknown };
  const userId = validateUserId(input.user_id);
  if (!userId) return { ok: false, error: 'user_id is required.' };
  if (input.project_id != null && (typeof input.project_id !== 'string' || input.project_id.trim().length === 0)) return { ok: false, error: 'project_id must be a non-empty string when provided.' };
  const idleDays = input.idle_days == null ? DEFAULT_IDLE_RULE_DAYS : input.idle_days;
  if (typeof idleDays !== 'number' || !Number.isInteger(idleDays) || idleDays < 1 || idleDays > 3650) return { ok: false, error: 'idle_days must be an integer between 1 and 3650.' };
  const limit = input.limit == null ? 20 : input.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) return { ok: false, error: 'limit must be an integer between 1 and 100.' };
  return { ok: true, data: { user_id: userId, project_id: typeof input.project_id === 'string' ? input.project_id.trim() : null, idle_days: idleDays, limit } };
}

export function validatePurgeMemory(value: unknown): { ok: true; data: { user_id: string; reason: string | null } } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Body must be a JSON object.' };
  const input = value as { user_id?: unknown; reason?: unknown };
  const userId = validateUserId(input.user_id);
  if (!userId) return { ok: false, error: 'user_id is required.' };
  if (input.reason != null && (typeof input.reason !== 'string' || input.reason.trim().length === 0)) return { ok: false, error: 'reason must be a non-empty string when provided.' };
  return { ok: true, data: { user_id: userId, reason: input.reason?.trim() ?? null } };
}
