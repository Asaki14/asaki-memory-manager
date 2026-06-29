import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { heuristicDecision, type CandidateAction, type ProcessMemoryCandidateInput } from '../src/services/candidateDecision.ts';
import type { MemoryKind, MemoryScope, SearchResult } from '../src/types.ts';

type MemoryFixture = {
  content: string;
  scope?: MemoryScope;
  kind?: MemoryKind;
  similarity?: number;
};

type Case = {
  name: string;
  expected: CandidateAction;
  candidate: MemoryFixture;
  existing?: MemoryFixture;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cases = JSON.parse(readFileSync(resolve(root, 'test/fixtures/candidate-decisions.json'), 'utf8')) as Case[];

function candidate(input: MemoryFixture): ProcessMemoryCandidateInput {
  return {
    content: input.content,
    user_id: 'eval-user',
    scope: input.scope ?? 'project',
    project_id: input.scope === 'global' ? null : 'eval-project',
    session_id: null,
    kind: input.kind ?? 'fact',
    importance: 0.5,
    confidence: 0.9,
    source: 'eval',
    expires_at: null,
  };
}

function existing(input: MemoryFixture, index: number): SearchResult {
  return {
    id: `existing-${index}`,
    user_id: 'eval-user',
    scope: input.scope ?? 'project',
    project_id: input.scope === 'global' ? null : 'eval-project',
    session_id: null,
    content: input.content,
    kind: input.kind ?? 'fact',
    importance: 0.5,
    confidence: 0.9,
    status: 'active',
    source: 'eval',
    index_status: 'indexed',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    last_accessed_at: null,
    expires_at: null,
    similarity: input.similarity ?? 0,
    score: input.similarity ?? 0,
  };
}

const failures: Array<{ name: string; expected: CandidateAction; actual: CandidateAction; reason: string }> = [];

cases.forEach((item, index) => {
  const actual = heuristicDecision(candidate(item.candidate), item.existing ? existing(item.existing, index) : undefined);
  if (actual.action !== item.expected) {
    failures.push({ name: item.name, expected: item.expected, actual: actual.action, reason: actual.reason });
  }
});

console.log(`candidate eval: ${cases.length - failures.length}/${cases.length} passed`);

if (failures.length > 0) {
  console.log('fail:');
  for (const failure of failures) {
    console.log(`- ${failure.name}: expected ${failure.expected}, got ${failure.actual} (${failure.reason})`);
  }
  process.exit(1);
}
