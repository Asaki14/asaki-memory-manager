// Loads pure regions of the OMP extension as executable modules for contract evals.
// The extension imports OMP host packages that this repo does not install as runtime dependencies,
// so the pure regions are extracted from the real source and imported with their Node builtins.
// This keeps the shared-region checks on shipped source rather than copied implementations.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OMP_SOURCE = join(ROOT, 'integrations', 'omp', 'asaki-memory.ts');

const EXPORTED = [
  'SENSITIVE_RE_LIST',
  'TRACE_SENSITIVE_RE_LIST',
  'OMP_TRACE_TOOLS',
  'CORRECTION_SIGNAL_RE',
  'PRIOR_BLOCK_HEADER',
  'CURRENT_DELTA_DELIMITER',
  'containsSensitiveText',
  'containsTraceSensitiveText',
  'redactTraceToken',
  'redactTraceCommand',
  'traceLineForToolCall',
  'extractToolCalls',
  'buildExtractionText',
];

export function extractOmpRegions(name, source = readFileSync(OMP_SOURCE, 'utf8')) {
  const marker = new RegExp(`// #region ${name}\\n([\\s\\S]*?)\\n// #endregion`, 'g');
  const regions = [...source.matchAll(marker)].map((m) => m[1]);
  if (regions.length === 0) throw new Error(`no \`// #region ${name}\` block found in integrations/omp/asaki-memory.ts`);
  return regions;
}

export function extractOmpTraceRegions(source = readFileSync(OMP_SOURCE, 'utf8')) {
  return extractOmpRegions('asaki-trace-builder', source);
}

async function loadRegionModule(regions, preamble, exported) {
  const dir = mkdtempSync(join(tmpdir(), 'asaki-omp-region-'));
  const file = join(dir, 'omp-region.ts');
  writeFileSync(file, [...preamble, ...regions, `export { ${exported.join(', ')} };`].join('\n\n'));
  try {
    const module = await import(pathToFileURL(file).href);
    return { module, dispose: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// Returns { module, dispose } for the review-formatter region (plan E9, plus the lifecycle-report
// renderer that shares the region). The region is dependency-free, so it needs no preamble.
export async function loadOmpReviewFormatter() {
  return loadRegionModule(extractOmpRegions('asaki-review-format'), [], ['formatReviewLine', 'correctionBlockLines', 'formatLifecycleReport']);
}

// Returns the project-context region as a live module. Mirrors
// integrations/claude-code/project-context.mjs; `npm run eval:project-context` runs one table
// against both so the two cannot drift apart semantically.
export async function loadOmpProjectContext() {
  const { module } = await loadRegionModule(
    extractOmpRegions('asaki-project-context'),
    [
      'import { execFileSync } from "node:child_process";',
      'import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";',
      'import { basename, dirname, join, resolve } from "node:path";',
    ],
    [
      'parseTaskMeta',
      'canonicalProjectId',
      'isOrchestratorHost',
      'collectTaskTargets',
      'buildProjectContext',
      'renderProjectContextBlock',
      'resolveCandidateProjectId',
    ],
  );
  return module;
}

// Returns the numeric env parsers (`// #region asaki-env-parse`) as a live module, so
// `npm run eval:inject-env` runs the same table against the OMP source and both Claude Code hooks.
export async function loadOmpEnvParsers() {
  return loadRegionModule(extractOmpRegions('asaki-env-parse'), [], [
    'parsePositiveIntEnv',
    'parseUnitScoreEnv',
    'AUTO_INJECT_TOP_K_DEFAULT',
    'AUTO_INJECT_TOP_K_CAP',
    'PROJECT_DIGEST_MAX_CAP',
    'PROJECT_DIGEST_MAX_CHARS_CAP',
    'PROJECT_DIGEST_CONTENT_CHARS_CAP',
  ]);
}

// Returns the pure status-banner field builder (`// #region asaki-banner`). Mirrors
// asaki_banner_line() in integrations/claude-code/session-start.sh; `npm run eval:session-inject`
// asserts the same field/omission matrix on both.
export async function loadOmpBanner() {
  return loadRegionModule(extractOmpRegions('asaki-banner'), [], ['bannerBlockField', 'buildSessionBannerLine']);
}

// Returns the auto-inject formatters (`// #region asaki-auto-inject`, two blocks: the output-budget
// constants and the formatters). They call cleanMemoryText from the trace region, so both regions
// are loaded together.
export async function loadOmpAutoInject() {
  return loadRegionModule(
    [...extractOmpRegions('asaki-auto-inject'), ...extractOmpTraceRegions()],
    ['import { homedir } from "node:os";', 'import { isAbsolute, relative, resolve, sep } from "node:path";'],
    ['MAX_TOOL_OUTPUT_CHARS', 'MEMORY_CONTEXT_CONTENT_CHARS', 'formatAutoMemoryLines', 'formatAutoMemoryContext', 'formatAutoMemoryDisplay'],
  );
}

// Returns { module, dispose } — call dispose() to remove the temp dir.
export async function loadOmpTraceBuilder() {
  return loadRegionModule(
    extractOmpTraceRegions(),
    ['import { homedir } from "node:os";', 'import { isAbsolute, relative, resolve, sep } from "node:path";'],
    EXPORTED,
  );
}
