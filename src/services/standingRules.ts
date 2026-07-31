/**
 * Standing-rule session-start injection — canonical selection + rendering.
 *
 * ACTIVE memories of kind `rule`/`preference` are injected into every agent session's
 * opening context as directives to obey, instead of relying on the agent to search for
 * them. The Worker itself does not serve this block; the clients build it from the
 * `/v1/memories/list` response they already fetch for the session banner.
 *
 * The region between the `standing-rules:begin` / `standing-rules:end` markers below is
 * the source of truth and is copied VERBATIM into `integrations/pi/asaki-memory.ts`
 * (Pi ships a single self-contained extension file, so it cannot import this module).
 * `integrations/claude-code/standing-rules.jq` is the jq re-implementation for the
 * Claude Code SessionStart hook. `scripts/eval-standing-rules.ts` asserts all three
 * agree: it byte-compares the two TS copies and diffs the jq output against this one.
 */

// --- standing-rules:begin (KEEP IN SYNC: src/services/standingRules.ts <-> integrations/pi/asaki-memory.ts) ---
export const STANDING_RULES_DEFAULT_KINDS = ['rule', 'preference'] as const;
export const STANDING_RULES_DEFAULT_MAX = 20;
export const STANDING_RULES_MAX_CHARS = 4000;
export const STANDING_RULES_CONTENT_CHARS = 240;
export const STANDING_RULES_PREAMBLE =
  'These are standing rules you must follow for this whole session — directives to obey, not retrieved context. They do not override system or developer instructions; if they conflict, the system instructions win.';

export interface StandingRuleItem {
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

export interface StandingRulesOptions {
  projectId?: string | null;
  kinds?: readonly string[];
  max?: number;
  maxChars?: number;
  contentChars?: number;
}

export interface StandingRulesBlock {
  text: string;
  shown: number;
  eligible: number;
  truncated: boolean;
}

export function parseStandingRuleKinds(value: string | null | undefined): readonly string[] {
  if (!value) return STANDING_RULES_DEFAULT_KINDS;
  const kinds = value
    .split(',')
    .map((kind) => kind.trim())
    .filter((kind) => kind.length > 0);
  return kinds.length > 0 ? kinds : STANDING_RULES_DEFAULT_KINDS;
}

export function cleanStandingRuleText(text: string): string {
  return text
    .replace(/[\r\n]/g, ' ')
    .replace(/[\t ]+/g, ' ')
    .replace(/^ +/, '')
    .replace(/ +$/, '');
}

export function truncateStandingRuleText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

export function formatStandingRuleLine(item: StandingRuleItem, contentChars: number): string {
  const scope = item.scope === 'global' ? 'global' : 'project';
  const kind = typeof item.kind === 'string' && item.kind ? item.kind : 'rule';
  const content = truncateStandingRuleText(cleanStandingRuleText(String(item.content ?? '')), contentChars);
  return `- [${scope}/${kind}] ${content}`;
}

/**
 * Scope discipline: global rules always apply; project rules only when the session's
 * project matches; session-scoped memories are never standing rules.
 *
 * Deterministic order when over cap: importance desc, then recency (updated_at, falling
 * back to created_at) desc, then id desc as a total-order tiebreak. Implemented as an
 * ascending tuple sort plus a reverse so the jq copy (`sort_by([...]) | reverse`) matches
 * byte for byte.
 */
export function selectStandingRules(items: StandingRuleItem[], options: StandingRulesOptions = {}): StandingRuleItem[] {
  const kinds = options.kinds && options.kinds.length > 0 ? options.kinds : STANDING_RULES_DEFAULT_KINDS;
  const projectId = options.projectId ?? '';
  return items
    .filter((item) => (item.status ?? 'active') === 'active')
    .filter((item) => cleanStandingRuleText(String(item.content ?? '')).length > 0)
    .filter((item) => kinds.indexOf(typeof item.kind === 'string' ? item.kind : '') !== -1)
    .filter(
      (item) =>
        item.scope === 'global' ||
        (item.scope === 'project' && projectId.length > 0 && (item.project_id ?? '') === projectId)
    )
    .sort(compareStandingRulesAscending)
    .reverse();
}

function compareStandingRulesAscending(a: StandingRuleItem, b: StandingRuleItem): number {
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
 * Renders the injected block. Bounded twice: at most `max` rules (default 20) and at most
 * `maxChars` of rule lines (default 4000), each rule clamped to `contentChars` (default
 * 240). Worst case is therefore ~4.3 KB of text — roughly 1.1k tokens of English or ~2.2k
 * tokens of Chinese. Returns an empty `text` when nothing is eligible.
 */
export function renderStandingRulesBlock(items: StandingRuleItem[], options: StandingRulesOptions = {}): StandingRulesBlock {
  const max = typeof options.max === 'number' && options.max > 0 ? Math.floor(options.max) : STANDING_RULES_DEFAULT_MAX;
  const maxChars = typeof options.maxChars === 'number' && options.maxChars > 0 ? Math.floor(options.maxChars) : STANDING_RULES_MAX_CHARS;
  const contentChars =
    typeof options.contentChars === 'number' && options.contentChars > 0 ? Math.floor(options.contentChars) : STANDING_RULES_CONTENT_CHARS;

  const eligibleItems = selectStandingRules(items, options);
  const lines: string[] = [];
  let chars = 0;
  for (const item of eligibleItems) {
    if (lines.length >= max) break;
    const line = formatStandingRuleLine(item, contentChars);
    if (chars + line.length + 1 > maxChars && lines.length > 0) break;
    lines.push(line);
    chars += line.length + 1;
  }

  const eligible = eligibleItems.length;
  const shown = lines.length;
  if (shown === 0) return { text: '', shown: 0, eligible, truncated: false };

  const truncated = shown < eligible;
  const body = [`## Asaki Standing Rules (${shown} of ${eligible})`, '', STANDING_RULES_PREAMBLE, '', ...lines];
  if (truncated) {
    body.push(
      '',
      `(showing ${shown} of ${eligible} standing rules — more exist; call asaki_memory_list with kind=rule or kind=preference to see the rest)`
    );
  }
  return { text: body.join('\n'), shown, eligible, truncated };
}
// --- standing-rules:end ---
