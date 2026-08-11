/**
 * Offline eval for the session-start project-memory digest.
 *
 * Four assertions, no network and no Worker needed (mirrors scripts/eval-standing-rules.ts):
 *  1. the canonical TS (src/services/projectDigest.ts) matches the fixture expectations;
 *  2. the jq copy (integrations/claude-code/project-digest.jq) renders byte-identical blocks;
 *  3. the Pi copy (integrations/pi/asaki-memory.ts) is byte-identical to the canonical region;
 *  4. for the same memory list, the standing-rule block and the digest never share an item —
 *     under the default kinds AND under a narrowed ASAKI_MEMORY_STANDING_RULES_KINDS.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROJECT_DIGEST_CONTENT_CHARS,
  PROJECT_DIGEST_DEFAULT_MAX,
  PROJECT_DIGEST_DEFAULT_STANDING_KINDS,
  PROJECT_DIGEST_KNOWN_KINDS,
  PROJECT_DIGEST_MAX_CHARS,
  renderProjectDigestBlock,
  selectProjectDigest,
  type ProjectDigestItem,
} from '../src/services/projectDigest.ts';
import { selectStandingRules } from '../src/services/standingRules.ts';

type Case = {
  name: string;
  memories: ProjectDigestItem[];
  options?: { projectId?: string; standingKinds?: string[]; max?: number; maxChars?: number; contentChars?: number };
  expected: { shown: number; eligible: number; truncated: boolean; lines: string[] };
  expectedText?: string[];
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const canonicalPath = resolve(root, 'src/services/projectDigest.ts');
const piPath = resolve(root, 'integrations/pi/asaki-memory.ts');
const jqPath = resolve(root, 'integrations/claude-code/project-digest.jq');
const cases = JSON.parse(readFileSync(resolve(root, 'test/fixtures/project-digest-cases.json'), 'utf8')) as Case[];

const failures: string[] = [];

function region(path: string): string | null {
  const source = readFileSync(path, 'utf8');
  const begin = source.indexOf('// --- project-digest:begin');
  const end = source.indexOf('// --- project-digest:end ---');
  if (begin === -1 || end === -1) return null;
  return source.slice(begin, end);
}

function jqBlock(item: Case): string {
  const options = item.options ?? {};
  const output = execFileSync(
    'jq',
    [
      '-r',
      '--arg',
      'project',
      options.projectId ?? '',
      '--argjson',
      'standingKinds',
      JSON.stringify(options.standingKinds ?? PROJECT_DIGEST_DEFAULT_STANDING_KINDS),
      '--argjson',
      'max',
      String(options.max ?? PROJECT_DIGEST_DEFAULT_MAX),
      '--argjson',
      'maxChars',
      String(options.maxChars ?? PROJECT_DIGEST_MAX_CHARS),
      '--argjson',
      'contentChars',
      String(options.contentChars ?? PROJECT_DIGEST_CONTENT_CHARS),
      '-f',
      jqPath,
    ],
    { input: JSON.stringify({ memories: item.memories }), encoding: 'utf8' }
  );
  return output.replace(/\n$/, '');
}

for (const item of cases) {
  const actual = renderProjectDigestBlock(item.memories, item.options ?? {});
  const actualLines = actual.text ? actual.text.split('\n').filter((line) => line.startsWith('- [')) : [];

  if (actual.shown !== item.expected.shown) failures.push(`${item.name}: shown expected ${item.expected.shown}, got ${actual.shown}`);
  if (actual.eligible !== item.expected.eligible) failures.push(`${item.name}: eligible expected ${item.expected.eligible}, got ${actual.eligible}`);
  if (actual.truncated !== item.expected.truncated) failures.push(`${item.name}: truncated expected ${item.expected.truncated}, got ${actual.truncated}`);
  if (actualLines.join('\n') !== item.expected.lines.join('\n')) {
    failures.push(`${item.name}: lines expected\n${item.expected.lines.join('\n')}\ngot\n${actualLines.join('\n')}`);
  }
  if (item.expectedText && actual.text !== item.expectedText.join('\n')) {
    failures.push(`${item.name}: full text expected\n${item.expectedText.join('\n')}\ngot\n${actual.text}`);
  }

  const jqText = jqBlock(item);
  if (jqText !== actual.text) {
    failures.push(`${item.name}: jq copy diverged from the canonical TS\n--- jq ---\n${jqText}\n--- ts ---\n${actual.text}`);
  }
}

// 4. The two session-start blocks partition the visible memories: one item per known kind,
// under the default standing kinds and under a narrowed one.
const partitionList: ProjectDigestItem[] = PROJECT_DIGEST_KNOWN_KINDS.map((kind, index) => ({
  id: `p${index}`,
  scope: 'global',
  kind,
  importance: 0.5,
  updated_at: '2026-01-01T00:00:00.000Z',
  content: `记忆 ${kind}`,
}));

for (const standingKinds of [[...PROJECT_DIGEST_DEFAULT_STANDING_KINDS], ['rule'], ['rule', 'preference', 'decision']]) {
  const standingIds = selectStandingRules(partitionList, { projectId: 'proj', kinds: standingKinds }).map((item) => item.id);
  const digestIds = selectProjectDigest(partitionList, { projectId: 'proj', standingKinds }).map((item) => item.id);
  const overlap = standingIds.filter((id) => digestIds.includes(id));
  if (overlap.length > 0) {
    failures.push(`partition[standingKinds=${standingKinds.join(',')}]: standing and digest share ${overlap.join(',')}`);
  }
  const union = new Set([...standingIds, ...digestIds]);
  if (union.size !== PROJECT_DIGEST_KNOWN_KINDS.length) {
    failures.push(
      `partition[standingKinds=${standingKinds.join(',')}]: the two blocks cover ${union.size}/${PROJECT_DIGEST_KNOWN_KINDS.length} known kinds`
    );
  }
}

const canonicalRegion = region(canonicalPath);
const piRegion = region(piPath);
if (!canonicalRegion) {
  failures.push('src/services/projectDigest.ts: project-digest markers not found');
} else if (!piRegion) {
  failures.push('integrations/pi/asaki-memory.ts: project-digest markers not found (the shared region must be copied verbatim)');
} else if (canonicalRegion !== piRegion) {
  failures.push('integrations/pi/asaki-memory.ts: project-digest region drifted from src/services/projectDigest.ts');
}

console.log(`project-digest eval: ${cases.length - new Set(failures.map((f) => f.split(':')[0])).size}/${cases.length} cases passed, copies + partition checked`);

if (failures.length > 0) {
  console.log('fail:');
  for (const failure of failures) console.log(`- ${failure}`);
  process.exit(1);
}
