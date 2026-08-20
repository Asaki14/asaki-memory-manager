// Remote MCP endpoint (Streamable HTTP, stateless JSON-RPC subset).
//
// Exposes the same tool surface as the stdio server in integrations/mcp/asaki-memory.ts,
// but hosted inside the Worker so clients that support remote HTTP MCP (e.g. Claude Code)
// need no local node process or repo checkout. Tool calls are bridged to the existing
// /v1/* REST routes via app.fetch() so validation, rate limiting, the sensitive-content
// gate, and services stay the single source of truth — this file only owns the JSON-RPC
// envelope, the tool schemas, and output formatting (ported from the stdio server to keep
// text output identical). KEEP formatting/defaults IN SYNC with integrations/mcp/asaki-memory.ts.
//
// Unlike the stdio server there is no filesystem/git here, so project_id can't be derived
// from a git root — callers must pass it explicitly. user_id defaults to
// ASAKI_MCP_DEFAULT_USER_ID (or "asaki").
import type { Hono, Context } from 'hono';
import type { Env } from './types';

type Bindings = Env;
type AppType = Hono<{ Bindings: Bindings }>;

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'asaki-memory', version: '0.1.0' };
const SOURCE_TAG = 'mcp';

// KEEP IN SYNC with integrations/mcp/asaki-memory.ts.
const MAX_TOOL_OUTPUT_CHARS = 6000;
const MEMORY_CONTEXT_CONTENT_CHARS = 280;
const KINDS = ['preference', 'rule', 'fact', 'decision', 'task_learning', 'bug_fix', 'workflow'] as const;

function normalizeKind(value: unknown): string {
  if (typeof value !== 'string') return 'task_learning';
  const normalized = value === 'fixed' ? 'bug_fix' : value === 'learned' ? 'task_learning' : value;
  return (KINDS as readonly string[]).includes(normalized) ? normalized : 'task_learning';
}

function truncateText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

// How much of a stored correction quote is echoed on a memory line. The full quote (<=120 chars each,
// see CORRECTION_ORIGIN_MAX_CHARS) stays in metadata_json and on the GET /v1/memories/:id row.
const MEMORY_ORIGIN_QUOTE_CHARS = 60;

// Lifecycle tail for memory lines: recurrence counter and correction provenance (captain decisions 4
// + 9), both read out of metadata_json. Absent metadata renders nothing, so pre-0006 rows and plain
// memories keep today's line. KEEP IN SYNC with formatMemoryLine() in integrations/pi/asaki-memory.ts.
function lifecycleSuffix(item: Record<string, unknown>): string {
  if (typeof item.metadata_json !== 'string' || !item.metadata_json.trim()) return '';
  let meta: Record<string, any>;
  try {
    meta = JSON.parse(item.metadata_json);
  } catch {
    return '';
  }
  if (!meta || typeof meta !== 'object') return '';
  let out = '';
  const reinforcement = meta.reinforcement;
  if (reinforcement && typeof reinforcement.count === 'number' && reinforcement.count > 0) {
    out += ` reinforced=${reinforcement.count}x@${reinforcement.last_reinforced_at ?? '?'}`;
  }
  const origin = meta.correction_origin;
  if (origin && typeof origin === 'object') {
    const agent = truncateText(String(origin.agent_did ?? ''), MEMORY_ORIGIN_QUOTE_CHARS);
    const verdict = truncateText(String(origin.captain_verdict ?? ''), MEMORY_ORIGIN_QUOTE_CHARS);
    out += ` origin="${agent} → ${verdict}"`;
  }
  return out;
}

function formatLine(item: Record<string, unknown>, index?: number, maxContentChars?: number): string {
  const prefix = index == null ? '' : `${index + 1}. `;
  const id = item.id ? ` id=${item.id}` : '';
  const scope = item.scope ? ` scope=${item.scope}` : '';
  const kind = item.kind ? ` kind=${item.kind}` : '';
  const status = item.status ? ` status=${item.status}` : '';
  const importance = typeof item.importance === 'number' ? ` importance=${item.importance.toFixed(2)}` : '';
  const source = item.source ? ` source=${item.source}` : '';
  const createdAt = item.created_at ? ` created_at=${item.created_at}` : '';
  const updatedAt = item.updated_at ? ` updated_at=${item.updated_at}` : '';
  const content = item.content ?? item.memory ?? item.text;
  const text = typeof content === 'string' ? content : JSON.stringify(item);
  const shown = maxContentChars == null ? text : truncateText(text, maxContentChars);
  return `${prefix}${shown}${id}${scope}${kind}${status}${importance}${source}${createdAt}${updatedAt}${lifecycleSuffix(item)}`;
}

function formatScoreDetails(details: unknown): string {
  if (!details || typeof details !== 'object') return '';
  const d = details as Record<string, unknown>;
  const parts = ['semantic', 'keyword', 'entity', 'metadata']
    .filter((key) => typeof d[key] === 'number')
    .map((key) => `${key}=${(d[key] as number).toFixed(3)}`);
  if (d.source) parts.push(`source=${d.source}`);
  return parts.length ? ` [${parts.join(' ')}]` : '';
}

// How much of a supersession target's content is quoted on its suggestion line.
const SUPERSEDE_CONTENT_CHARS = 160;

// Correction-aware review presentation. A `signal: "correction"` candidate is rendered as a block
// instead of one line: the rule he is accepting or rejecting first, then the moment that produced it
// (what the agent did → the captain's verdict) plus WHERE the antecedent came from, so a
// trace-inferred rule visibly reads weaker than a prose-inferred one, then the supersession
// suggestion carrying the target's CURRENT scope/kind/confidence — resolving a review never
// rescopes the target automatically, and a 0.95 → 0.70 confidence overwrite has to be visible at
// decision time. Accept the suggestion with `asaki_memory_review_resolve {action:"update",
// memory_id:<the id on that line>}`; `suggested_action: "delete"` means the rule form was `retract`.
// Non-correction rows keep today's single line, byte-for-byte.
//
// KEEP the emitted text byte-identical to the copy in integrations/pi/asaki-memory.ts (marked
// `// #region asaki-review-format`) — `npm run eval:review-format` fails on any drift, and it also
// pins the deliberate asymmetry on the FALLBACK line, where only the Pi copy prints
// importance/confidence. integrations/mcp/asaki-memory.ts (the stdio server for Codex) deliberately
// does NOT carry this block: its `asaki_memory_review_list` never sends `include_suggestions`, so it
// has no supersession data to render and keeps the plain line for every row.
function correctionBlockLines(item: Record<string, unknown>, candidate: Record<string, unknown>): string[] | null {
  if (candidate.signal !== 'correction') return null;

  const text = (value: unknown): string => (typeof value === 'string' && value.trim() ? value.trim() : '(unrecorded)');
  const num = (value: unknown): string => (typeof value === 'number' ? value.toFixed(2) : '?');
  const correction = candidate.correction && typeof candidate.correction === 'object' ? (candidate.correction as Record<string, unknown>) : {};
  const antecedent = typeof candidate.antecedent_source === 'string' && candidate.antecedent_source ? candidate.antecedent_source : 'none';

  const lines = [`   ⤷ agent: ${text(correction.agent_did)}   →   captain: ${text(correction.captain_verdict)}   (antecedent: ${antecedent})`];

  const supersedes = item.supersedes_candidates;
  if (supersedes === null) {
    lines.push('   ⤷ supersedes: not computed (suggestion cap reached on this page; re-list with a narrower filter)');
  } else if (Array.isArray(supersedes)) {
    for (const raw of supersedes) {
      const s = raw as Record<string, unknown>;
      const content = typeof s.content === 'string' ? s.content : '';
      const shown = content.length > SUPERSEDE_CONTENT_CHARS ? `${content.slice(0, SUPERSEDE_CONTENT_CHARS)}…` : content;
      lines.push(
        `   ⤷ supersedes: ${s.memory_id} [scope=${s.target_scope} kind=${s.target_kind} confidence=${num(s.target_confidence)}] "${shown}"  (score=${num(s.score)} suggest: ${s.suggested_action})`
      );
    }
  }

  // Global-promotion suggestion: the same rule already exists in ANOTHER project, so this project
  // correction is probably global. Accept it in one call with `asaki_memory_review_resolve
  // {action:"add", promote_to_global:true}`; ignoring the line resolves it project-scoped as usual.
  // Nothing is rescoped automatically, and this never touches the memory quoted on the line.
  const promotions = item.promotion_candidates;
  if (promotions === null) {
    lines.push('   ⤷ promote: not computed (suggestion cap reached on this page; re-list with a narrower filter)');
  } else if (Array.isArray(promotions)) {
    for (const raw of promotions) {
      const p = raw as Record<string, unknown>;
      const content = typeof p.content === 'string' ? p.content : '';
      const shown = content.length > SUPERSEDE_CONTENT_CHARS ? `${content.slice(0, SUPERSEDE_CONTENT_CHARS)}…` : content;
      lines.push(
        `   ⤷ promote: same rule in project ${p.target_project_id} as ${p.memory_id} [kind=${p.target_kind}] "${shown}"  (score=${num(p.score)} suggest: ${p.suggested_action})`
      );
    }
  }

  // Written server-side when this correction refused to merge into the pending row it contradicts;
  // that row's text is not carried on this response, so the id is what there is to print.
  if (typeof candidate.supersedes_pending_review_id === 'string' && candidate.supersedes_pending_review_id) {
    lines.push(`   ⤷ contradicts pending review ${candidate.supersedes_pending_review_id}`);
  }
  return lines;
}

export function formatReviewLine(item: Record<string, unknown>, index?: number): string {
  const prefix = index == null ? '' : `${index + 1}. `;
  const id = item.id ? ` id=${item.id}` : '';
  const status = item.status ? ` status=${item.status}` : '';
  const action = item.resolved_action ? ` action=${item.resolved_action}` : '';
  const memoryId = item.memory_id ? ` memory_id=${item.memory_id}` : '';
  const source = item.source ? ` source=${item.source}` : '';
  const createdAt = item.created_at ? ` created_at=${item.created_at}` : '';
  const updatedAt = item.updated_at ? ` updated_at=${item.updated_at}` : '';
  const candidate = item.candidate && typeof item.candidate === 'object' ? (item.candidate as Record<string, unknown>) : {};
  const scope = candidate.scope ? ` scope=${candidate.scope}` : '';
  const kind = candidate.kind ? ` kind=${candidate.kind}` : '';
  const content = candidate.content;
  const potentialDuplicate = item.potential_duplicate && typeof item.potential_duplicate === 'object' ? (item.potential_duplicate as Record<string, unknown>) : null;
  const dup = potentialDuplicate
    ? ` potential_duplicate=[memory_id=${potentialDuplicate.memory_id} suggested=${potentialDuplicate.action} reason="${potentialDuplicate.reason}"]`
    : '';
  const shownContent = typeof content === 'string' ? content : JSON.stringify(candidate || item);

  const correctionLines = correctionBlockLines(item, candidate);
  if (correctionLines) {
    const subtype = typeof candidate.signal_subtype === 'string' && candidate.signal_subtype ? candidate.signal_subtype : 'unspecified';
    const ruleForm = typeof candidate.rule_form === 'string' && candidate.rule_form ? candidate.rule_form : 'unspecified';
    const importance = typeof candidate.importance === 'number' ? ` importance=${candidate.importance.toFixed(2)}` : '';
    const confidence = typeof candidate.confidence === 'number' ? ` confidence=${candidate.confidence.toFixed(2)}` : '';
    const meta = `${id}${status}${action}${memoryId}${scope}${kind}${importance}${confidence}`.trim();
    const provenance = `${source}${createdAt}${updatedAt}${dup}`.trim();
    return [`${prefix}[correction · ${subtype} · ${ruleForm}] ${shownContent}`, ...correctionLines]
      .concat(meta ? [`   ${meta}`] : [])
      .concat(provenance ? [`   ${provenance}`] : [])
      .join('\n');
  }

  return `${prefix}${shownContent}${id}${status}${action}${memoryId}${scope}${kind}${source}${createdAt}${updatedAt}${dup}`;
}

// Lifecycle/system-health report rendering (captain decision 4). Two sections that answer two
// different questions: recurrence = rules the agent had to be corrected on AGAIN (the repeat-rate
// signal), idle = standing rules with no reinforcement and no retrieval hit, which a HUMAN judges
// keep/retire. Nothing here is actionable by the agent alone — no line proposes a delete.
//
// KEEP the emitted text byte-identical to the copy in integrations/pi/asaki-memory.ts (inside
// `// #region asaki-review-format`) — `npm run eval:review-format` fails on any drift. Self-contained
// on purpose: that region is loaded as a standalone module with no helpers around it.
export function formatLifecycleReport(data: Record<string, unknown>): string {
  const LIFECYCLE_CONTENT_CHARS = 120;
  const clip = (value: unknown): string => {
    const text = typeof value === 'string' ? value : '';
    return text.length > LIFECYCLE_CONTENT_CHARS ? `${text.slice(0, LIFECYCLE_CONTENT_CHARS)}…` : text;
  };
  const num = (value: unknown, digits: number): string => (typeof value === 'number' ? value.toFixed(digits) : '?');
  const rows = (value: unknown): Record<string, any>[] => (Array.isArray(value) ? (value as Record<string, any>[]) : []);
  const totals = (data.standing_rules && typeof data.standing_rules === 'object' ? data.standing_rules : {}) as Record<string, any>;
  const scopeOf = (row: Record<string, any>): string => (row.scope === 'project' && row.project_id ? `project/${row.project_id}` : String(row.scope ?? '?'));

  const lines = [
    `Standing rules: ${totals.active ?? 0} active · ${totals.reinforced ?? 0} reinforced · ${totals.total_reinforcements ?? 0} total reinforcements · repeat_rate=${num(totals.repeat_rate, 3)}`,
  ];

  const recurrence = rows(data.recurrence);
  lines.push('');
  if (recurrence.length === 0) {
    lines.push('Recurrence: none — no standing rule has been corrected again.');
  } else {
    lines.push('Recurrence (the agent repeated a mistake an existing rule already covers):');
    recurrence.forEach((row, index) => {
      lines.push(
        `${index + 1}. ${row.id} [scope=${scopeOf(row)} kind=${row.kind} importance=${num(row.importance, 2)}] count=${row.count} last=${row.last_reinforced_at ?? '?'} subtype=${row.last_signal_subtype ?? 'unspecified'} "${clip(row.content)}"`
      );
    });
  }

  const idle = rows(data.idle_rules);
  lines.push('');
  if (idle.length === 0) {
    lines.push(`Possibly stale: none idle for ${data.idle_days_threshold ?? '?'}d.`);
  } else {
    lines.push(`Possibly stale — judge keep/retire (no reinforcement and no retrieval hit in ${data.idle_days_threshold ?? '?'}d; never auto-deleted, never demoted out of injection):`);
    idle.forEach((row, index) => {
      lines.push(
        `${index + 1}. ${row.id} [scope=${scopeOf(row)} kind=${row.kind} importance=${num(row.importance, 2)}] idle=${row.idle_days}d last_signal=${row.last_signal_at} reinforced=${row.reinforcement_count ?? 0}x "${clip(row.content)}"`
      );
    });
  }

  return lines.join('\n');
}

type BudgetedJoin = { text: string; shown: number; total: number };

function joinWithinBudget(lines: string[], maxChars: number = MAX_TOOL_OUTPUT_CHARS): BudgetedJoin {
  let text = '';
  let included = 0;
  for (const rawLine of lines) {
    const line = rawLine.length > maxChars ? `${rawLine.slice(0, maxChars)}…` : rawLine;
    const next = text ? `${text}\n${line}` : line;
    if (next.length > maxChars && included > 0) break;
    text = next;
    included += 1;
  }
  return { text, shown: included, total: lines.length };
}

function withBudgetFooter(budget: BudgetedJoin, continueOffset?: number): string {
  if (budget.shown >= budget.total) return budget.text;
  const hint = continueOffset == null ? '' : ` — call again with offset=${continueOffset} to continue`;
  return `${budget.text}\n...(showing ${budget.shown}/${budget.total}, output budget reached${hint})`;
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

// --- Tool definitions -------------------------------------------------------

const SCOPE_ENUM = { type: 'string', enum: ['global', 'project', 'session'] } as const;
type Args = Record<string, any>;
type RestCall = { method: string; path: string; body?: unknown };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  toRequest(args: Args, userId: string): RestCall;
  format(data: Record<string, unknown>, args: Args): string;
}

const TOOLS: ToolDef[] = [
  {
    name: 'asaki_memory_search',
    description:
      'Search Asaki personal memory. Use only when the task depends on remembered preferences, prior decisions, conventions, task learnings, or explicitly requested past context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language query for relevant memories.' },
        top_k: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum results to return.' },
        scope: { ...SCOPE_ENUM, description: 'Optional scope filter.' },
        project_id: { type: 'string', description: 'Project id (required to include project-scoped results; no git detection on the server).' },
        session_id: { type: 'string', description: 'Session id override.' },
        debug: { type: 'boolean', description: 'Include score_details per result. Default off.' },
      },
      required: ['query'],
    },
    toRequest(args, userId) {
      const body: Record<string, unknown> = { query: args.query, user_id: userId, top_k: args.top_k ?? 10 };
      if (args.project_id) body.project_id = args.project_id;
      if (args.session_id) body.session_id = args.session_id;
      if (args.scope) body.scope = args.scope;
      return { method: 'POST', path: '/v1/memories/search', body };
    },
    format(data, args) {
      const results = asArray(data.results);
      if (results.length === 0) return 'No matching Asaki memories found.';
      const lines = results.map((item, index) => {
        const score = typeof item.score === 'number' ? ` score=${item.score.toFixed(3)}` : '';
        const similarity = typeof item.similarity === 'number' ? ` similarity=${item.similarity.toFixed(3)}` : '';
        const scoreDetails = args.debug ? formatScoreDetails(item.score_details) : '';
        return `${formatLine(item, index, MEMORY_CONTEXT_CONTENT_CHARS)}${score}${similarity}${scoreDetails}`;
      });
      return withBudgetFooter(joinWithinBudget(lines));
    },
  },
  {
    name: 'asaki_memory_add',
    description: 'Store a durable memory in Asaki personal memory. Do not store secrets or sensitive transient data.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'Concise, self-contained memory text. Preference/rule: ~40-160 chars. Decision/workflow/bug_fix/task_learning: 1-2 sentences, ~200-300 chars. Durable takeaway only.',
        },
        type: { type: 'string', description: 'Memory kind.' },
        scope: { ...SCOPE_ENUM, description: 'Memory scope.' },
        project_id: { type: 'string', description: 'Project id (required for project scope).' },
        session_id: { type: 'string', description: 'Session id.' },
        importance: { type: 'number', minimum: 0, maximum: 1, description: 'Importance 0-1. Default 0.6.' },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Confidence 0-1. Default 0.9.' },
      },
      required: ['text'],
    },
    toRequest(args, userId) {
      const scope = args.scope || 'project';
      const candidate: Record<string, unknown> = {
        content: args.text,
        user_id: userId,
        scope,
        kind: normalizeKind(args.type),
        importance: args.importance ?? 0.6,
        confidence: args.confidence ?? 0.9,
        source: SOURCE_TAG,
      };
      if (scope === 'project' && args.project_id) candidate.project_id = args.project_id;
      if (scope === 'session' && args.session_id) candidate.session_id = args.session_id;
      return { method: 'POST', path: '/v1/memories/candidates', body: { user_id: userId, source: SOURCE_TAG, candidates: [candidate] } };
    },
    format(data) {
      const decision = asArray(data.decisions)[0] as Record<string, any> | undefined;
      const queuedReview = !decision ? (asArray(data.reviews)[0] as Record<string, any> | undefined) : undefined;
      if (queuedReview) return `Asaki memory queued for review id=${queuedReview.id}`;
      const action = decision?.action || 'ok';
      const memoryId = decision?.memory?.id || decision?.matched_memory?.id;
      const reviewId = decision?.review?.id;
      const reason = decision?.reason ? `: ${decision.reason}` : '';
      return `Asaki memory ${action}${memoryId ? ` id=${memoryId}` : ''}${reviewId ? ` review_id=${reviewId}` : ''}${reason}`;
    },
  },
  {
    name: 'asaki_memory_extract',
    description:
      'Deprecated compatibility tool for server-side raw-text extraction. Do not use for routine capture or full transcripts; prefer pre-distilled candidates and the local classifier review path.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Raw text to extract durable memories from.' },
        scope: { ...SCOPE_ENUM, description: 'Memory scope.' },
        project_id: { type: 'string', description: 'Project id (used for project-scope candidates).' },
        session_id: { type: 'string', description: 'Session id.' },
      },
      required: ['text'],
    },
    toRequest(args, userId) {
      const body: Record<string, unknown> = { text: args.text, user_id: userId, source: `${SOURCE_TAG}:extract` };
      if (args.project_id) body.project_id = args.project_id;
      if (args.scope) body.scope = args.scope;
      if (args.scope === 'session' && args.session_id) body.session_id = args.session_id;
      return { method: 'POST', path: '/v1/memories/extract', body };
    },
    format(data) {
      const decisions = asArray(data.decisions) as Record<string, any>[];
      const reviews = asArray(data.reviews);
      if (decisions.length === 0 && reviews.length === 0) return 'No durable memories extracted.';
      const parts: string[] = [];
      if (decisions.length > 0) {
        parts.push(
          decisions
            .map((decision, index) => {
              const action = decision.action || 'ok';
              const memoryId = decision.memory?.id || decision.matched_memory?.id;
              const reason = decision.reason ? `: ${decision.reason}` : '';
              const content = decision.candidate?.content ?? '';
              return `${index + 1}. [${action}]${memoryId ? ` id=${memoryId}` : ''} ${content}${reason}`;
            })
            .join('\n'),
        );
      }
      if (reviews.length > 0) {
        parts.push(`${reviews.length} candidate(s) queued for review:\n${reviews.map((item, index) => formatReviewLine(item, index)).join('\n')}`);
      }
      return parts.join('\n\n');
    },
  },
  {
    name: 'asaki_memory_list',
    description: 'List memories with optional filters. With scope omitted, visibility is global plus only the supplied project_id/session_id; with neither id it returns only global memories. Use asaki_memory_project_list to discover every project during an audit.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: SCOPE_ENUM,
        project_id: { type: 'string' },
        session_id: { type: 'string' },
        kind: { type: 'string' },
        status: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0 },
      },
    },
    toRequest(args, userId) {
      const body: Record<string, unknown> = { user_id: userId };
      if (args.project_id) body.project_id = args.project_id;
      if (args.session_id) body.session_id = args.session_id;
      if (args.scope) body.scope = args.scope;
      if (args.kind) body.kind = args.kind;
      if (args.status) body.status = args.status;
      if (args.limit != null) body.limit = args.limit;
      if (args.offset != null) body.offset = args.offset;
      return { method: 'POST', path: '/v1/memories/list', body };
    },
    format(data, args) {
      const memories = asArray(data.memories);
      if (memories.length === 0) return 'No Asaki memories found.';
      const budget = joinWithinBudget(memories.map((item, index) => formatLine(item, index)));
      return withBudgetFooter(budget, (args.offset ?? 0) + budget.shown);
    },
  },
  {
    name: 'asaki_memory_project_list',
    description: 'Enumerate every project_id that holds project-scoped memories, with total/active memory counts and pending-review counts. Page with limit/offset during a whole-store audit.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0 },
      },
    },
    toRequest(args, userId) {
      const body: Record<string, unknown> = { user_id: userId };
      if (args.limit != null) body.limit = args.limit;
      if (args.offset != null) body.offset = args.offset;
      return { method: 'POST', path: '/v1/memories/projects', body };
    },
    format(data, args) {
      const projects = asArray(data.projects) as Record<string, any>[];
      if (projects.length === 0) return 'No Asaki memory projects found.';
      const lines = projects.map((project, index) => `${index + 1}. project=${project.project_id} memories=${project.memory_count} active=${project.active_memory_count} pendingReviews=${project.pending_review_count}`);
      const budget = joinWithinBudget(lines);
      return withBudgetFooter(budget, (args.offset ?? 0) + budget.shown);
    },
  },
  {
    name: 'asaki_memory_review_create',
    description: 'Create a pending review item for a high-risk or uncertain memory candidate instead of directly storing it.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        type: { type: 'string' },
        scope: SCOPE_ENUM,
        project_id: { type: 'string' },
        session_id: { type: 'string' },
        importance: { type: 'number', minimum: 0, maximum: 1 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['text'],
    },
    toRequest(args, userId) {
      const scope = args.scope || 'project';
      const candidate: Record<string, unknown> = {
        content: args.text,
        user_id: userId,
        scope,
        kind: normalizeKind(args.type),
        importance: args.importance ?? 0.6,
        confidence: args.confidence ?? 0.8,
        source: `${SOURCE_TAG}:review`,
      };
      if (scope === 'project' && args.project_id) candidate.project_id = args.project_id;
      if (scope === 'session' && args.session_id) candidate.session_id = args.session_id;
      const body: Record<string, unknown> = { user_id: userId, source: `${SOURCE_TAG}:review`, candidates: [candidate] };
      if (scope === 'project' && args.project_id) body.project_id = args.project_id;
      if (scope === 'session' && args.session_id) body.session_id = args.session_id;
      return { method: 'POST', path: '/v1/memories/reviews', body };
    },
    format(data) {
      const review = asArray(data.reviews)[0];
      return review ? `Created review: ${formatReviewLine(review)}` : 'Created Asaki memory review.';
    },
  },
  {
    name: 'asaki_memory_review_list',
    description: 'List pending or resolved review items. pending_count always means all pending rows for the user across every scope/project, independent of page filters. Use during explicit memory audit.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        project_id: { type: 'string' },
        session_id: { type: 'string' },
        source: { type: 'string' },
        signal: { type: 'string', enum: ['correction', 'preference', 'outcome', 'none'], description: 'Filter by candidate signal. Corrections sort first regardless; use signal=correction to see only them during an audit.' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0 },
        include_suggestions: { type: 'boolean', description: 'Attach similarity-based hints. Expensive mode requires limit <= 12; page with offset. Default off.' },
      },
    },
    toRequest(args, userId) {
      const body: Record<string, unknown> = { user_id: userId };
      if (args.project_id) body.project_id = args.project_id;
      if (args.session_id) body.session_id = args.session_id;
      if (args.status) body.status = args.status;
      if (args.source) body.source = args.source;
      if (args.signal) body.signal = args.signal;
      if (args.limit != null) body.limit = args.limit;
      if (args.offset != null) body.offset = args.offset;
      if (args.include_suggestions) body.include_suggestions = true;
      return { method: 'POST', path: '/v1/memories/reviews/list', body };
    },
    format(data, args) {
      const reviews = asArray(data.reviews);
      const pending = typeof data.pending_count === 'number' ? ` Pending across store: ${data.pending_count}.` : '';
      if (reviews.length === 0) return `No Asaki memory reviews found.${pending}`;
      const budget = joinWithinBudget(reviews.map((item, index) => formatReviewLine(item, index)));
      return `${withBudgetFooter(budget, (args.offset ?? 0) + budget.shown)}${pending}`;
    },
  },
  {
    name: 'asaki_memory_review_resolve',
    description:
      'Resolve a pending Asaki memory review as add, merge, update, delete, or ignore. update = overwrite with candidate text unless content is given; for a merge, pass the merged text via content. update/delete/merge require memory_id. Only call after explicit user approval.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        action: { type: 'string', enum: ['add', 'merge', 'update', 'delete', 'ignore'] },
        memory_id: { type: 'string' },
        reason: { type: 'string' },
        content: { type: 'string', description: 'Exact resulting text for action=update. Without it, the candidate text overwrites the target.' },
        kind: { type: 'string', enum: [...KINDS], description: 'Optional resulting kind for action=update. Omit to preserve the target kind when content is given.' },
        importance: { type: 'number', minimum: 0, maximum: 1, description: 'Optional resulting importance for action=update. Omit to preserve the target importance when content is given.' },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Optional resulting confidence for action=update. Omit to preserve the target confidence when content is given.' },
        promote_to_global: {
          type: 'boolean',
          description: 'Accept the row\'s "⤷ promote:" suggestion: store the candidate as scope=global instead of project. Only valid with action=add, and only after the user approved promotion.',
        },
      },
      required: ['id', 'action'],
    },
    toRequest(args, userId) {
      const body: Record<string, unknown> = { user_id: userId, action: args.action };
      if (args.memory_id) body.memory_id = args.memory_id;
      if (args.reason) body.reason = args.reason;
      if (args.content !== undefined) body.content = args.content;
      if (args.kind !== undefined) body.kind = args.kind;
      if (args.importance !== undefined) body.importance = args.importance;
      if (args.confidence !== undefined) body.confidence = args.confidence;
      if (args.promote_to_global) body.promote_to_global = true;
      return { method: 'POST', path: `/v1/memories/reviews/${encodeURIComponent(args.id)}/resolve`, body };
    },
    format(data) {
      const review = data.review as Record<string, unknown> | undefined;
      const memory = data.memory as Record<string, unknown> | undefined;
      const promoted = data.promoted_to_global === true ? '\nPromoted to scope=global.' : '';
      return `${review ? `Resolved review: ${formatReviewLine(review)}` : 'Review resolved.'}${memory ? `\nMemory: ${formatLine(memory)}` : ''}${promoted}`;
    },
  },
  {
    name: 'asaki_memory_lifecycle',
    description:
      'Memory-system health report: standing-rule repeat rate, per-rule recurrence counts (rules the agent had to be corrected on again), and long-idle standing rules needing a keep/retire verdict. Read-only. Use during an explicit memory audit.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Include this project\'s rules alongside global ones (no git detection on the server).' },
        idle_days: { type: 'integer', minimum: 1, maximum: 3650, description: 'Idle threshold in days. Default 30 (~two 14-day audit cadences).' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max rows per section. Default 20.' },
      },
    },
    toRequest(args, userId) {
      const body: Record<string, unknown> = { user_id: userId };
      if (args.project_id) body.project_id = args.project_id;
      if (args.idle_days != null) body.idle_days = args.idle_days;
      if (args.limit != null) body.limit = args.limit;
      return { method: 'POST', path: '/v1/memories/lifecycle', body };
    },
    format(data) {
      return formatLifecycleReport(data);
    },
  },
  {
    name: 'asaki_memory_update',
    description: 'Update an existing Asaki memory by id. Only call after explicit user approval.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        content: { type: 'string' },
        scope: SCOPE_ENUM,
        project_id: { type: 'string' },
        session_id: { type: 'string' },
        kind: { type: 'string' },
        importance: { type: 'number', minimum: 0, maximum: 1 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        status: { type: 'string', enum: ['active', 'archived', 'deleted'] },
      },
      required: ['id'],
    },
    toRequest(args, userId) {
      const body: Record<string, unknown> = { user_id: userId };
      for (const key of ['content', 'scope', 'project_id', 'session_id', 'kind', 'importance', 'confidence', 'status']) {
        if (args[key] !== undefined) body[key] = args[key];
      }
      return { method: 'PATCH', path: `/v1/memories/${encodeURIComponent(args.id)}`, body };
    },
    format(data) {
      const memory = data.memory as Record<string, unknown> | undefined;
      return memory ? `Updated: ${formatLine(memory)}` : 'Memory updated.';
    },
  },
  {
    name: 'asaki_memory_delete',
    description: 'Soft-delete a memory from Asaki personal memory by id. Only call after explicit user approval.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    toRequest(args, userId) {
      return { method: 'DELETE', path: `/v1/memories/${encodeURIComponent(args.id)}`, body: { user_id: userId } };
    },
    format(data) {
      const memory = data.memory as Record<string, unknown> | undefined;
      return memory ? `Deleted: ${formatLine(memory)}` : 'Memory deleted.';
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

// --- JSON-RPC handling ------------------------------------------------------

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function resolveUserId(env: Env): string {
  return (env as Env & { ASAKI_MCP_DEFAULT_USER_ID?: string }).ASAKI_MCP_DEFAULT_USER_ID || 'asaki';
}

async function callTool(app: AppType, c: Context<{ Bindings: Bindings }>, name: string, args: Args) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };

  const { method, path, body } = tool.toRequest(args || {}, resolveUserId(c.env));
  const url = new URL(path, c.req.url);
  const authorization = c.req.header('Authorization') ?? '';
  const request = new Request(url.toString(), {
    method,
    headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });

  const response = await app.fetch(request, c.env, c.executionCtx);
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const errText = typeof data.error === 'string' ? data.error : `Asaki Memory API ${response.status}`;
    return { content: [{ type: 'text', text: errText }], isError: true };
  }
  return { content: [{ type: 'text', text: tool.format(data, args || {}) }] };
}

export async function handleMcpRequest(app: AppType, c: Context<{ Bindings: Bindings }>): Promise<Response> {
  // JSON-RPC-level errors are always returned as HTTP 200 with an `error` envelope: the MCP
  // Streamable HTTP client treats any non-2xx as a transport failure and throws without
  // parsing the body, so a 400/404 here would surface as a hard connection error instead of
  // a recoverable JSON-RPC error (e.g. method-not-found during capability probing).
  let payload: any;
  try {
    payload = await c.req.json();
  } catch {
    return c.json(rpcError(null, -32700, 'Parse error'));
  }
  if (Array.isArray(payload)) {
    return c.json(rpcError(null, -32600, 'Batch requests are not supported'));
  }

  const { id = null, method, params } = payload ?? {};

  // Notifications (no id) never expect a response body.
  if (id === null && typeof method === 'string' && method.startsWith('notifications/')) {
    return new Response(null, { status: 202 });
  }

  switch (method) {
    case 'initialize':
      return c.json(
        rpcResult(id, {
          protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        }),
      );
    case 'ping':
      return c.json(rpcResult(id, {}));
    case 'tools/list':
      return c.json(
        rpcResult(id, {
          tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
        }),
      );
    case 'tools/call': {
      const name = params?.name;
      if (typeof name !== 'string') return c.json(rpcError(id, -32602, 'Missing tool name'));
      try {
        const result = await callTool(app, c, name, params?.arguments ?? {});
        return c.json(rpcResult(id, result));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json(rpcResult(id, { content: [{ type: 'text', text: message }], isError: true }));
      }
    }
    default:
      return c.json(rpcError(id, -32601, `Method not found: ${method}`));
  }
}
