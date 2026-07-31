/**
 * Offline eval for standing-rule session-start injection.
 *
 * Three assertions, no network and no Worker needed:
 *  1. the canonical TS (src/services/standingRules.ts) matches the fixture expectations;
 *  2. the jq copy (integrations/claude-code/standing-rules.jq) renders byte-identical blocks;
 *  3. the Pi copy (integrations/pi/asaki-memory.ts) is byte-identical to the canonical region.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderStandingRulesBlock,
  STANDING_RULES_CONTENT_CHARS,
  STANDING_RULES_DEFAULT_KINDS,
  STANDING_RULES_DEFAULT_MAX,
  STANDING_RULES_MAX_CHARS,
  type StandingRuleItem,
} from '../src/services/standingRules.ts';

type Case = {
  name: string;
  memories: StandingRuleItem[];
  options?: { projectId?: string; kinds?: string[]; max?: number; maxChars?: number; contentChars?: number };
  expected: { shown: number; eligible: number; truncated: boolean; lines: string[] };
  expectedText?: string[];
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const canonicalPath = resolve(root, 'src/services/standingRules.ts');
const piPath = resolve(root, 'integrations/pi/asaki-memory.ts');
const jqPath = resolve(root, 'integrations/claude-code/standing-rules.jq');
const cases = JSON.parse(readFileSync(resolve(root, 'test/fixtures/standing-rules-cases.json'), 'utf8')) as Case[];

const failures: string[] = [];

function region(path: string): string | null {
  const source = readFileSync(path, 'utf8');
  const begin = source.indexOf('// --- standing-rules:begin');
  const end = source.indexOf('// --- standing-rules:end ---');
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
      'kinds',
      JSON.stringify(options.kinds ?? STANDING_RULES_DEFAULT_KINDS),
      '--argjson',
      'max',
      String(options.max ?? STANDING_RULES_DEFAULT_MAX),
      '--argjson',
      'maxChars',
      String(options.maxChars ?? STANDING_RULES_MAX_CHARS),
      '--argjson',
      'contentChars',
      String(options.contentChars ?? STANDING_RULES_CONTENT_CHARS),
      '-f',
      jqPath,
    ],
    { input: JSON.stringify({ memories: item.memories }), encoding: 'utf8' }
  );
  return output.replace(/\n$/, '');
}

for (const item of cases) {
  const actual = renderStandingRulesBlock(item.memories, item.options ?? {});
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

const canonicalRegion = region(canonicalPath);
const piRegion = region(piPath);
if (!canonicalRegion) {
  failures.push('src/services/standingRules.ts: standing-rules markers not found');
} else if (!piRegion) {
  failures.push('integrations/pi/asaki-memory.ts: standing-rules markers not found (the shared region must be copied verbatim)');
} else if (canonicalRegion !== piRegion) {
  failures.push('integrations/pi/asaki-memory.ts: standing-rules region drifted from src/services/standingRules.ts');
}

console.log(`standing-rules eval: ${cases.length - new Set(failures.map((f) => f.split(':')[0])).size}/${cases.length} cases passed, copies checked`);

if (failures.length > 0) {
  console.log('fail:');
  for (const failure of failures) console.log(`- ${failure}`);
  process.exit(1);
}
