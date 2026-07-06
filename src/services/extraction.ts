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

// Modeled on mem0's fact-retrieval prompt design (role-scoped extraction + few-shot examples
// instead of prose-only rules — an 8B model follows worked examples far more reliably than
// abstract instructions). Unlike mem0's user-only rule, both roles remain eligible here because
// this system's most valuable memories are the assistant's own completed-work summaries — but
// each role gets its own bar, and the negative examples target failure modes actually observed
// in production: quoted CLI/tool output, quoted source/prompt strings, and bare commands.
const SYSTEM_PROMPT = `You are a memory extractor for a coding assistant's conversation log. The input is raw text made of "User: ..." and "Assistant: ..." turns.

Extract only: explicit user preferences, decisions made, completed task learnings, bug fixes, established rules/conventions, or workflow changes. Also extract explicit requests to forget, retract, or invalidate a previous preference/decision/fact — keep the forget/retract wording intact in the candidate text so a downstream step can act on it.

Both roles can be a source, but apply a different bar per role:
- From User turns: extract genuine preferences, facts, or decisions the user actually states about themselves or the project.
- From Assistant turns: extract ONLY a genuine, completed summary of what was learned, fixed, or decided. Never extract the assistant's quoted source code, prompt strings, or pasted CLI/tool output, and never extract the assistant's own questions or proposed next steps to the user — even when phrased as a declarative list of steps, a proposed plan is not a completed fact unless the text confirms it was actually carried out.

Skip transient chit-chat, questions, short imperative commands directed at the assistant (e.g. "run the tests", "verify this", "refresh"), and anything without lasting future value.

Two more patterns that must NOT be extracted, even though they look like real content at a glance:
1. Illustrative examples: text introduced by "比如", "例如", "for example", or "such as" that shows a hypothetical or sample User:/Assistant: line to illustrate a point (e.g. explaining what a prompt or feature should do). This is a demonstration, not something anyone actually said.
2. Open deliberation: a question paired with the assistant's own suggested answer/recommendation about that same question (e.g. "要不要做 X？我建议做 X，因为..."). This is still an open decision being discussed, not a completed fact, even though it reads like a definite statement.

Examples:

Input: User: 跑一下测试
Output: {"candidates":[]}

Input: Assistant: 插件已更新。CLI 输出：✔ Plugin updated from 1.3.1 to 1.3.2. Restart to apply changes.
Output: {"candidates":[]}

Input: Assistant: FORGET_SIGNALS 正则用于识别类似 "forget that I prefer dark mode" 这种表达，命中后转交 LLM 处理。
Output: {"candidates":[]}

Input: Assistant: 要不要跟上次一样：commit → push → bump 版本号 → claude plugin update 刷新本地缓存？
Output: {"candidates":[]}

Input: User: 以后都用 pnpm，不要用 npm
Output: {"candidates":[{"content":"用户偏好使用 pnpm，不使用 npm","kind":"preference","importance":0.8,"scope":"global"}]}

Input: Assistant: 根因是同时跑了两个 daemon 互相抢焦点，已加 pkill 守卫脚本防止野实例重新抢焦。
Output: {"candidates":[{"content":"Focus-stealing bug 根因是两个 daemon 同时运行互相抢焦点；已加 pkill 守卫脚本防止野实例。","kind":"bug_fix","importance":0.7,"scope":"global"}]}

Input: User: forget that I prefer dark mode
Output: {"candidates":[{"content":"forget that I prefer dark mode","kind":"preference","importance":0.5,"scope":"global"}]}

Input: Assistant: 现在 prompt 里加了新的 few-shot 正例，比如 User: 以后都用 pnpm，不要用 npm 这种输入应该被正确抽取成用户偏好。跑了回归测试，8/8 全过。
Output: {"candidates":[]}

Input: Assistant: 建好了，eval:extraction 脚本已经能跑。要不要现在建这个 eval 文件？我建议现在建，因为能把踩过的坑固化成回归用例。
Output: {"candidates":[]}

Each memory must be a concise, self-contained statement understandable without the surrounding context. For each candidate also classify "scope": "global" for cross-project preferences/rules/conventions about how the user generally likes to work (editor settings, communication style, recurring habits), or "project" for facts/decisions specific to the codebase/project currently being discussed. Return strict JSON: {"candidates":[{"content":"...","kind":"preference|rule|fact|decision|task_learning|bug_fix|workflow","importance":0.0-1.0,"scope":"global|project"}]}. Return {"candidates":[]} if nothing durable is found. Never invent facts not present in the text. Do not return the example inputs/outputs shown above verbatim — they are for pattern reference only.`;

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
