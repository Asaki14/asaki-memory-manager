// Memory lifecycle: reinforcement + recurrence tracking, correction provenance, and the
// idle-standing-rule / repeat-rate report (captain decisions 4 + 9, 2026-07-31).
//
// Everything here writes to (or reads) memories.metadata_json (migration 0006). Nothing here ever
// deletes, archives, or demotes a memory: a long-idle standing rule is REPORTED for human judgment
// and stays active and injected until a human decides otherwise.
import type {
  Env,
  MemoryCorrectionOrigin,
  MemoryKind,
  MemoryMetadata,
  MemoryReinforcement,
  MemoryRow,
  MemoryScope,
} from '../types';
import type { ProcessMemoryCandidateInput } from './candidateDecision';
import { writeMemoryEvent } from './memoryEvents';

function nowIso(): string {
  return new Date().toISOString();
}

// Only standing rules get reinforced. A repeated `fact`/`decision`/`bug_fix` duplicate is noise, not
// the agent re-violating a rule, and the recurrence signal has to mean one thing to be a
// system-health metric. Same kind set as STANDING_RULES_DEFAULT_KINDS in services/standingRules.ts
// (rule + preference are what get injected as session directives) — declared separately because that
// module's marked region is copied byte-for-byte into the Pi client.
export const REINFORCEABLE_KINDS: ReadonlySet<MemoryKind> = new Set<MemoryKind>(['rule', 'preference']);

// Bounded bump: a rule the agent keeps violating matters more, but reinforcement must never push a
// memory past what a human would set by hand, and it never lowers an existing importance.
export const REINFORCEMENT_IMPORTANCE_STEP = 0.05;
export const REINFORCEMENT_IMPORTANCE_CAP = 0.95;

// Idle threshold for the "possibly stale, judge keep/retire" bucket. 30 days ≈ two 14-day audit
// cadences, so a rule has to survive one full audit untouched before it is even raised. Callers can
// override per request; this is the default, not a policy.
export const DEFAULT_IDLE_RULE_DAYS = 30;

// Correction quotes stored on the memory itself are capped harder than the 300 chars allowed in
// candidate_json (validation.ts EVIDENCE_MAX_CHARS): the memory carries provenance, not a
// transcript. Captain decision 9 fixes this number at 120.
export const CORRECTION_ORIGIN_MAX_CHARS = 120;

export function parseMemoryMetadata(raw: string | null | undefined): MemoryMetadata {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as MemoryMetadata) : {};
  } catch {
    // A malformed/purged blob must not break a read path; treat it as "no metadata".
    return {};
  }
}

// Two decimals so repeated bumps stay on the same grid as hand-set values (0.05 steps) instead of
// accumulating float dust (0.7500000000000001).
// The cap bounds the bump, it does not clamp the memory: a human who set importance above the cap by
// hand must never see reinforcement pull it back down.
export function bumpImportance(current: number): number {
  const next = Math.round((current + REINFORCEMENT_IMPORTANCE_STEP) * 100) / 100;
  return Math.max(current, Math.min(REINFORCEMENT_IMPORTANCE_CAP, next));
}

export function reinforcementPatch(
  existing: MemoryMetadata,
  candidate: Pick<ProcessMemoryCandidateInput, 'signal_subtype' | 'source'>,
  at: string,
): MemoryReinforcement {
  const previous = existing.reinforcement;
  const count = typeof previous?.count === 'number' && previous.count > 0 ? previous.count : 0;
  return {
    count: count + 1,
    last_reinforced_at: at,
    last_signal_subtype: candidate.signal_subtype ?? null,
    last_source: candidate.source ?? null,
  };
}

function truncateQuote(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > CORRECTION_ORIGIN_MAX_CHARS ? text.slice(0, CORRECTION_ORIGIN_MAX_CHARS) : text;
}

export function correctionOriginPatch(candidate: ProcessMemoryCandidateInput, reviewId: string, at: string): MemoryCorrectionOrigin {
  return {
    agent_did: truncateQuote(candidate.correction?.agent_did),
    captain_verdict: truncateQuote(candidate.correction?.captain_verdict),
    signal_subtype: candidate.signal_subtype ?? null,
    antecedent_source: candidate.antecedent_source ?? null,
    review_id: reviewId,
    recorded_at: at,
  };
}

// Shallow merge on the top-level keys only: `reinforcement` and `correction_origin` are each written
// whole, so a partial write can never leave half a counter behind.
export async function writeMemoryMetadata(env: Env, memory: MemoryRow, patch: MemoryMetadata): Promise<string> {
  const merged: MemoryMetadata = { ...parseMemoryMetadata(memory.metadata_json), ...patch };
  const serialized = JSON.stringify(merged);
  await env.DB.prepare('UPDATE memories SET metadata_json = ?1 WHERE id = ?2 AND user_id = ?3')
    .bind(serialized, memory.id, memory.user_id)
    .run();
  return serialized;
}

export interface ReinforcementResult {
  memory_id: string;
  content: string;
  scope: MemoryScope;
  kind: MemoryKind;
  count: number;
  importance_before: number;
  importance_after: number;
  last_reinforced_at: string;
}

// Recurrence event: a correction candidate restated a rule that is ALREADY active, i.e. the agent
// repeated a mistake the rule covers. Bumps importance (bounded) and records the counter, and never
// touches content/scope/kind/confidence — so no re-embedding and no Vectorize write is needed
// (importance is read from D1 by scoreMemoryForSearch, not from the vector metadata).
export async function reinforceMemory(
  env: Env,
  memory: MemoryRow,
  candidate: ProcessMemoryCandidateInput,
): Promise<ReinforcementResult | null> {
  if (memory.status !== 'active') return null;
  if (!REINFORCEABLE_KINDS.has(memory.kind)) return null;

  const at = nowIso();
  const reinforcement = reinforcementPatch(parseMemoryMetadata(memory.metadata_json), candidate, at);
  const importanceAfter = bumpImportance(memory.importance);
  const merged: MemoryMetadata = { ...parseMemoryMetadata(memory.metadata_json), reinforcement };

  await env.DB.prepare('UPDATE memories SET importance = ?1, metadata_json = ?2, updated_at = ?3 WHERE id = ?4 AND user_id = ?5')
    .bind(importanceAfter, JSON.stringify(merged), at, memory.id, memory.user_id)
    .run();

  await writeMemoryEvent(env, {
    memoryId: memory.id,
    userId: memory.user_id,
    eventType: 'reinforce',
    payload: {
      count: reinforcement.count,
      importance_before: memory.importance,
      importance_after: importanceAfter,
      candidate_signal_subtype: candidate.signal_subtype ?? null,
      candidate_source: candidate.source ?? null,
    },
  });

  return {
    memory_id: memory.id,
    content: memory.content,
    scope: memory.scope,
    kind: memory.kind,
    count: reinforcement.count,
    importance_before: memory.importance,
    importance_after: importanceAfter,
    last_reinforced_at: at,
  };
}

// Provenance on activation: called after a correction review has been resolved into an active
// memory. Best-effort by design — the memory mutation has already committed, so a metadata failure
// is logged and swallowed rather than turned into a 500 that suggests the resolve failed.
export async function recordCorrectionOrigin(
  env: Env,
  memory: MemoryRow,
  candidate: ProcessMemoryCandidateInput,
  reviewId: string,
): Promise<MemoryCorrectionOrigin | null> {
  if (candidate.signal !== 'correction') return null;
  const origin = correctionOriginPatch(candidate, reviewId, nowIso());
  try {
    await writeMemoryMetadata(env, memory, { correction_origin: origin });
  } catch (error) {
    await writeMemoryEvent(env, {
      memoryId: memory.id,
      userId: memory.user_id,
      eventType: 'metadata_write_failed',
      payload: { review_id: reviewId, message: error instanceof Error ? error.message : String(error) },
    });
    return null;
  }
  return origin;
}

// `metadata_json` is free-form TEXT, so both aggregates are SQL expressions. The
// `CASE WHEN json_valid(...)` wrapper is required, not decorative: SQLite does not short-circuit
// AND, so `json_valid(x) AND json_extract(x, ...)` still throws on a malformed row. Same reasoning
// (and same lack of an index) as SIGNAL_EXPR in services/reviews.ts.
const REINFORCE_COUNT_EXPR = `(CASE WHEN json_valid(metadata_json) THEN COALESCE(json_extract(metadata_json, '$.reinforcement.count'), 0) ELSE 0 END)`;
const LAST_REINFORCED_EXPR = `(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.reinforcement.last_reinforced_at') ELSE NULL END)`;
const LAST_SUBTYPE_EXPR = `(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.reinforcement.last_signal_subtype') ELSE NULL END)`;
const STANDING_RULE_FILTER = `status = 'active' AND kind IN ('rule', 'preference')`;

export interface LifecycleReportInput {
  user_id: string;
  project_id?: string | null;
  idle_days: number;
  limit: number;
}

export interface RecurrenceEntry {
  id: string;
  content: string;
  scope: MemoryScope;
  project_id: string | null;
  kind: MemoryKind;
  importance: number;
  count: number;
  last_reinforced_at: string | null;
  last_signal_subtype: string | null;
}

export interface IdleRuleEntry {
  id: string;
  content: string;
  scope: MemoryScope;
  project_id: string | null;
  kind: MemoryKind;
  importance: number;
  idle_days: number;
  last_signal_at: string;
  reinforcement_count: number;
}

export interface LifecycleReport {
  idle_days_threshold: number;
  standing_rules: { active: number; reinforced: number; total_reinforcements: number; repeat_rate: number };
  recurrence: RecurrenceEntry[];
  idle_rules: IdleRuleEntry[];
}

// Global always counts; a project id additionally admits that project's rules — same visibility rule
// listMemories() uses when no explicit scope is given, so the report matches what a session actually
// gets injected.
function scopeClause(projectId: string | null | undefined): { sql: string; bindings: unknown[] } {
  if (!projectId) return { sql: `scope = 'global'`, bindings: [] };
  return { sql: `(scope = 'global' OR (scope = 'project' AND project_id = ?))`, bindings: [projectId] };
}

function daysBetween(fromIso: string, now: number): number {
  const parsed = Date.parse(fromIso);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, Math.floor((now - parsed) / 86_400_000));
}

// The system-health surface for decision 4: repeat rate (how many standing rules the agent had to be
// corrected on again) plus the per-rule recurrence counts, plus the long-idle rules that need a human
// keep/retire verdict. Read-only — this endpoint never mutates a memory.
export async function lifecycleReport(env: Env, input: LifecycleReportInput): Promise<LifecycleReport> {
  const scope = scopeClause(input.project_id);
  const now = Date.now();
  const cutoff = new Date(now - input.idle_days * 86_400_000).toISOString();

  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS active,
            SUM(CASE WHEN ${REINFORCE_COUNT_EXPR} > 0 THEN 1 ELSE 0 END) AS reinforced,
            SUM(${REINFORCE_COUNT_EXPR}) AS total_reinforcements
     FROM memories
     WHERE user_id = ? AND ${STANDING_RULE_FILTER} AND ${scope.sql}`
  )
    .bind(input.user_id, ...scope.bindings)
    .first<{ active: number | null; reinforced: number | null; total_reinforcements: number | null }>();

  const active = Number(totals?.active ?? 0);
  const reinforced = Number(totals?.reinforced ?? 0);
  const totalReinforcements = Number(totals?.total_reinforcements ?? 0);

  const recurrenceRows = await env.DB.prepare(
    `SELECT id, content, scope, project_id, kind, importance,
            ${REINFORCE_COUNT_EXPR} AS reinforce_count,
            ${LAST_REINFORCED_EXPR} AS last_reinforced_at,
            ${LAST_SUBTYPE_EXPR} AS last_signal_subtype
     FROM memories
     WHERE user_id = ? AND ${STANDING_RULE_FILTER} AND ${scope.sql} AND ${REINFORCE_COUNT_EXPR} > 0
     ORDER BY reinforce_count DESC, last_reinforced_at DESC
     LIMIT ?`
  )
    .bind(input.user_id, ...scope.bindings, input.limit)
    .all<MemoryRow & { reinforce_count: number; last_reinforced_at: string | null; last_signal_subtype: string | null }>();

  // "No signal" for a standing rule = never reinforced AND never returned by a retrieval search.
  // Session-start injection deliberately does NOT count as a signal: it is unconditional for every
  // active rule, so counting it would make every rule look fresh forever.
  const idleRows = await env.DB.prepare(
    `SELECT id, content, scope, project_id, kind, importance,
            ${REINFORCE_COUNT_EXPR} AS reinforce_count,
            COALESCE(${LAST_REINFORCED_EXPR}, last_accessed_at, created_at) AS last_signal_at
     FROM memories
     WHERE user_id = ? AND ${STANDING_RULE_FILTER} AND ${scope.sql}
       AND COALESCE(${LAST_REINFORCED_EXPR}, last_accessed_at, created_at) < ?
     ORDER BY last_signal_at ASC
     LIMIT ?`
  )
    .bind(input.user_id, ...scope.bindings, cutoff, input.limit)
    .all<MemoryRow & { reinforce_count: number; last_signal_at: string }>();

  return {
    idle_days_threshold: input.idle_days,
    standing_rules: {
      active,
      reinforced,
      total_reinforcements: totalReinforcements,
      repeat_rate: active > 0 ? Math.round((reinforced / active) * 1000) / 1000 : 0,
    },
    recurrence: (recurrenceRows.results ?? []).map((row) => ({
      id: row.id,
      content: row.content,
      scope: row.scope,
      project_id: row.project_id,
      kind: row.kind,
      importance: row.importance,
      count: Number(row.reinforce_count ?? 0),
      last_reinforced_at: row.last_reinforced_at ?? null,
      last_signal_subtype: row.last_signal_subtype ?? null,
    })),
    idle_rules: (idleRows.results ?? []).map((row) => ({
      id: row.id,
      content: row.content,
      scope: row.scope,
      project_id: row.project_id,
      kind: row.kind,
      importance: row.importance,
      idle_days: daysBetween(row.last_signal_at, now),
      last_signal_at: row.last_signal_at,
      reinforcement_count: Number(row.reinforce_count ?? 0),
    })),
  };
}
