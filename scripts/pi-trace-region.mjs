// Loads pure regions of the Pi extension as real, executable modules (trace builder, review
// formatter).
//
// integrations/pi/asaki-memory.ts must stay a SINGLE file (scripts/build-pi-package.ts publishes
// exactly that one file, so it can never import a sibling), and it imports Pi host modules that
// are not dependencies of this repo — so an eval cannot simply `import()` it. Instead the pure
// region(s) marked with `// #region asaki-trace-builder` … `// #endregion` are concatenated into
// a temp .ts file, given the node builtins they use, and imported with type stripping.
//
// That keeps the eval honest: it executes the shipped source text, not a copy of it. If the
// region markers are ever removed the loader fails loudly rather than silently testing nothing.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PI_SOURCE = join(ROOT, 'integrations', 'pi', 'asaki-memory.ts');

const EXPORTED = [
  'SENSITIVE_RE_LIST',
  'TRACE_SENSITIVE_RE_LIST',
  'PI_TRACE_TOOLS',
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

export function extractPiRegions(name, source = readFileSync(PI_SOURCE, 'utf8')) {
  const marker = new RegExp(`// #region ${name}\\n([\\s\\S]*?)\\n// #endregion`, 'g');
  const regions = [...source.matchAll(marker)].map((m) => m[1]);
  if (regions.length === 0) throw new Error(`no \`// #region ${name}\` block found in integrations/pi/asaki-memory.ts`);
  return regions;
}

export function extractPiTraceRegions(source = readFileSync(PI_SOURCE, 'utf8')) {
  return extractPiRegions('asaki-trace-builder', source);
}

async function loadRegionModule(regions, preamble, exported) {
  const dir = mkdtempSync(join(tmpdir(), 'asaki-pi-region-'));
  const file = join(dir, 'pi-region.ts');
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
export async function loadPiReviewFormatter() {
  return loadRegionModule(extractPiRegions('asaki-review-format'), [], ['formatReviewLine', 'correctionBlockLines', 'formatLifecycleReport']);
}

// Returns { module, dispose } — call dispose() to remove the temp dir.
export async function loadPiTraceBuilder() {
  return loadRegionModule(
    extractPiTraceRegions(),
    ['import { homedir } from "node:os";', 'import { isAbsolute, relative, resolve, sep } from "node:path";'],
    EXPORTED,
  );
}
