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
 * be dropped before selection ever sees it — the id index below makes that gap visible (a
 * memory missing from BOTH the expanded lines and the index was never listed) but does not
 * close it. Monitor the `memories=` banner count.
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
export const PROJECT_DIGEST_MAX_CHARS = 6000;
export const PROJECT_DIGEST_CONTENT_CHARS = 240;

// The compact id index: the eligible memories the block could NOT expand, rendered as
// `- <id> [scope/kind] <excerpt> (N chars)` instead of the one-sentence "more exist" marker.
// Knowing an id is what makes an unexpanded memory addressable — `asaki_memory_get(ids)` reads it
// in full — and the trailing character count is the fetch-cost hint the agent budgets against.
// Bounded independently of the expanded lines (30 rows / 2000 chars) and additionally clamped to
// whatever is left of `maxChars`, so the whole block stays inside one budget.
export const PROJECT_DIGEST_INDEX_MAX = 30;
export const PROJECT_DIGEST_INDEX_MAX_CHARS = 2000;
export const PROJECT_DIGEST_INDEX_CONTENT_CHARS = 48;
export const PROJECT_DIGEST_PREAMBLE =
  'This is recalled context, not directives: durable memories of this project (plus global ones) that are not standing rules. They record what was already decided, learned or fixed — use them instead of re-deriving. Entries listed by id only are not expanded here: call asaki_memory_get with those ids to read them in full, and asaki_memory_search when you need more than these excerpts.';

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
  index?: boolean;
  indexMax?: number;
  indexMaxChars?: number;
  indexContentChars?: number;
}

export interface ProjectDigestBlock {
  text: string;
  shown: number;
  eligible: number;
  truncated: boolean;
  indexed: number;
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

/**
 * One index row: id first (it is the only part an agent can act on), then the same
 * `[scope/kind]` tag the expanded lines carry, a short excerpt, and the FULL content length in
 * characters — not an estimated token count, which `chars/4` gets badly wrong for Chinese.
 */
export function formatProjectDigestIndexLine(item: ProjectDigestItem, contentChars: number): string {
  const scope = item.scope === 'global' ? 'global' : 'project';
  const kind = typeof item.kind === 'string' && item.kind ? item.kind : 'fact';
  const content = cleanProjectDigestText(String(item.content ?? ''));
  return `- ${item.id} [${scope}/${kind}] ${truncateProjectDigestText(content, contentChars)} (${content.length} chars)`;
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
 * `maxChars` of block text (default 6000), each expanded line clamped to `contentChars`
 * (default 240). Whatever `max` cut off is then listed as compact id index rows inside the same
 * `maxChars` budget and its own 30-row / 2000-char cap, so every eligible memory stays
 * addressable via `asaki_memory_get` even when only 10 of them are expanded. Set `index: false`
 * to fall back to the old one-sentence "more exist" marker. Returns an empty `text` when nothing
 * is eligible.
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
  if (shown === 0) return { text: '', shown: 0, eligible, truncated: false, indexed: 0 };

  const truncated = shown < eligible;
  const body = [`## Asaki Project Memory (${shown} of ${eligible})`, '', PROJECT_DIGEST_PREAMBLE, '', ...lines];
  const indexLines: string[] = [];
  if (truncated && options.index !== false) {
    const indexMax = typeof options.indexMax === 'number' && options.indexMax > 0 ? Math.floor(options.indexMax) : PROJECT_DIGEST_INDEX_MAX;
    const indexMaxChars =
      typeof options.indexMaxChars === 'number' && options.indexMaxChars > 0 ? Math.floor(options.indexMaxChars) : PROJECT_DIGEST_INDEX_MAX_CHARS;
    const indexContentChars =
      typeof options.indexContentChars === 'number' && options.indexContentChars > 0
        ? Math.floor(options.indexContentChars)
        : PROJECT_DIGEST_INDEX_CONTENT_CHARS;
    // An id-less row cannot be fetched, so indexing it would only cost context.
    const rest = eligibleItems.slice(shown).filter((item) => typeof item.id === 'string' && item.id.length > 0);
    const indexBudget = Math.min(indexMaxChars, Math.max(0, maxChars - chars));
    let indexChars = 0;
    for (const item of rest) {
      if (indexLines.length >= indexMax) break;
      const line = formatProjectDigestIndexLine(item, indexContentChars);
      if (indexChars + line.length + 1 > indexBudget) break;
      indexLines.push(line);
      indexChars += line.length + 1;
    }
  }

  const indexed = indexLines.length;
  if (indexed > 0) {
    body.push(
      '',
      `(showing ${shown} of ${eligible} project memories in full; the next ${indexed} are indexed below — call asaki_memory_get with those ids to read them)`,
      ...indexLines
    );
    const unlisted = eligible - shown - indexed;
    if (unlisted > 0) {
      body.push(`(… and ${unlisted} more not listed; call asaki_memory_list or asaki_memory_search for the rest)`);
    }
  } else if (truncated) {
    body.push(
      '',
      `(showing ${shown} of ${eligible} project memories — more exist; call asaki_memory_list or asaki_memory_search for the rest)`
    );
  }
  return { text: body.join('\n'), shown, eligible, truncated, indexed };
}
// --- project-digest:end ---
