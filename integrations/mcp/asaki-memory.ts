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
const MEMORY_CONTEXT_CONTENT_CHARS = 280;

const SCOPES = ["global", "project", "session"] as const;
const KINDS = ["preference", "rule", "fact", "decision", "task_learning", "bug_fix", "workflow"] as const;
type MemoryScope = (typeof SCOPES)[number];
type MemoryKind = (typeof KINDS)[number];
type ConfigFile = Record<string, unknown>;

// Local hard gate before any network request — server-side src/utils/sensitiveContent.ts already
// rejects these with a 400, but that's after the text has already left the machine. This is the
// same pattern independently maintained in integrations/pi/asaki-memory.ts's SENSITIVE_RE_LIST and
// integrations/claude-code/stop-extract.sh's SENSITIVE_PATTERN — keep them in sync. sk-/sk-proj-/
// sk-ant- use a hyphen (not an underscore) to actually match real OpenAI/Anthropic keys; also
// covers Slack xox- tokens, Google AIza- keys, JWTs, and user:pass@host credential URLs.
const SENSITIVE_RE_LIST = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i,
  /\bsk-[A-Za-z0-9-]{10,}\b/i,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /:\/\/[^/\s:]+:[^/\s@]{6,}@/,
  /\b(?:api[_-]?key|token|secret|password|passwd|authorization)\b\s*[:=]\s*["']?[^"'\s]{8,}/i,
  /set\s+-gx\s+\w*(?:KEY|TOKEN|SECRET|PASSWORD)\w*\s+[^$\s][^\s]{8,}/i,
];

function containsSensitiveText(text: string): boolean {
  return SENSITIVE_RE_LIST.some((pattern) => pattern.test(text));
}

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

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function assertSafeBaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid ASAKI_MEMORY_BASE_URL "${url}": baseUrl must be https:, only localhost/127.0.0.1 may use http:.`);
  }
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && LOOPBACK_HOSTNAMES.has(parsed.hostname)) return;
  throw new Error(`Unsafe ASAKI_MEMORY_BASE_URL "${url}": baseUrl must be https:, only localhost/127.0.0.1 may use http:.`);
}

async function apiRequest(path: string, body: unknown, signal?: AbortSignal, method = "POST"): Promise<Record<string, unknown>> {
  const { baseUrl, apiKey } = memoryConfig();
  assertSafeBaseUrl(baseUrl);
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

const REQUEST_TIMEOUT_MS = 20_000;

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  return controller.signal;
}

// Combines the MCP SDK's per-call cancellation signal (aborted if the caller cancels the tool
// call) with a local fallback timeout, so a hung fetch can't outlive either. AbortSignal.any is
// Node 20+; fall back to a small manual merge if unavailable.
function combinedSignal(sdkSignal: AbortSignal | undefined, timeoutMs: number = REQUEST_TIMEOUT_MS): AbortSignal {
  const timeout = timeoutSignal(timeoutMs);
  if (!sdkSignal) return timeout;
  if (typeof (AbortSignal as any).any === "function") return (AbortSignal as any).any([sdkSignal, timeout]);

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  sdkSignal.addEventListener("abort", onAbort, { once: true });
  timeout.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
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

function truncateText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function formatLine(item: Record<string, unknown>, index?: number, maxContentChars?: number): string {
  const prefix = index == null ? "" : `${index + 1}. `;
  const id = item.id ? ` id=${item.id}` : "";
  const scope = item.scope ? ` scope=${item.scope}` : "";
  const kind = item.kind ? ` kind=${item.kind}` : "";
  const status = item.status ? ` status=${item.status}` : "";
  const importance = typeof item.importance === "number" ? ` importance=${item.importance.toFixed(2)}` : "";
  const updatedAt = item.updated_at ? ` updated_at=${item.updated_at}` : "";
  const content = item.content ?? item.memory ?? item.text;
  const text = typeof content === "string" ? content : JSON.stringify(item);
  const shown = maxContentChars == null ? text : truncateText(text, maxContentChars);
  return `${prefix}${shown}${id}${scope}${kind}${status}${importance}${updatedAt}`;
}

function formatScoreDetails(details: unknown): string {
  if (!details || typeof details !== "object") return "";
  const d = details as Record<string, unknown>;
  const parts = ["semantic", "keyword", "entity", "metadata"]
    .filter((key) => typeof d[key] === "number")
    .map((key) => `${key}=${(d[key] as number).toFixed(3)}`);
  if (d.source) parts.push(`source=${d.source}`);
  return parts.length ? ` [${parts.join(" ")}]` : "";
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
  const potentialDuplicate = item.potential_duplicate && typeof item.potential_duplicate === "object" ? (item.potential_duplicate as Record<string, unknown>) : null;
  const dup = potentialDuplicate
    ? ` potential_duplicate=[memory_id=${potentialDuplicate.memory_id} suggested=${potentialDuplicate.action} reason="${potentialDuplicate.reason}"]`
    : "";
  return `${prefix}${typeof content === "string" ? content : JSON.stringify(candidate || item)}${id}${status}${action}${memoryId}${scope}${kind}${updatedAt}${dup}`;
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
    debug: z.boolean().optional().describe("Include score_details (semantic/keyword/entity/metadata breakdown) per result. Default off."),
  },
  async ({ query, top_k, scope, project_id, session_id, debug }, extra) => {
    const cfg = memoryConfig();
    const body: Record<string, unknown> = {
      query,
      user_id: cfg.userId,
      project_id: resolveProjectId(project_id),
      top_k: top_k ?? 10,
    };
    if (session_id || cfg.sessionId) body.session_id = session_id || cfg.sessionId;
    if (scope) body.scope = scope;

    const data = await apiRequest("/v1/memories/search", body, combinedSignal(extra.signal));
    const results = Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : [];
    if (results.length === 0) return { content: [{ type: "text" as const, text: "No matching Asaki memories found." }] };

    const lines = results.map((item, index) => {
      const score = typeof item.score === "number" ? ` score=${item.score.toFixed(3)}` : "";
      const similarity = typeof item.similarity === "number" ? ` similarity=${item.similarity.toFixed(3)}` : "";
      const scoreDetails = debug ? formatScoreDetails(item.score_details) : "";
      return `${formatLine(item, index, MEMORY_CONTEXT_CONTENT_CHARS)}${score}${similarity}${scoreDetails}`;
    });
    return { content: [{ type: "text" as const, text: withBudgetFooter(joinWithinBudget(lines)) }] };
  },
);

server.tool(
  "asaki_memory_add",
  "Store a durable memory in Asaki personal memory. Do not store secrets or sensitive transient data.",
  {
    text: z.string().describe("Concise, self-contained memory text to store. Preference/rule: roughly 40-160 chars. Decision/workflow/bug_fix/task_learning: 1-2 sentences, at most roughly 200-300 chars. Summarize the durable takeaway only."),
    type: z.string().optional().describe("Memory kind."),
    scope: z.enum(["global", "project", "session"]).optional().describe("Memory scope."),
    project_id: z.string().optional().describe("Project id override."),
    session_id: z.string().optional().describe("Session id override."),
    importance: z.number().min(0).max(1).optional().describe("Importance 0-1. Default 0.6."),
    confidence: z.number().min(0).max(1).optional().describe("Confidence 0-1. Default 0.9."),
  },
  async ({ text, type, scope, project_id, session_id, importance, confidence }, extra) => {
    if (containsSensitiveText(text)) {
      throw new Error("Refusing to store: text appears to contain a secret/credential (API key, token, private key, or similar). Remove it and try again.");
    }
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

    const data = await apiRequest(
      "/v1/memories/candidates",
      { user_id: cfg.userId, source: SOURCE_TAG, candidates: [candidate] },
      combinedSignal(extra.signal),
    );
    const decision = Array.isArray(data.decisions) ? (data.decisions[0] as Record<string, any> | undefined) : undefined;
    const action = decision?.action || "ok";
    const memoryId = decision?.memory?.id || decision?.matched_memory?.id;
    const reviewId = decision?.review?.id;
    const reason = decision?.reason ? `: ${decision.reason}` : "";
    return { content: [{ type: "text" as const, text: `Asaki memory ${action}${memoryId ? ` id=${memoryId}` : ""}${reviewId ? ` review_id=${reviewId}` : ""}${reason}` }] };
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
  async ({ text, scope, project_id, session_id }, extra) => {
    if (containsSensitiveText(text)) {
      throw new Error("Refusing to extract: text appears to contain a secret/credential (API key, token, private key, or similar). Remove it and try again.");
    }
    const cfg = memoryConfig();
    const projectId = resolveProjectId(project_id);
    const sessionId = session_id || cfg.sessionId || undefined;
    // No scope forced here unless the caller explicitly passes one — the server infers
    // global vs project per extracted candidate instead of lumping everything into one scope.
    const body: Record<string, unknown> = { text, user_id: cfg.userId, project_id: projectId, source: `${SOURCE_TAG}:extract` };
    if (scope) body.scope = scope;
    if (scope === "session" || (!scope && sessionId)) body.session_id = sessionId;

    const data = await apiRequest("/v1/memories/extract", body, combinedSignal(extra.signal));
    const decisions = Array.isArray(data.decisions) ? (data.decisions as Record<string, any>[]) : [];
    const reviews = Array.isArray(data.reviews) ? (data.reviews as Record<string, unknown>[]) : [];
    // Low-importance/global-scope candidates are routed to `reviews` instead of `decisions` — an
    // empty `decisions` array does not mean nothing was extracted.
    if (decisions.length === 0 && reviews.length === 0) return { content: [{ type: "text" as const, text: "No durable memories extracted." }] };

    const parts: string[] = [];
    if (decisions.length > 0) {
      parts.push(
        decisions
          .map((decision, index) => {
            const action = decision.action || "ok";
            const memoryId = decision.memory?.id || decision.matched_memory?.id;
            const reason = decision.reason ? `: ${decision.reason}` : "";
            const content = decision.candidate?.content ?? "";
            return `${index + 1}. [${action}]${memoryId ? ` id=${memoryId}` : ""} ${content}${reason}`;
          })
          .join("\n"),
      );
    }
    if (reviews.length > 0) {
      parts.push(
        `${reviews.length} candidate(s) queued for review:\n${reviews.map((item, index) => formatReviewLine(item, index)).join("\n")}`,
      );
    }
    return { content: [{ type: "text" as const, text: parts.join("\n\n") }] };
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
  async ({ scope, project_id, session_id, kind, status, limit, offset }, extra) => {
    const cfg = memoryConfig();
    const body: Record<string, unknown> = { user_id: cfg.userId, project_id: resolveProjectId(project_id) };
    if (session_id || cfg.sessionId) body.session_id = session_id || cfg.sessionId;
    if (scope) body.scope = scope;
    if (kind) body.kind = kind;
    if (status) body.status = status;
    if (limit != null) body.limit = limit;
    if (offset != null) body.offset = offset;

    const data = await apiRequest("/v1/memories/list", body, combinedSignal(extra.signal));
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
  async ({ text, type, scope, project_id, session_id, importance, confidence }, extra) => {
    if (containsSensitiveText(text)) {
      throw new Error("Refusing to create review: text appears to contain a secret/credential (API key, token, private key, or similar). Remove it and try again.");
    }
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
    const data = await apiRequest("/v1/memories/reviews", body, combinedSignal(extra.signal));
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
    include_suggestions: z.boolean().optional().describe("Attach a potential_duplicate hint (matched memory + suggested add/merge/update/delete/ignore) to each pending review. Default off."),
  },
  async ({ status, project_id, session_id, source, limit, offset, include_suggestions }, extra) => {
    const cfg = memoryConfig();
    const body: Record<string, unknown> = { user_id: cfg.userId, project_id: resolveProjectId(project_id) };
    if (session_id || cfg.sessionId) body.session_id = session_id || cfg.sessionId;
    if (status) body.status = status;
    if (source) body.source = source;
    if (limit != null) body.limit = limit;
    if (offset != null) body.offset = offset;
    if (include_suggestions) body.include_suggestions = true;
    const data = await apiRequest("/v1/memories/reviews/list", body, combinedSignal(extra.signal));
    const reviews = Array.isArray(data.reviews) ? (data.reviews as Record<string, unknown>[]) : [];
    if (reviews.length === 0) return { content: [{ type: "text" as const, text: "No Asaki memory reviews found." }] };
    const reviewBudget = joinWithinBudget(reviews.map((item, index) => formatReviewLine(item, index)));
    return { content: [{ type: "text" as const, text: withBudgetFooter(reviewBudget, (offset ?? 0) + reviewBudget.shown) }] };
  },
);

server.tool(
  "asaki_memory_review_resolve",
  "Resolve a pending Asaki memory review as add, merge, update, delete, or ignore. update/delete/merge require memory_id (the existing memory to replace/delete/merge into). Only call after explicit user approval.",
  {
    id: z.string(),
    action: z.enum(["add", "merge", "update", "delete", "ignore"]),
    memory_id: z.string().optional(),
    reason: z.string().optional(),
  },
  async ({ id, action, memory_id, reason }, extra) => {
    const cfg = memoryConfig();
    const body: Record<string, unknown> = { user_id: cfg.userId, action };
    if (memory_id) body.memory_id = memory_id;
    if (reason) body.reason = reason;
    const data = await apiRequest(`/v1/memories/reviews/${id}/resolve`, body, combinedSignal(extra.signal));
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
  async ({ id, ...fields }, extra) => {
    const cfg = memoryConfig();
    const body: Record<string, unknown> = { user_id: cfg.userId };
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) body[key] = value;

    const data = await apiRequest(`/v1/memories/${id}`, body, combinedSignal(extra.signal), "PATCH");
    const memory = data.memory as Record<string, unknown> | undefined;
    return { content: [{ type: "text" as const, text: memory ? `Updated: ${formatLine(memory)}` : `Memory ${id} updated.` }] };
  },
);

server.tool(
  "asaki_memory_delete",
  "Soft-delete a memory from Asaki personal memory by id. Only call after explicit user approval.",
  { id: z.string() },
  async ({ id }, extra) => {
    const cfg = memoryConfig();
    const data = await apiRequest(`/v1/memories/${id}`, { user_id: cfg.userId }, combinedSignal(extra.signal), "DELETE");
    const memory = data.memory as Record<string, unknown> | undefined;
    return { content: [{ type: "text" as const, text: memory ? `Deleted: ${formatLine(memory)}` : `Memory ${id} deleted.` }] };
  },
);

await server.connect(new StdioServerTransport());
