/**
 * Project-memory digest session-start injection — canonical selection + rendering.
 *
 * The standing-rule block (src/services/standingRules.ts) injects the kinds that are
 * DIRECTIVES. Everything else used to be retrieval-only, which meant a session opened with
 * no idea what had already been decided in this project. This module renders the
 * complement: ACTIVE memories of every OTHER known kind (the dynamic complement of the
 * standing kinds, so a memory can never appear in both blocks), framed as context rather
 * than directives.
 *
 * Same visibility as standing rules: global always, project only on a project match,
 * session scope never (the clients send no session_id, so the server already excludes it).
 * Same deterministic total order: importance desc → recency desc → id desc.
 *
 * The region between the `project-digest:begin` / `project-digest:end` markers below is the
 * source of truth and is copied VERBATIM into `integrations/pi/asaki-memory.ts` (Pi ships a
 * single self-contained extension file, so it cannot import this module).
 * `integrations/claude-code/project-digest.jq` is the jq re-implementation for the Claude
 * Code SessionStart hook. `scripts/eval-project-digest.ts` asserts all three agree: it
 * byte-compares the two TS copies and diffs the jq output against this one.
 *
 * Known boundary (shared with standing rules): both clients list at most 100 memories and
 * the server returns the 100 most recently updated ones BEFORE this importance sort runs, so
 * once a user's active global+project set grows past 100 an older high-importance memory can
 * be dropped before selection ever sees it. Monitor the `memories=` banner count.
 */

// --- project-digest:begin (KEEP IN SYNC: src/services/projectDigest.ts <-> integrations/pi/asaki-memory.ts) ---
export const PROJECT_DIGEST_KNOWN_KINDS = [
  'preference',
  'rule',
  'fact',
  'decision',
  'task_learning',
  'bug_fix',
  'workflow',
] as const;
export const PROJECT_DIGEST_DEFAULT_STANDING_KINDS = ['rule', 'preference'] as const;
export const PROJECT_DIGEST_DEFAULT_MAX = 10;
export const PROJECT_DIGEST_MAX_CHARS = 3000;
export const PROJECT_DIGEST_CONTENT_CHARS = 240;
export const PROJECT_DIGEST_PREAMBLE =
  'This is recalled context, not directives: durable memories of this project (plus global ones) that are not standing rules. They record what was already decided, learned or fixed — use them instead of re-deriving, and call asaki_memory_search when you need more than these excerpts.';

export interface ProjectDigestItem {
  id?: string | null;
  content?: string | null;
  scope?: string | null;
  kind?: string | null;
  status?: string | null;
  importance?: number | null;
  project_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ProjectDigestOptions {
  projectId?: string | null;
  standingKinds?: readonly string[];
  max?: number;
  maxChars?: number;
  contentChars?: number;
}

export interface ProjectDigestBlock {
  text: string;
  shown: number;
  eligible: number;
  truncated: boolean;
}

/**
 * The digest kinds are the DYNAMIC complement of whatever the standing block claimed, so
 * `ASAKI_MEMORY_STANDING_RULES_KINDS=rule` moves `preference` into the digest instead of
 * leaving it invisible, and no memory is ever in both blocks. Deliberately independent of
 * the two on/off switches: turning the standing block off does not turn its kinds into
 * digest context.
 */
export function projectDigestKinds(standingKinds?: readonly string[]): readonly string[] {
  const standing = standingKinds && standingKinds.length > 0 ? standingKinds : PROJECT_DIGEST_DEFAULT_STANDING_KINDS;
  return PROJECT_DIGEST_KNOWN_KINDS.filter((kind) => standing.indexOf(kind) === -1);
}

export function cleanProjectDigestText(text: string): string {
  return text
    .replace(/[\r\n]/g, ' ')
    .replace(/[\t ]+/g, ' ')
    .replace(/^ +/, '')
    .replace(/ +$/, '');
}

export function truncateProjectDigestText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

export function formatProjectDigestLine(item: ProjectDigestItem, contentChars: number): string {
  const scope = item.scope === 'global' ? 'global' : 'project';
  const kind = typeof item.kind === 'string' && item.kind ? item.kind : 'fact';
  const content = truncateProjectDigestText(cleanProjectDigestText(String(item.content ?? '')), contentChars);
  return `- [${scope}/${kind}] ${content}`;
}

export function selectProjectDigest(items: ProjectDigestItem[], options: ProjectDigestOptions = {}): ProjectDigestItem[] {
  const kinds = projectDigestKinds(options.standingKinds);
  const projectId = options.projectId ?? '';
  return items
    .filter((item) => (item.status ?? 'active') === 'active')
    .filter((item) => cleanProjectDigestText(String(item.content ?? '')).length > 0)
    .filter((item) => kinds.indexOf(typeof item.kind === 'string' ? item.kind : '') !== -1)
    .filter(
      (item) =>
        item.scope === 'global' ||
        (item.scope === 'project' && projectId.length > 0 && (item.project_id ?? '') === projectId)
    )
    .sort(compareProjectDigestAscending)
    .reverse();
}

function compareProjectDigestAscending(a: ProjectDigestItem, b: ProjectDigestItem): number {
  const aImportance = typeof a.importance === 'number' ? a.importance : 0;
  const bImportance = typeof b.importance === 'number' ? b.importance : 0;
  if (aImportance !== bImportance) return aImportance < bImportance ? -1 : 1;
  const aTime = a.updated_at ?? a.created_at ?? '';
  const bTime = b.updated_at ?? b.created_at ?? '';
  if (aTime !== bTime) return aTime < bTime ? -1 : 1;
  const aId = a.id ?? '';
  const bId = b.id ?? '';
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/**
 * Bounded twice like the standing block: at most `max` memories (default 10) and at most
 * `maxChars` of memory lines (default 3000), each clamped to `contentChars` (default 240).
 * Worst case is therefore ~3.3 KB of text — roughly 0.8k tokens of English or ~1.65k tokens
 * of Chinese. Returns an empty `text` when nothing is eligible.
 */
export function renderProjectDigestBlock(items: ProjectDigestItem[], options: ProjectDigestOptions = {}): ProjectDigestBlock {
  const max = typeof options.max === 'number' && options.max > 0 ? Math.floor(options.max) : PROJECT_DIGEST_DEFAULT_MAX;
  const maxChars = typeof options.maxChars === 'number' && options.maxChars > 0 ? Math.floor(options.maxChars) : PROJECT_DIGEST_MAX_CHARS;
  const contentChars =
    typeof options.contentChars === 'number' && options.contentChars > 0 ? Math.floor(options.contentChars) : PROJECT_DIGEST_CONTENT_CHARS;

  const eligibleItems = selectProjectDigest(items, options);
  const lines: string[] = [];
  let chars = 0;
  for (const item of eligibleItems) {
    if (lines.length >= max) break;
    const line = formatProjectDigestLine(item, contentChars);
    if (chars + line.length + 1 > maxChars && lines.length > 0) break;
    lines.push(line);
    chars += line.length + 1;
  }

  const eligible = eligibleItems.length;
  const shown = lines.length;
  if (shown === 0) return { text: '', shown: 0, eligible, truncated: false };

  const truncated = shown < eligible;
  const body = [`## Asaki Project Memory (${shown} of ${eligible})`, '', PROJECT_DIGEST_PREAMBLE, '', ...lines];
  if (truncated) {
    body.push(
      '',
      `(showing ${shown} of ${eligible} project memories — more exist; call asaki_memory_list or asaki_memory_search for the rest)`
    );
  }
  return { text: body.join('\n'), shown, eligible, truncated };
}
// --- project-digest:end ---
