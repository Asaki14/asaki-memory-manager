// Pi half of `npm run eval:session-inject`: exercises the SHIPPED integrations/pi/asaki-memory.ts
// end-to-end with stubbed Pi host modules (scripts/pi-host-stubs.mjs) and a stubbed fetch.
//
// What it proves, none of which tsc can:
//  1. the project digest reaches the MODEL — it is in the systemPrompt returned by
//     `before_agent_start`, not merely in the transcript-local `session_start` banner entry;
//  2. the injected order is base system prompt → precheck → standing rules → project digest;
//  3. a whole session start costs ONE /v1/memories/list — including when `session_start` and
//     `before_agent_start` overlap (the loader's in-flight promise is shared, not just its value);
//  4. the switches and the dynamic kind complement behave (digest off, standing off + digest on,
//     ASAKI_MEMORY_STANDING_RULES_KINDS=rule pushing preference into the digest);
//  5. the banner field/omission matrix, on the pure builder from `// #region asaki-banner`;
//  6. the auto-inject display boundaries (8 short results vs one oversized first result) and that
//     the request carries the validated top_k AND min_score.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transform } from 'esbuild';
import { registerPiHostStubs } from './pi-host-stubs.mjs';

registerPiHostStubs();

// The extension uses TypeScript parameter properties, which node's strip-only mode rejects, so
// the SHIPPED source text is transpiled (not rewritten) and imported from a temp file. Its bare
// imports of the Pi host modules still resolve through the stub hooks registered above.
const piSourcePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'integrations', 'pi', 'asaki-memory.ts');
const transpiled = await transform(readFileSync(piSourcePath, 'utf8'), { loader: 'ts', format: 'esm', target: 'node22' });
const extensionDir = mkdtempSync(join(tmpdir(), 'asaki-pi-extension-'));
const extensionPath = join(extensionDir, 'asaki-memory.mjs');
writeFileSync(extensionPath, transpiled.code);
process.on('exit', () => rmSync(extensionDir, { recursive: true, force: true }));

const failures = [];
let checks = 0;

function check(label, expected, actual) {
  checks += 1;
  if (actual !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function checkTrue(label, condition) {
  checks += 1;
  if (!condition) failures.push(label);
}

const MEMORIES = [
  { id: 'r1', scope: 'global', kind: 'rule', status: 'active', importance: 0.9, updated_at: '2026-01-03T00:00:00.000Z', content: '规则一' },
  { id: 'p1', scope: 'global', kind: 'preference', status: 'active', importance: 0.8, updated_at: '2026-01-02T00:00:00.000Z', content: '偏好一' },
  { id: 'd1', scope: 'global', kind: 'decision', status: 'active', importance: 0.7, updated_at: '2026-01-01T00:00:00.000Z', content: '决策一' },
  {
    id: 'b1',
    scope: 'project',
    project_id: 'proj',
    kind: 'bug_fix',
    status: 'active',
    importance: 0.6,
    updated_at: '2026-01-01T00:00:00.000Z',
    content: '修复一',
  },
];

const calls = [];
let failFetch = false;

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

globalThis.fetch = async (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : null;
  calls.push({ url: String(url), body });
  if (failFetch) throw new Error('network down');
  if (String(url).endsWith('/v1/memories/list')) return jsonResponse({ memories: MEMORIES });
  if (String(url).endsWith('/v1/memories/reviews/list')) return jsonResponse({ reviews: [{ id: 'rev1' }, { id: 'rev2' }], pending_count: 113 });
  if (String(url).endsWith('/v1/memories/search')) return jsonResponse({ results: searchResults });
  return jsonResponse({});
};

let searchResults = [];

process.env.ASAKI_MEMORY_BASE_URL = 'http://127.0.0.1:9';  // loopback: the extension refuses non-https elsewhere
process.env.ASAKI_MEMORY_API_KEY = 'test-key';
process.env.ASAKI_MEMORY_USER_ID = 'asaki';
process.env.ASAKI_MEMORY_PROJECT_ID = 'proj';
process.env.PI_CODING_AGENT_DIR = '/nonexistent-pi-agent-dir';
delete process.env.ASAKI_MEMORY_STANDING_RULES;
delete process.env.ASAKI_MEMORY_STANDING_RULES_KINDS;
delete process.env.ASAKI_MEMORY_PROJECT_DIGEST;

const extension = await import(pathToFileURL(extensionPath).href);

const handlers = new Map();
const entries = [];
const pi = {
  registerMessageRenderer: () => {},
  registerEntryRenderer: () => {},
  registerCommand: () => {},
  registerTool: () => {},
  on: (name, handler) => handlers.set(name, handler),
  appendEntry: (type, data) => entries.push({ type, data }),
};
extension.default(pi);

for (const name of ['session_start', 'before_agent_start', 'session_before_switch']) {
  checkTrue(`extension registers the ${name} handler`, handlers.has(name));
}

const ctx = { cwd: process.cwd(), hasUI: true, signal: undefined, ui: { notify: () => {} }, isIdle: () => true };

function listCalls() {
  return calls.filter((call) => call.url.endsWith('/v1/memories/list'));
}

async function freshSession() {
  await handlers.get('session_before_switch')({}, ctx);
  calls.length = 0;
  entries.length = 0;
}

async function runBeforeAgentStart(prompt = '请继续之前的决策') {
  return handlers.get('before_agent_start')({ prompt, systemPrompt: 'BASE_SYSTEM_PROMPT' }, ctx);
}

// --- 1/2/3: sequential session start, injected order, one list ------------------------------
await freshSession();
await handlers.get('session_start')({}, ctx);
const sequential = await runBeforeAgentStart();
const prompt = sequential.systemPrompt;

check('sequential session start issues exactly one /v1/memories/list', 1, listCalls().length);
check(
  'sequential session start issues exactly one /v1/memories/reviews/list',
  1,
  calls.filter((call) => call.url.endsWith('/v1/memories/reviews/list')).length,
);
checkTrue('systemPrompt keeps the base prompt', prompt.startsWith('BASE_SYSTEM_PROMPT'));
checkTrue('systemPrompt contains the standing-rule block', prompt.includes('## Asaki Standing Rules'));
checkTrue('systemPrompt contains the project digest', prompt.includes('## Asaki Project Memory'));
const order = ['BASE_SYSTEM_PROMPT', 'Asaki memory precheck', '## Asaki Standing Rules', '## Asaki Project Memory'].map((needle) =>
  prompt.indexOf(needle),
);
checkTrue(`injected order is base → precheck → standing → digest (got offsets ${order.join(',')})`, order.every((offset, index) => index === 0 || offset > order[index - 1]));
checkTrue('the digest is NOT limited to the transcript banner entry', entries.some((entry) => entry.type === 'asaki-memory-banner'));
checkTrue('the standing block carries rule/preference only', /- \[global\/rule\] 规则一/.test(prompt) && /- \[global\/preference\] 偏好一/.test(prompt));
const digestBlock = prompt.slice(prompt.indexOf('## Asaki Project Memory'));
checkTrue('the digest carries the non-standing kinds', digestBlock.includes('- [global/decision] 决策一') && digestBlock.includes('- [project/bug_fix] 修复一'));
checkTrue('the digest excludes standing kinds', !digestBlock.includes('/rule]') && !digestBlock.includes('/preference]'));

// --- 3b: overlapping session_start / before_agent_start still costs one list ----------------
await freshSession();
const [, overlapped] = await Promise.all([handlers.get('session_start')({}, ctx), runBeforeAgentStart()]);
check('overlapping session start still issues exactly one /v1/memories/list', 1, listCalls().length);
checkTrue('the overlapping run still injects both blocks', overlapped.systemPrompt.includes('## Asaki Standing Rules') && overlapped.systemPrompt.includes('## Asaki Project Memory'));

// --- 4: switches and the dynamic kind complement --------------------------------------------
process.env.ASAKI_MEMORY_PROJECT_DIGEST = '0';
await freshSession();
const digestOff = await runBeforeAgentStart();
checkTrue('ASAKI_MEMORY_PROJECT_DIGEST=0 removes the digest', !digestOff.systemPrompt.includes('## Asaki Project Memory'));
checkTrue('ASAKI_MEMORY_PROJECT_DIGEST=0 keeps the standing rules', digestOff.systemPrompt.includes('## Asaki Standing Rules'));
checkTrue('a disabled digest leaves no dangling blank block', !/\n{3}/.test(digestOff.systemPrompt));
delete process.env.ASAKI_MEMORY_PROJECT_DIGEST;

process.env.ASAKI_MEMORY_STANDING_RULES = '0';
process.env.ASAKI_MEMORY_STANDING_RULES_KINDS = 'rule';
await freshSession();
const standingOff = await runBeforeAgentStart();
checkTrue('ASAKI_MEMORY_STANDING_RULES=0 removes the standing block', !standingOff.systemPrompt.includes('## Asaki Standing Rules'));
checkTrue('standing off + digest on keeps the digest', standingOff.systemPrompt.includes('## Asaki Project Memory'));
checkTrue('STANDING_RULES_KINDS=rule moves preference into the digest', standingOff.systemPrompt.includes('- [global/preference] 偏好一'));
checkTrue('the digest still excludes the configured standing kind', !standingOff.systemPrompt.includes('- [global/rule] 规则一'));
delete process.env.ASAKI_MEMORY_STANDING_RULES;
delete process.env.ASAKI_MEMORY_STANDING_RULES_KINDS;

// --- list failure degrades both blocks, banner keeps its fallbacks --------------------------
await freshSession();
failFetch = true;
const degraded = await runBeforeAgentStart();
await handlers.get('session_start')({}, ctx);
failFetch = false;
check('a failed list injects neither block', 'BASE_SYSTEM_PROMPT', degraded.systemPrompt.split('\n\n')[0]);
checkTrue('a failed list injects no standing block', !degraded.systemPrompt.includes('## Asaki Standing Rules'));
checkTrue('a failed list injects no digest', !degraded.systemPrompt.includes('## Asaki Project Memory'));
const degradedBanner = entries.find((entry) => entry.type === 'asaki-memory-banner');
checkTrue('a failed fetch still renders a banner', Boolean(degradedBanner));
if (degradedBanner) {
  const line = String(degradedBanner.data).split('\n')[1];
  checkTrue(`the degraded banner omits standingRules/projectDigest (got: ${line})`, !line.includes('standingRules') && !line.includes('projectDigest'));
  checkTrue(`the degraded banner has no autoExtract field (got: ${line})`, !line.includes('autoExtract'));
  checkTrue(`the degraded banner has no dangling separator (got: ${line})`, !/\|\s*\|/.test(line) && !/\|\s*$/.test(line));
}

// --- the real banner path -------------------------------------------------------------------
await freshSession();
await handlers.get('session_start')({}, ctx);
const bannerEntry = entries.find((entry) => entry.type === 'asaki-memory-banner');
const bannerLine = bannerEntry ? String(bannerEntry.data).split('\n')[1] : '';
check(
  'the banner prints the fixed field order with counts',
  'user=asaki | project=proj | memories=4 | pendingReviews=113 | classifier=on model=claude-test | standingRules=2/2 | projectDigest=2/2',
  bannerLine.replace(/classifier=on model=[^|]*/, 'classifier=on model=claude-test '),
);
checkTrue('the banner has no autoExtract field', !bannerLine.includes('autoExtract'));

// --- 5: banner field/omission matrix on the pure builder ------------------------------------
const { loadPiBanner, loadPiAutoInject } = await import('./pi-trace-region.mjs');
const banner = await loadPiBanner();
const { buildSessionBannerLine, bannerBlockField } = banner.module;

check('bannerBlockField omits a disabled block', null, bannerBlockField(false, { shown: 3, eligible: 9 }));
check('bannerBlockField omits an unfetchable block', null, bannerBlockField(true, null));
check('bannerBlockField omits an empty block', null, bannerBlockField(true, { shown: 0, eligible: 0 }));
check('bannerBlockField renders N/M', '3/9', bannerBlockField(true, { shown: 3, eligible: 9 }));

// Shared with the bash half: the same states are rendered by asaki_banner_line() in
// integrations/claude-code/session-start.sh and compared byte for byte.
const matrix = [
  { label: 'all-on', state: { userId: 'asaki', project: 'proj', memories: '90', pendingReviews: '3', classifier: 'on model=m', standingRules: '25/25', projectDigest: '10/65' } },
  { label: 'classifier-off', state: { userId: 'asaki', project: 'proj', memories: '90', pendingReviews: '3', classifier: null, standingRules: '25/25', projectDigest: '10/65' } },
  { label: 'standing-omitted', state: { userId: 'asaki', project: 'proj', memories: '90', pendingReviews: '3', classifier: 'on model=m', standingRules: null, projectDigest: '10/65' } },
  { label: 'digest-omitted', state: { userId: 'asaki', project: 'proj', memories: '90', pendingReviews: '3', classifier: 'on model=m', standingRules: '25/25', projectDigest: null } },
  { label: 'both-omitted', state: { userId: 'asaki', project: 'proj', memories: '90', pendingReviews: '3', classifier: 'on model=m', standingRules: null, projectDigest: null } },
  { label: 'fetch-failed', state: { userId: 'asaki', project: 'proj', memories: '?', pendingReviews: '?', classifier: 'on model=m', standingRules: null, projectDigest: null } },
  { label: 'no-project', state: { userId: 'asaki', project: 'unknown', memories: '0', pendingReviews: '0', classifier: 'on model=m', standingRules: null, projectDigest: null } },
  { label: 'setup-required', state: { userId: 'asaki', project: 'proj', auth: 'none', classifier: 'on model=m' } },
  { label: 'setup-required-no-classifier', state: { userId: 'asaki', project: 'proj', auth: 'none', classifier: null } },
];

const matrixLines = [];
for (const row of matrix) {
  const line = buildSessionBannerLine(row.state);
  matrixLines.push(`${row.label}\t${line}`);
  checkTrue(`matrix ${row.label}: no dangling separator (${line})`, !/\|\s*\|/.test(line) && !/\|\s*$/.test(line));
  checkTrue(`matrix ${row.label}: no autoExtract (${line})`, !line.includes('autoExtract'));
  const names = line.split(' | ').map((field) => field.split('=')[0]);
  const expectedOrder = ['user', 'project', 'auth', 'memories', 'pendingReviews', 'classifier', 'standingRules', 'projectDigest'];
  const positions = names.map((name) => expectedOrder.indexOf(name));
  checkTrue(`matrix ${row.label}: fields are known and ordered (${names.join(',')})`, positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])));
}
banner.dispose();

if (process.env.ASAKI_BANNER_MATRIX_OUT) writeFileSync(process.env.ASAKI_BANNER_MATRIX_OUT, `${matrixLines.join('\n')}\n`);

// --- 6: auto-inject request fields and display boundaries -----------------------------------
process.env.ASAKI_MEMORY_AUTO_INJECT = '1';
process.env.ASAKI_MEMORY_AUTO_INJECT_ALWAYS = '1';
process.env.ASAKI_MEMORY_AUTO_INJECT_TOP_K = '8';
process.env.ASAKI_MEMORY_AUTO_MIN_SCORE = '.5';
searchResults = Array.from({ length: 8 }, (_, index) => ({
  content: `短记忆 ${index}`,
  score: 0.9 - index * 0.01,
  scope: 'global',
  kind: 'fact',
}));

await freshSession();
const withSearch = await runBeforeAgentStart('之前关于这个项目的决策是什么？请回忆一下');
const searchCall = calls.find((call) => call.url.endsWith('/v1/memories/search'));
checkTrue('auto-inject issues a search call', Boolean(searchCall));
check('auto-inject sends the validated top_k', 8, searchCall?.body?.top_k);
check('auto-inject sends the validated min_score', 0.5, searchCall?.body?.min_score);
checkTrue('8 short results are all shown', String(withSearch.message?.content ?? '').includes('injected 8/8'));
check('8 short results produce 8 lines', 8, String(withSearch.message?.content ?? '').split('\n').filter((line) => line.startsWith('- ')).length);

process.env.ASAKI_MEMORY_AUTO_INJECT_TOP_K = '999999999999999999999999';
searchResults = [{ content: '超长'.repeat(5000), score: 0.95, scope: 'global', kind: 'fact' }, ...searchResults];
await freshSession();
const withOversized = await runBeforeAgentStart('之前关于这个项目的决策是什么？请回忆一下');
const oversizedCall = calls.find((call) => call.url.endsWith('/v1/memories/search'));
check('an absurd top_k clamps to the client cap', 20, oversizedCall?.body?.top_k);
const oversizedContext = String(withOversized.message?.content ?? '');
checkTrue('the oversized first result is truncated per item, so every line still fits', oversizedContext.split('\n').every((line) => line.length <= 6000));
checkTrue('the oversized run still shows the remaining short results', oversizedContext.includes('injected 9/9'));

const autoInject = await loadPiAutoInject();
const { formatAutoMemoryLines, formatAutoMemoryContext, MAX_TOOL_OUTPUT_CHARS } = autoInject.module;
check('formatAutoMemoryLines honours topK', 3, formatAutoMemoryLines(searchResults, 0.5, 3).length);
check('formatAutoMemoryLines drops sub-threshold results', 0, formatAutoMemoryLines(searchResults, 0.99, 8).length);
// Each line is clamped to MEMORY_CONTEXT_CONTENT_CHARS (280) first, so it takes many results —
// not one huge one — to reach the 6000-char output budget.
const budgeted = formatAutoMemoryContext(
  Array.from({ length: 40 }, (_, index) => ({ content: `长记忆 ${index} ${'长'.repeat(400)}`, score: 0.9, scope: 'global', kind: 'fact' })),
  0.5,
  40,
);
checkTrue('a per-item clamp keeps the block within the output budget', budgeted.length <= MAX_TOOL_OUTPUT_CHARS + 400);
checkTrue('a truncated block reports the budget footer', budgeted.includes('output budget reached'));
autoInject.dispose();

console.log(`session-inject eval (pi): ${checks} checks, ${failures.length} failure(s)`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`- FAIL ${failure}`);
  process.exit(1);
}
