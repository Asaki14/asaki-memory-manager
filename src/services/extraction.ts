import type { Env, MemoryKind } from '../types';
import { writeMemoryEvent } from './memoryEvents';

const KINDS: MemoryKind[] = ['preference', 'rule', 'fact', 'decision', 'task_learning', 'bug_fix', 'workflow'];

export interface ExtractedCandidate {
  content: string;
  kind: MemoryKind;
  importance: number;
}

const SYSTEM_PROMPT =
  'Extract durable memories from raw text. Only extract: explicit user preferences, decisions made, completed task learnings, bug fixes, established rules/conventions, or workflow changes. Skip transient chit-chat, questions, and anything without lasting future value. Each memory must be a concise, self-contained statement understandable without the surrounding context. Return strict JSON: {"candidates":[{"content":"...","kind":"preference|rule|fact|decision|task_learning|bug_fix|workflow","importance":0.0-1.0}]}. Return {"candidates":[]} if nothing durable is found. Never invent facts not present in the text.';

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
      if (typeof content !== 'string' || content.trim().length === 0) continue;
      result.push({
        content: content.trim(),
        kind: KINDS.includes(kind as MemoryKind) ? (kind as MemoryKind) : 'task_learning',
        importance: typeof importance === 'number' && importance >= 0 && importance <= 1 ? importance : 0.5,
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
