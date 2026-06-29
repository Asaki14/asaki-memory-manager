import type { ExtractMemoriesInput, MemoryKind, MemoryScope, Env } from '../types';
import type { ProcessMemoryCandidateInput, CandidateDecision } from './candidates';
import { processMemoryCandidates } from './candidates';

export interface ExtractedMemoryCandidate {
  content: string;
  scope: MemoryScope;
  kind: MemoryKind;
  importance: number;
  confidence: number;
  reason: string;
}

export interface ExtractMemoriesResult {
  candidates: ExtractedMemoryCandidate[];
  decisions: CandidateDecision[];
}

const scopes = new Set<MemoryScope>(['global', 'project', 'session']);
const kinds = new Set<MemoryKind>(['preference', 'rule', 'fact', 'decision', 'task_learning', 'bug_fix', 'workflow']);

function modelError(env: Env): string | null {
  if (!env.MEMORY_LLM_MODEL) return 'MEMORY_LLM_MODEL is not configured. Set a Workers AI chat model before using memory extraction.';
  if (!env.AI) return 'Workers AI binding is not available.';
  return null;
}

function prompt(input: ExtractMemoriesInput): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content: [
        'Extract long-term memory candidates from a conversation.',
        'Return strict JSON only: {"candidates":[{"content":"...","scope":"global|project|session","kind":"preference|rule|fact|decision|task_learning|bug_fix|workflow","importance":0.0,"confidence":0.0,"reason":"..."}]}',
        'Only keep durable, future-useful information: explicit user preferences, coding/output rules, project conventions, architecture decisions, repeatable workflows, and confirmed pitfalls/bug fixes.',
        'Ignore temporary chat, one-off task instructions, transient implementation status, command output, self-tests, reload/verification markers, diagnostics, secrets, credentials, duplicates, vague claims, and low-confidence information.',
        'Do not extract memories from assistant status updates unless they record a durable project decision, workflow, or bug fix that will be useful in future work.',
        'Use global only for user-wide preferences/rules. Use project for project conventions/decisions/pitfalls/workflows when project_id exists. Use session only for session-specific durable context when session_id exists.',
        'If no valuable memory exists, return {"candidates":[]}.',
        'Keep each content concise and self-contained. Do not include secrets or temporary test identifiers.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        user_id: input.user_id,
        project_id: input.project_id ?? null,
        session_id: input.session_id ?? null,
        source: input.source ?? null,
        messages: input.messages,
      }),
    },
  ];
}

function rawText(response: unknown): string {
  if (typeof response === 'string') return response;
  const value = response as any;
  return String(value?.response ?? value?.result?.response ?? value?.result?.text ?? value?.text ?? '');
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return {};

  const direct = tryParseJson(trimmed);
  if (direct) return direct;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    const parsed = tryParseJson(fenced.trim());
    if (parsed) return parsed;
  }

  const object = trimmed.match(/\{[\s\S]*\}/)?.[0];
  if (object) {
    const parsed = tryParseJson(object);
    if (parsed) return parsed;
  }

  return {};
}

function numberInRange(value: unknown, fallback: number): number {
  return typeof value === 'number' && value >= 0 && value <= 1 ? value : fallback;
}

function isLowValueContent(content: string): boolean {
  const normalized = content.toLowerCase();
  return [
    'self-test',
    'verification marker',
    'reload verification',
    'tmp-',
    '测试编号',
    '自检',
    '临时测试',
    '随便测试',
  ].some((marker) => normalized.includes(marker));
}

function normalizeCandidate(value: unknown): ExtractedMemoryCandidate | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<ExtractedMemoryCandidate>;
  if (typeof input.content !== 'string' || input.content.trim().length === 0 || input.content.length > 8000) return null;
  if (isLowValueContent(input.content)) return null;
  if (!input.scope || !scopes.has(input.scope)) return null;
  if (!input.kind || !kinds.has(input.kind)) return null;

  const confidence = numberInRange(input.confidence, 0);
  if (confidence < 0.6) return null;

  return {
    content: input.content.trim(),
    scope: input.scope,
    kind: input.kind,
    importance: numberInRange(input.importance, 0.5),
    confidence,
    reason: typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : 'Extracted as durable memory.',
  };
}

function canSaveCandidate(input: ExtractMemoriesInput, candidate: ExtractedMemoryCandidate): boolean {
  if (candidate.scope === 'project' && !input.project_id) return false;
  if (candidate.scope === 'session' && !input.session_id) return false;
  return true;
}

function buildProcessInput(input: ExtractMemoriesInput, candidates: ExtractedMemoryCandidate[]): ProcessMemoryCandidateInput[] {
  return candidates.map((candidate) => ({
    content: candidate.content,
    user_id: input.user_id,
    scope: candidate.scope,
    project_id: candidate.scope === 'project' ? input.project_id ?? null : null,
    session_id: candidate.scope === 'session' ? input.session_id ?? null : null,
    kind: candidate.kind,
    importance: candidate.importance,
    confidence: candidate.confidence,
    source: input.source ?? 'extract',
    expires_at: null,
  }));
}

export async function extractMemories(env: Env, input: ExtractMemoriesInput): Promise<ExtractMemoriesResult> {
  const error = modelError(env);
  if (error) throw new Error(error);

  const response = await env.AI!.run(env.MEMORY_LLM_MODEL!, { messages: prompt(input) });
  const parsed = parseJsonObject(rawText(response)) as { candidates?: unknown };
  const rawCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  const candidates = rawCandidates
    .map(normalizeCandidate)
    .filter((candidate): candidate is ExtractedMemoryCandidate => candidate !== null && canSaveCandidate(input, candidate))
    .slice(0, 20);
  const decisions = await processMemoryCandidates(env, buildProcessInput(input, candidates));

  return { candidates, decisions };
}
