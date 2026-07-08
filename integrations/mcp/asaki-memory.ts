/**
 * Asaki Memory MCP Server
 *
 * Exposes Asaki memory search/add/list/update/delete and review queue tools via MCP stdio.
 *
 * Config precedence:
 *   env vars > ASAKI_MEMORY_CONFIG_FILE > ~/.asaki-memory.json
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const API_BASE = "https://asaki-memory-manager.YOUR_SUBDOMAIN.workers.dev";
const DEFAULT_USER_ID = "asaki";
const DEFAULT_SCOPE = "project" as const;
const SOURCE_TAG = process.env.ASAKI_MEMORY_SOURCE || "mcp";
// Caps how much text a single tool call can inject into the agent's context, independent of
// how many memories/reviews are returned (a memory's content can be up to 8000 chars, and
// search/list can return up to 50/100 items). KEEP IN SYNC with the same constant in
// integrations/pi/asaki-memory.ts and integrations/claude-code/user-prompt.sh.
const MAX_TOOL_OUTPUT_CHARS = 6000;

const SCOPES = ["global", "project", "session"] as const;
const KINDS = ["preference", "rule", "fact", "decision", "task_learning", "bug_fix", "workflow"] as const;
type MemoryScope = (typeof SCOPES)[number];
type MemoryKind = (typeof KINDS)[number];
type ConfigFile = Record<string, unknown>;

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function configFilePath(): string {
  return expandHome(process.env.ASAKI_MEMORY_CONFIG_FILE || join(homedir(), ".asaki-memory.json"));
}

function loadConfigFile(): ConfigFile {
  try {
    const path = configFilePath();
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as ConfigFile) : {};
  } catch {
    return {};
  }
}

function strVal(cfg: ConfigFile, ...keys: string[]): string {
  for (const key of keys) {
    const value = cfg[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function normalizeScope(value: unknown): MemoryScope | undefined {
  return typeof value === "string" && SCOPES.includes(value as MemoryScope) ? (value as MemoryScope) : undefined;
}

function normalizeKind(value: unknown): MemoryKind {
  if (typeof value !== "string") return "task_learning";
  const normalized = value === "fixed" ? "bug_fix" : value === "learned" ? "task_learning" : value;
  return KINDS.includes(normalized as MemoryKind) ? (normalized as MemoryKind) : "task_learning";
}

function memoryConfig() {
  const file = loadConfigFile();
  return {
    baseUrl: (process.env.ASAKI_MEMORY_BASE_URL || process.env.ASAKI_MEMORY_API_URL || strVal(file, "baseUrl", "base_url", "apiUrl", "api_url") || API_BASE).replace(/\/$/, ""),
    apiKey: process.env.ASAKI_MEMORY_API_KEY || process.env.MEMORY_API_KEY || strVal(file, "apiKey", "api_key") || "",
    userId: process.env.ASAKI_MEMORY_USER_ID || process.env.MEMORY_USER_ID || strVal(file, "userId", "user_id") || DEFAULT_USER_ID,
    projectId: process.env.ASAKI_MEMORY_PROJECT_ID || process.env.MEMORY_PROJECT_ID || strVal(file, "projectId", "project_id") || "",
    sessionId: process.env.ASAKI_MEMORY_SESSION_ID || process.env.MEMORY_SESSION_ID || strVal(file, "sessionId", "session_id") || "",
    defaultScope: normalizeScope(process.env.ASAKI_MEMORY_DEFAULT_SCOPE || strVal(file, "defaultScope", "default_scope")) ?? DEFAULT_SCOPE,
  };
}

function findGitRoot(start: string): string | null {
  let current = resolve(start || process.cwd());
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveProjectId(explicit?: string): string {
  const cfg = memoryConfig();
  if (explicit) return explicit;
  if (cfg.projectId) return cfg.projectId;
  const root = findGitRoot(process.cwd());
  return basename(root ?? resolve(process.cwd())) || "local-project";
}

class MemoryApiError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function apiRequest(path: string, body: unknown, signal?: AbortSignal, method = "POST"): Promise<Record<string, unknown>> {
  const { baseUrl, apiKey } = memoryConfig();
  if (!apiKey) throw new Error("ASAKI_MEMORY_API_KEY is not set. Add it to MCP server env or ASAKI_MEMORY_CONFIG_FILE.");

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body == null ? undefined : JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new MemoryApiError(response.status, text, `Asaki Memory API ${response.status}: ${text || response.statusText}`);
  }

  return response.json() as Promise<Record<string, unknown>>;
}

type BudgetedJoin = { text: string; shown: number; total: number };

function joinWithinBudget(lines: string[], maxChars: number = MAX_TOOL_OUTPUT_CHARS): BudgetedJoin {
  let text = "";
  let included = 0;
  for (const rawLine of lines) {
    // Clamp each line to the full budget first so one oversized item (content can be up to
    // 8000 chars) can never blow past maxChars on its own — only ever exactly reach it.
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
  const hint = continueOffset == null ? "" : ` — call again with offset=${continueOffset} to continue`;
  return `${budget.text}\n...(showing ${budget.shown}/${budget.total}, output budget reached${hint})`;
}

function formatLine(item: Record<string, unknown>, index?: number): string {
  const prefix = index == null ? "" : `${index + 1}. `;
  const id = item.id ? ` id=${item.id}` : "";
  const scope = item.scope ? ` scope=${item.scope}` : "";
  const kind = item.kind ? ` kind=${item.kind}` : "";
  const status = item.status ? ` status=${item.status}` : "";
  const importance = typeof item.importance === "number" ? ` importance=${item.importance.toFixed(2)}` : "";
  const updatedAt = item.updated_at ? ` updated_at=${item.updated_at}` : "";
  const content = item.content ?? item.memory ?? item.text;
  return `${prefix}${typeof content === "string" ? content : JSON.stringify(item)}${id}${scope}${kind}${status}${importance}${updatedAt}`;
}

function formatReviewLine(item: Record<string, unknown>, index?: number): string {
  const prefix = index == null ? "" : `${index + 1}. `;
  const id = item.id ? ` id=${item.id}` : "";
  const status = item.status ? ` status=${item.status}` : "";
  const action = item.resolved_action ? ` action=${item.resolved_action}` : "";
  const memoryId = item.memory_id ? ` memory_id=${item.memory_id}` : "";
  const updatedAt = item.updated_at ? ` updated_at=${item.updated_at}` : "";
  const candidate = item.candidate && typeof item.candidate === "object" ? (item.candidate as Record<string, unknown>) : {};
  const scope = candidate.scope ? ` scope=${candidate.scope}` : "";
  const kind = candidate.kind ? ` kind=${candidate.kind}` : "";
  const content = candidate.content;
  return `${prefix}${typeof content === "string" ? content : JSON.stringify(candidate || item)}${id}${status}${action}${memoryId}${scope}${kind}${updatedAt}`;
}

const server = new McpServer({ name: "asaki-memory", version: "0.1.0" });

server.tool(
  "asaki_memory_search",
  "Search Asaki personal memory. Use only when the task depends on remembered preferences, prior decisions, conventions, task learnings, or explicitly requested past context.",
  {
    query: z.string().describe("Natural-language query for relevant memories."),
    top_k: z.number().int().min(1).max(50).optional().describe("Maximum results to return."),
    scope: z.enum(["global", "project", "session"]).optional().describe("Optional scope filter."),
    project_id: z.string().optional().describe("Project id override."),
    session_id: z.string().optional().describe("Session id override."),
  },
  async ({ query, top_k, scope, project_id, session_id }) => {
    const cfg = memoryConfig();
    const body: Record<string, unknown> = {
      query,
      user_id: cfg.userId,
      project_id: resolveProjectId(project_id),
      top_k: top_k ?? 10,
    };
    if (session_id || cfg.sessionId) body.session_id = session_id || cfg.sessionId;
    if (scope) body.scope = scope;

    const data = await apiRequest("/v1/memories/search", body);
    const results = Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : [];
    if (results.length === 0) return { content: [{ type: "text" as const, text: "No matching Asaki memories found." }] };

    const lines = results.map((item, index) => {
      const score = typeof item.score === "number" ? ` score=${item.score.toFixed(3)}` : "";
      const similarity = typeof item.similarity === "number" ? ` similarity=${item.similarity.toFixed(3)}` : "";
      return `${formatLine(item, index)}${score}${similarity}`;
    });
    return { content: [{ type: "text" as const, text: withBudgetFooter(joinWithinBudget(lines)) }] };
  },
);

server.tool(
  "asaki_memory_add",
  "Store a durable memory in Asaki personal memory. Do not store secrets or sensitive transient data.",
  {
    text: z.string().describe("Concise, self-contained memory text to store (1-3 sentences, roughly 40-300 chars). Summarize the durable takeaway only — never paste multi-paragraph implementation logs, changelogs, or step-by-step narratives."),
    type: z.string().optional().describe("Memory kind."),
    scope: z.enum(["global", "project", "session"]).optional().describe("Memory scope."),
    project_id: z.string().optional().describe("Project id override."),
    session_id: z.string().optional().describe("Session id override."),
    importance: z.number().min(0).max(1).optional().describe("Importance 0-1. Default 0.6."),
    confidence: z.number().min(0).max(1).optional().describe("Confidence 0-1. Default 0.9."),
  },
  async ({ text, type, scope, project_id, session_id, importance, confidence }) => {
    const cfg = memoryConfig();
    const resolvedScope = scope || cfg.defaultScope;
    const projectId = resolveProjectId(project_id);
    const sessionId = session_id || cfg.sessionId || undefined;
    const candidate: Record<string, unknown> = {
      content: text,
      user_id: cfg.userId,
      scope: resolvedScope,
      kind: normalizeKind(type),
      importance: importance ?? 0.6,
      confidence: confidence ?? 0.9,
      source: SOURCE_TAG,
    };
    if (resolvedScope === "project") candidate.project_id = projectId;
    if (resolvedScope === "session") candidate.session_id = sessionId;

    const data = await apiRequest("/v1/memories/candidates", { user_id: cfg.userId, source: SOURCE_TAG, candidates: [candidate] });
    const decision = Array.isArray(data.decisions) ? (data.decisions[0] as Record<string, any> | undefined) : undefined;
    const action = decision?.action || "ok";
    const memoryId = decision?.memory?.id || decision?.matched_memory?.id;
    const reason = decision?.reason ? `: ${decision.reason}` : "";
    return { content: [{ type: "text" as const, text: `Asaki memory ${action}${memoryId ? ` id=${memoryId}` : ""}${reason}` }] };
  },
);

server.tool(
  "asaki_memory_extract",
  "Extract and store durable memories from a raw text blob (e.g. a conversation excerpt) via LLM-based extraction, instead of a single pre-distilled statement. Use when you have unstructured text rather than an already-concise memory.",
  {
    text: z.string().describe("Raw text to extract durable memories from."),
    scope: z.enum(["global", "project", "session"]).optional().describe("Memory scope."),
    project_id: z.string().optional().describe("Project id override."),
    session_id: z.string().optional().describe("Session id override."),
  },
  async ({ text, scope, project_id, session_id }) => {
    const cfg = memoryConfig();
    const projectId = resolveProjectId(project_id);
    const sessionId = session_id || cfg.sessionId || undefined;
    // No scope forced here unless the caller explicitly passes one — the server infers
    // global vs project per extracted candidate instead of lumping everything into one scope.
    const body: Record<string, unknown> = { text, user_id: cfg.userId, project_id: projectId, source: `${SOURCE_TAG}:extract` };
    if (scope) body.scope = scope;
    if (scope === "session" || (!scope && sessionId)) body.session_id = sessionId;

    const data = await apiRequest("/v1/memories/extract", body);
    const decisions = Array.isArray(data.decisions) ? (data.decisions as Record<string, any>[]) : [];
    if (decisions.length === 0) return { content: [{ type: "text" as const, text: "No durable memories extracted." }] };
    const text_out = decisions
      .map((decision, index) => {
        const action = decision.action || "ok";
        const memoryId = decision.memory?.id || decision.matched_memory?.id;
        const reason = decision.reason ? `: ${decision.reason}` : "";
        const content = decision.candidate?.content ?? "";
        return `${index + 1}. [${action}]${memoryId ? ` id=${memoryId}` : ""} ${content}${reason}`;
      })
      .join("\n");
    return { content: [{ type: "text" as const, text: text_out }] };
  },
);

server.tool(
  "asaki_memory_list",
  "List memories from Asaki personal memory with optional filters. Use during explicit memory audit.",
  {
    scope: z.enum(["global", "project", "session"]).optional(),
    project_id: z.string().optional(),
    session_id: z.string().optional(),
    kind: z.string().optional(),
    status: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
  },
  async ({ scope, project_id, session_id, kind, status, limit, offset }) => {
    const cfg = memoryConfig();
    const body: Record<string, unknown> = { user_id: cfg.userId, project_id: resolveProjectId(project_id) };
    if (session_id || cfg.sessionId) body.session_id = session_id || cfg.sessionId;
    if (scope) body.scope = scope;
    if (kind) body.kind = kind;
    if (status) body.status = status;
    if (limit != null) body.limit = limit;
    if (offset != null) body.offset = offset;

    const data = await apiRequest("/v1/memories/list", body);
    const memories = Array.isArray(data.memories) ? (data.memories as Record<string, unknown>[]) : [];
    if (memories.length === 0) return { content: [{ type: "text" as const, text: "No Asaki memories found." }] };
    const listBudget = joinWithinBudget(memories.map((item, index) => formatLine(item, index)));
    return { content: [{ type: "text" as const, text: withBudgetFooter(listBudget, (offset ?? 0) + listBudget.shown) }] };
  },
);


server.tool(
  "asaki_memory_review_create",
  "Create a pending review item for a high-risk or uncertain memory candidate instead of directly storing it.",
  {
    text: z.string(),
    type: z.string().optional(),
    scope: z.enum(["global", "project", "session"]).optional(),
    project_id: z.string().optional(),
    session_id: z.string().optional(),
    importance: z.number().min(0).max(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
  },
  async ({ text, type, scope, project_id, session_id, importance, confidence }) => {
    const cfg = memoryConfig();
    const resolvedScope = scope || cfg.defaultScope;
    const projectId = resolveProjectId(project_id);
    const sessionId = session_id || cfg.sessionId || undefined;
    const candidate: Record<string, unknown> = {
      content: text,
      user_id: cfg.userId,
      scope: resolvedScope,
      kind: normalizeKind(type),
      importance: importance ?? 0.6,
      confidence: confidence ?? 0.8,
      source: `${SOURCE_TAG}:review`,
    };
    if (resolvedScope === "project") candidate.project_id = projectId;
    if (resolvedScope === "session") candidate.session_id = sessionId;

    const body: Record<string, unknown> = { user_id: cfg.userId, source: `${SOURCE_TAG}:review`, candidates: [candidate] };
    if (resolvedScope === "project") body.project_id = projectId;
    if (resolvedScope === "session") body.session_id = sessionId;
    const data = await apiRequest("/v1/memories/reviews", body);
    const review = Array.isArray(data.reviews) ? (data.reviews[0] as Record<string, unknown> | undefined) : undefined;
    return { content: [{ type: "text" as const, text: review ? `Created review: ${formatReviewLine(review)}` : "Created Asaki memory review." }] };
  },
);

server.tool(
  "asaki_memory_review_list",
  "List pending or resolved Asaki memory review items. Use during explicit memory audit.",
  {
    status: z.string().optional(),
    project_id: z.string().optional(),
    session_id: z.string().optional(),
    source: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
  },
  async ({ status, project_id, session_id, source, limit, offset }) => {
    const cfg = memoryConfig();
    const body: Record<string, unknown> = { user_id: cfg.userId, project_id: resolveProjectId(project_id) };
    if (session_id || cfg.sessionId) body.session_id = session_id || cfg.sessionId;
    if (status) body.status = status;
    if (source) body.source = source;
    if (limit != null) body.limit = limit;
    if (offset != null) body.offset = offset;
    const data = await apiRequest("/v1/memories/reviews/list", body);
    const reviews = Array.isArray(data.reviews) ? (data.reviews as Record<string, unknown>[]) : [];
    if (reviews.length === 0) return { content: [{ type: "text" as const, text: "No Asaki memory reviews found." }] };
    const reviewBudget = joinWithinBudget(reviews.map((item, index) => formatReviewLine(item, index)));
    return { content: [{ type: "text" as const, text: withBudgetFooter(reviewBudget, (offset ?? 0) + reviewBudget.shown) }] };
  },
);

server.tool(
  "asaki_memory_review_resolve",
  "Resolve a pending Asaki memory review as add, merge, or ignore. Only call after explicit user approval.",
  {
    id: z.string(),
    action: z.enum(["add", "merge", "ignore"]),
    memory_id: z.string().optional(),
    reason: z.string().optional(),
  },
  async ({ id, action, memory_id, reason }) => {
    const cfg = memoryConfig();
    const body: Record<string, unknown> = { user_id: cfg.userId, action };
    if (memory_id) body.memory_id = memory_id;
    if (reason) body.reason = reason;
    const data = await apiRequest(`/v1/memories/reviews/${id}/resolve`, body);
    const review = data.review as Record<string, unknown> | undefined;
    const memory = data.memory as Record<string, unknown> | undefined;
    return { content: [{ type: "text" as const, text: `${review ? `Resolved review: ${formatReviewLine(review)}` : `Review ${id} resolved.`}${memory ? `\nMemory: ${formatLine(memory)}` : ""}` }] };
  },
);

server.tool(
  "asaki_memory_update",
  "Update an existing Asaki memory by id. Only call after explicit user approval.",
  {
    id: z.string(),
    content: z.string().optional(),
    scope: z.enum(["global", "project", "session"]).optional(),
    project_id: z.string().optional(),
    session_id: z.string().optional(),
    kind: z.string().optional(),
    importance: z.number().min(0).max(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    status: z.enum(["active", "archived", "deleted"]).optional(),
  },
  async ({ id, ...fields }) => {
    const cfg = memoryConfig();
    const body: Record<string, unknown> = { user_id: cfg.userId };
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) body[key] = value;

    const data = await apiRequest(`/v1/memories/${id}`, body, undefined, "PATCH");
    const memory = data.memory as Record<string, unknown> | undefined;
    return { content: [{ type: "text" as const, text: memory ? `Updated: ${formatLine(memory)}` : `Memory ${id} updated.` }] };
  },
);

server.tool(
  "asaki_memory_delete",
  "Soft-delete a memory from Asaki personal memory by id. Only call after explicit user approval.",
  { id: z.string() },
  async ({ id }) => {
    const cfg = memoryConfig();
    const data = await apiRequest(`/v1/memories/${id}`, { user_id: cfg.userId }, undefined, "DELETE");
    const memory = data.memory as Record<string, unknown> | undefined;
    return { content: [{ type: "text" as const, text: memory ? `Deleted: ${formatLine(memory)}` : `Memory ${id} deleted.` }] };
  },
);

await server.connect(new StdioServerTransport());
