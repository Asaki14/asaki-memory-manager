// Loads the Pi extension's trace-builder region as a real, executable module.
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

export function extractPiTraceRegions(source = readFileSync(PI_SOURCE, 'utf8')) {
  const regions = [...source.matchAll(/\/\/ #region asaki-trace-builder\n([\s\S]*?)\n\/\/ #endregion/g)].map((m) => m[1]);
  if (regions.length === 0) throw new Error('no `// #region asaki-trace-builder` block found in integrations/pi/asaki-memory.ts');
  return regions;
}

// Returns { module, dispose } — call dispose() to remove the temp dir.
export async function loadPiTraceBuilder() {
  const regions = extractPiTraceRegions();
  const dir = mkdtempSync(join(tmpdir(), 'asaki-pi-region-'));
  const file = join(dir, 'pi-trace-region.ts');
  const body = [
    'import { homedir } from "node:os";',
    'import { isAbsolute, relative, resolve, sep } from "node:path";',
    ...regions,
    `export { ${EXPORTED.join(', ')} };`,
  ].join('\n\n');
  writeFileSync(file, body);
  try {
    const module = await import(pathToFileURL(file).href);
    return { module, dispose: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
