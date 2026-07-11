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

function formatLine(item: Record<string, unknown>, index?: number, maxContentChars?: number): string {
  const prefix = index == null ? '' : `${index + 1}. `;
  const id = item.id ? ` id=${item.id}` : '';
  const scope = item.scope ? ` scope=${item.scope}` : '';
  const kind = item.kind ? ` kind=${item.kind}` : '';
  const status = item.status ? ` status=${item.status}` : '';
  const importance = typeof item.importance === 'number' ? ` importance=${item.importance.toFixed(2)}` : '';
  const updatedAt = item.updated_at ? ` updated_at=${item.updated_at}` : '';
  const content = item.content ?? item.memory ?? item.text;
  const text = typeof content === 'string' ? content : JSON.stringify(item);
  const shown = maxContentChars == null ? text : truncateText(text, maxContentChars);
  return `${prefix}${shown}${id}${scope}${kind}${status}${importance}${updatedAt}`;
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

function formatReviewLine(item: Record<string, unknown>, index?: number): string {
  const prefix = index == null ? '' : `${index + 1}. `;
  const id = item.id ? ` id=${item.id}` : '';
  const status = item.status ? ` status=${item.status}` : '';
  const action = item.resolved_action ? ` action=${item.resolved_action}` : '';
  const memoryId = item.memory_id ? ` memory_id=${item.memory_id}` : '';
  const updatedAt = item.updated_at ? ` updated_at=${item.updated_at}` : '';
  const candidate = item.candidate && typeof item.candidate === 'object' ? (item.candidate as Record<string, unknown>) : {};
  const scope = candidate.scope ? ` scope=${candidate.scope}` : '';
  const kind = candidate.kind ? ` kind=${candidate.kind}` : '';
  const content = candidate.content;
  const potentialDuplicate = item.potential_duplicate && typeof item.potential_duplicate === 'object' ? (item.potential_duplicate as Record<string, unknown>) : null;
  const dup = potentialDuplicate
    ? ` potential_duplicate=[memory_id=${potentialDuplicate.memory_id} suggested=${potentialDuplicate.action} reason="${potentialDuplicate.reason}"]`
    : '';
  return `${prefix}${typeof content === 'string' ? content : JSON.stringify(candidate || item)}${id}${status}${action}${memoryId}${scope}${kind}${updatedAt}${dup}`;
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
      'Extract and store durable memories from a raw text blob (e.g. a conversation excerpt) via LLM-based extraction, instead of a single pre-distilled statement. Use when you have unstructured text rather than an already-concise memory.',
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
    description: 'List memories from Asaki personal memory with optional filters. Use during explicit memory audit.',
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
    description: 'List pending or resolved Asaki memory review items. Use during explicit memory audit.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        project_id: { type: 'string' },
        session_id: { type: 'string' },
        source: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0 },
        include_suggestions: { type: 'boolean', description: 'Attach a potential_duplicate hint per pending review. Default off.' },
      },
    },
    toRequest(args, userId) {
      const body: Record<string, unknown> = { user_id: userId };
      if (args.project_id) body.project_id = args.project_id;
      if (args.session_id) body.session_id = args.session_id;
      if (args.status) body.status = args.status;
      if (args.source) body.source = args.source;
      if (args.limit != null) body.limit = args.limit;
      if (args.offset != null) body.offset = args.offset;
      if (args.include_suggestions) body.include_suggestions = true;
      return { method: 'POST', path: '/v1/memories/reviews/list', body };
    },
    format(data, args) {
      const reviews = asArray(data.reviews);
      if (reviews.length === 0) return 'No Asaki memory reviews found.';
      const budget = joinWithinBudget(reviews.map((item, index) => formatReviewLine(item, index)));
      return withBudgetFooter(budget, (args.offset ?? 0) + budget.shown);
    },
  },
  {
    name: 'asaki_memory_review_resolve',
    description:
      'Resolve a pending Asaki memory review as add, merge, update, delete, or ignore. update/delete/merge require memory_id (the existing memory to replace/delete/merge into). Only call after explicit user approval.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        action: { type: 'string', enum: ['add', 'merge', 'update', 'delete', 'ignore'] },
        memory_id: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['id', 'action'],
    },
    toRequest(args, userId) {
      const body: Record<string, unknown> = { user_id: userId, action: args.action };
      if (args.memory_id) body.memory_id = args.memory_id;
      if (args.reason) body.reason = args.reason;
      return { method: 'POST', path: `/v1/memories/reviews/${encodeURIComponent(args.id)}/resolve`, body };
    },
    format(data) {
      const review = data.review as Record<string, unknown> | undefined;
      const memory = data.memory as Record<string, unknown> | undefined;
      return `${review ? `Resolved review: ${formatReviewLine(review)}` : 'Review resolved.'}${memory ? `\nMemory: ${formatLine(memory)}` : ''}`;
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
  let payload: any;
  try {
    payload = await c.req.json();
  } catch {
    return c.json(rpcError(null, -32700, 'Parse error'), 400);
  }
  if (Array.isArray(payload)) {
    return c.json(rpcError(null, -32600, 'Batch requests are not supported'), 400);
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
      if (typeof name !== 'string') return c.json(rpcError(id, -32602, 'Missing tool name'), 400);
      try {
        const result = await callTool(app, c, name, params?.arguments ?? {});
        return c.json(rpcResult(id, result));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json(rpcResult(id, { content: [{ type: 'text', text: message }], isError: true }));
      }
    }
    default:
      return c.json(rpcError(id, -32601, `Method not found: ${method}`), 404);
  }
}
