import { scoreMemoryForSearch } from '../src/services/searchScoring.ts';
import type { MemoryRow, SearchMemoriesInput } from '../src/types.ts';

const input: SearchMemoriesInput = {
  query: 'Asaki memory Pi extension agent-decided memory retrieval auto inject disabled default ASAKI_MEMORY_AUTO_INJECT',
  user_id: 'asaki',
  project_id: '.pi',
  top_k: 10,
};

function memory(id: string, content: string, importance: number, confidence: number): MemoryRow {
  return {
    id,
    user_id: 'asaki',
    scope: 'project',
    project_id: '.pi',
    session_id: null,
    content,
    kind: 'decision',
    importance,
    confidence,
    status: 'active',
    source: 'eval',
    index_status: 'indexed',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    last_accessed_at: null,
    expires_at: null,
  };
}

const atomic = scoreMemoryForSearch(
  memory(
    'atomic',
    'atomic-commit extension now generates English Conventional Commit subjects from git status/worktree changes instead of extracting assistant/user conversation text; it also filters key-exit-debug.log from auto-commit summaries and temp-index commits as runtime noise.',
    0.7,
    0.95
  ),
  input,
  0.885,
  'vector'
);

const asaki = scoreMemoryForSearch(
  memory(
    'asaki',
    'Asaki memory Pi extension auto-injection was optimized: automatic memory search now only runs when the prompt matches memory-needed cues unless ASAKI_MEMORY_AUTO_INJECT_ALWAYS is enabled; empty/no-injection search displays are hidden unless ASAKI_MEMORY_DEBUG is enabled.',
    0.65,
    0.9
  ),
  input,
  0.846,
  'vector'
);

console.log({ atomic, asaki });

if (asaki.score <= atomic.score) {
  throw new Error(`expected Asaki memory result to outrank atomic-commit: asaki=${asaki.score}, atomic=${atomic.score}`);
}
