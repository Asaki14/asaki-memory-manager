import type { Env, MemoryKind, MemoryScope } from '../types';
import { writeMemoryEvent } from './memoryEvents';

const KINDS: MemoryKind[] = ['preference', 'rule', 'fact', 'decision', 'task_learning', 'bug_fix', 'workflow'];
const SCOPES: MemoryScope[] = ['global', 'project'];

export interface ExtractedCandidate {
  content: string;
  kind: MemoryKind;
  importance: number;
  scope: MemoryScope;
}

const SYSTEM_PROMPT =
  'Extract durable memories from raw text. Only extract: explicit user preferences, decisions made, completed task learnings, bug fixes, established rules/conventions, or workflow changes. Also extract explicit requests to forget, retract, or invalidate a previous preference/decision/fact — keep the forget/retract wording intact in the candidate text (e.g. "forget that I prefer dark mode") so a downstream step can act on it. Skip transient chit-chat, questions, and anything without lasting future value. In particular, do NOT extract short imperative instructions or commands directed at the assistant (e.g. "refresh and verify", "run the tests", "push this") — these are one-off task directives, not durable facts, even if they appear alongside meaningful context. The text may also include the assistant quoting or paraphrasing source code, prompt strings, or CLI/tool output verbatim (e.g. explaining a piece of code that happens to contain example text like "forget that I prefer dark mode", or pasting console output from a command) — never extract these quoted/pasted fragments as if the user said or requested them; only extract what a participant actually, genuinely stated. Each memory must be a concise, self-contained statement understandable without the surrounding context. For each candidate also classify "scope": "global" for cross-project preferences/rules/conventions about how the user generally likes to work (editor settings, communication style, recurring habits), or "project" for facts/decisions specific to the codebase/project currently being discussed. Return strict JSON: {"candidates":[{"content":"...","kind":"preference|rule|fact|decision|task_learning|bug_fix|workflow","importance":0.0-1.0,"scope":"global|project"}]}. Return {"candidates":[]} if nothing durable is found. Never invent facts not present in the text.';

export async function extractMemoryCandidates(env: Env, text: string, userId: string): Promise<ExtractedCandidate[]> {
  if (!env.AI || !env.MEMORY_LLM_MODEL) return [];
  try {
    const response = await env.AI.run(env.MEMORY_LLM_MODEL, {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
    });
    const raw = typeof response === 'string' ? response : (response as any)?.response ?? (response as any)?.result?.response ?? '';
    const parsed = JSON.parse(String(raw).match(/\{[\s\S]*\}/)?.[0] ?? '{}') as { candidates?: unknown };
    if (!Array.isArray(parsed.candidates)) return [];

    const result: ExtractedCandidate[] = [];
    for (const item of parsed.candidates) {
      if (!item || typeof item !== 'object') continue;
      const content = (item as Record<string, unknown>).content;
      const kind = (item as Record<string, unknown>).kind;
      const importance = (item as Record<string, unknown>).importance;
      const scope = (item as Record<string, unknown>).scope;
      if (typeof content !== 'string' || content.trim().length === 0) continue;
      result.push({
        content: content.trim(),
        kind: KINDS.includes(kind as MemoryKind) ? (kind as MemoryKind) : 'task_learning',
        importance: typeof importance === 'number' && importance >= 0 && importance <= 1 ? importance : 0.5,
        scope: SCOPES.includes(scope as MemoryScope) ? (scope as MemoryScope) : 'project',
      });
    }
    return result;
  } catch (error) {
    await writeMemoryEvent(env, {
      userId,
      eventType: 'extraction_failed',
      payload: { message: error instanceof Error ? error.message : String(error) },
    });
    return [];
  }
}
