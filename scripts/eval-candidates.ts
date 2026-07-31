import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bestUsableMatch, heuristicDecision, needsLlmDecision, usableMatches, type CandidateAction, type ProcessMemoryCandidateInput } from '../src/services/candidateDecision.ts';
import type { MemoryKind, MemoryScope, SearchResult } from '../src/types.ts';

type MemoryFixture = {
  content: string;
  scope?: MemoryScope;
  kind?: MemoryKind;
  similarity?: number;
};

type Case = {
  name: string;
  expected?: CandidateAction;
  candidate: MemoryFixture;
  existing?: MemoryFixture;
  // Multi-match case: asserts usableMatches()'s filtering and ordering directly.
  matches?: MemoryFixture[];
  // Expected contents of the usable matches, best-first.
  expectUsableMatchContents?: string[];
  // Single-match assertions: does the candidate reach a usable match at all, and does the
  // deterministic heuristic defer to the LLM for it?
  expectUsableMatch?: boolean;
  expectNeedsLlm?: boolean;
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
    similarity: input.similarity ?? 0,
    score: input.similarity ?? 0,
    score_details: { semantic: input.similarity ?? 0, keyword: 0, entity: 0, metadata: 0, source: 'vector' },
  };
}

const failures: Array<{ name: string; detail: string }> = [];

cases.forEach((item, index) => {
  const input = candidate(item.candidate);

  if (item.matches) {
    const matches = item.matches.map((fixture, position) => existing(fixture, index * 100 + position));
    const usable = usableMatches(input, matches);
    const actualContents = usable.map((entry) => entry.match.content);
    const expectedContents = item.expectUsableMatchContents ?? [];
    if (JSON.stringify(actualContents) !== JSON.stringify(expectedContents)) {
      failures.push({ name: item.name, detail: `usableMatches expected ${JSON.stringify(expectedContents)}, got ${JSON.stringify(actualContents)}` });
    }
    const scores = usable.map((entry) => entry.score);
    if (scores.some((score, position) => position > 0 && score > scores[position - 1])) {
      failures.push({ name: item.name, detail: `usableMatches not sorted best-first: ${JSON.stringify(scores)}` });
    }
    // The single-result helper must never disagree with the plural one — they share one gate.
    if (bestUsableMatch(input, matches) !== usable[0]?.match) {
      failures.push({ name: item.name, detail: 'bestUsableMatch disagrees with usableMatches[0].match' });
    }
    return;
  }

  const match = item.existing ? existing(item.existing, index) : undefined;

  if (item.expected) {
    const actual = heuristicDecision(input, match);
    if (actual.action !== item.expected) {
      failures.push({ name: item.name, detail: `expected ${item.expected}, got ${actual.action} (${actual.reason})` });
    }
  }

  if (item.expectUsableMatch !== undefined) {
    const actual = bestUsableMatch(input, [match]) !== undefined;
    if (actual !== item.expectUsableMatch) {
      failures.push({ name: item.name, detail: `expectUsableMatch ${item.expectUsableMatch}, got ${actual}` });
    }
  }

  if (item.expectNeedsLlm !== undefined) {
    const actual = needsLlmDecision(input, bestUsableMatch(input, [match]));
    if (actual !== item.expectNeedsLlm) {
      failures.push({ name: item.name, detail: `expectNeedsLlm ${item.expectNeedsLlm}, got ${actual}` });
    }
  }
});

console.log(`candidate eval: ${cases.length - failures.length}/${cases.length} passed`);

if (failures.length > 0) {
  console.log('fail:');
  for (const failure of failures) {
    console.log(`- ${failure.name}: ${failure.detail}`);
  }
  process.exit(1);
}
