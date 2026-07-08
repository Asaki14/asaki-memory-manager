import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capCandidates, dedupeCandidateBatch, isAutoAddEligible, type ProcessMemoryCandidateInput } from '../src/services/candidateDecision.ts';
import type { MemoryKind, MemoryScope } from '../src/types.ts';

type ExtractedCandidate = { content: string; kind: MemoryKind; importance: number; scope: MemoryScope };

type CandidateFixture = {
  content?: string;
  kind?: MemoryKind;
  importance?: number;
  scope?: MemoryScope;
  confidence?: number;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = JSON.parse(readFileSync(resolve(root, 'test/fixtures/extraction-guardrails.json'), 'utf8')) as {
  capCandidates: Array<{ name: string; max: number; input: CandidateFixture[]; expectedContents: string[] }>;
  dedupeCandidateBatch: Array<{ name: string; input: CandidateFixture[]; expectedCount: number; expectedImportance?: number }>;
  isAutoAddEligible: Array<{ name: string; candidate: CandidateFixture; expected: boolean }>;
};

function extractedCandidate(input: CandidateFixture): ExtractedCandidate {
  return {
    content: input.content ?? '',
    kind: input.kind ?? 'fact',
    importance: input.importance ?? 0.5,
    scope: input.scope ?? 'project',
  };
}

function processCandidate(input: CandidateFixture): ProcessMemoryCandidateInput {
  return {
    content: input.content ?? '',
    user_id: 'eval-user',
    scope: input.scope ?? 'project',
    project_id: (input.scope ?? 'project') === 'project' ? 'eval-project' : null,
    session_id: null,
    kind: input.kind ?? 'fact',
    importance: input.importance ?? 0.5,
    confidence: input.confidence ?? 0.7,
    source: 'eval',
  };
}

const failures: string[] = [];
let total = 0;

for (const testCase of fixtures.capCandidates) {
  total++;
  const actual = capCandidates(testCase.input.map(extractedCandidate), testCase.max).map((item) => item.content);
  if (JSON.stringify(actual) !== JSON.stringify(testCase.expectedContents)) {
    failures.push(`capCandidates/${testCase.name}: expected ${JSON.stringify(testCase.expectedContents)}, got ${JSON.stringify(actual)}`);
  }
}

for (const testCase of fixtures.dedupeCandidateBatch) {
  total++;
  const actual = dedupeCandidateBatch(testCase.input.map(processCandidate));
  if (actual.length !== testCase.expectedCount) {
    failures.push(`dedupeCandidateBatch/${testCase.name}: expected ${testCase.expectedCount} candidate(s), got ${actual.length}`);
    continue;
  }
  if (testCase.expectedImportance !== undefined && actual[0].importance !== testCase.expectedImportance) {
    failures.push(`dedupeCandidateBatch/${testCase.name}: expected merged importance ${testCase.expectedImportance}, got ${actual[0].importance}`);
  }
}

for (const testCase of fixtures.isAutoAddEligible) {
  total++;
  const actual = isAutoAddEligible(processCandidate(testCase.candidate));
  if (actual !== testCase.expected) {
    failures.push(`isAutoAddEligible/${testCase.name}: expected ${testCase.expected}, got ${actual}`);
  }
}

console.log(`extraction guardrails eval: ${total - failures.length}/${total} passed`);

if (failures.length > 0) {
  console.log('fail:');
  for (const failure of failures) {
    console.log(`- ${failure}`);
  }
  process.exit(1);
}
