/**
 * Asaki Memory MCP Server — Codex integration
 *
 * Exposes asaki_memory_search / add / list / update / delete via the MCP protocol (stdio).
 *
 * Setup (one-time):
 *   cd integrations/codex && npm install
 *
 * Register in ~/.codex/config.toml:
 *   [mcp_servers.asaki-memory]
 *   command = "node"
 *   args = ["--experimental-strip-types", "/absolute/path/to/asaki-memory.ts"]
 *
 *   [mcp_servers.asaki-memory.env]
 *   ASAKI_MEMORY_API_KEY = "your-admin-api-key"
 *
 * Or via CLI:
 *   codex mcp add asaki-memory -- node --experimental-strip-types /path/to/asaki-memory.ts
 *
 * Config precedence (env vars override config file):
 *   ASAKI_MEMORY_API_KEY      required; same value as the Worker ADMIN_API_KEY secret
 *   ASAKI_MEMORY_BASE_URL     default: production Worker URL
 *   ASAKI_MEMORY_USER_ID      default: "asaki"
 *   ASAKI_MEMORY_PROJECT_ID   default: git repo basename of cwd
 *   ASAKI_MEMORY_SESSION_ID   optional
 *   ASAKI_MEMORY_DEFAULT_SCOPE default: "project"
 *
 * Config file (lower priority than env):
 *   ~/.codex/asaki-memory.json   { "apiKey": "...", "userId": "...", ... }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, dirname, resolve } from "node:path";

// ─── Constants ────────────────────────────────────────────────────────────────

const API_BASE = "https://asaki-memory-manager.wangyao1414114wy.workers.dev";
const DEFAULT_USER_ID = "asaki";
const DEFAULT_SCOPE = "project" as const;
const SOURCE_TAG = "codex";

const SCOPES = ["global", "project", "session"] as const;
const KINDS = ["preference", "rule", "fact", "decision", "task_learning", "bug_fix", "workflow"] as const;
type MemoryScope = (typeof SCOPES)[number];
type MemoryKind = (typeof KINDS)[number];
type ConfigFile = Record<string, unknown>;

// ─── Config ───────────────────────────────────────────────────────────────────

function configFilePath(): string {
  return join(homedir(), ".codex", "asaki-memory.json");
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
  for (const k of keys) {
    const v = cfg[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

function memoryConfig() {
  const file = loadConfigFile();
  return {
    baseUrl: (
      process.env.ASAKI_MEMORY_BASE_URL ||
      process.env.ASAKI_MEMORY_API_URL ||
      strVal(file, "baseUrl", "base_url", "apiUrl", "api_url") ||
      API_BASE
    ).replace(/\/$/, ""),
    apiKey:
      process.env.ASAKI_MEMORY_API_KEY ||
      process.env.MEMORY_API_KEY ||
      strVal(file, "apiKey", "api_key") ||
      "",
    userId:
      process.env.ASAKI_MEMORY_USER_ID ||
      process.env.MEMORY_USER_ID ||
      strVal(file, "userId", "user_id") ||
      DEFAULT_USER_ID,
    projectId:
      process.env.ASAKI_MEMORY_PROJECT_ID ||
      process.env.MEMORY_PROJECT_ID ||
      strVal(file, "projectId", "project_id") ||
      "",
    sessionId:
      process.env.ASAKI_MEMORY_SESSION_ID ||
      process.env.MEMORY_SESSION_ID ||
      strVal(file, "sessionId", "session_id") ||
      "",
    defaultScope:
      normalizeScope(
        process.env.ASAKI_MEMORY_DEFAULT_SCOPE || strVal(file, "defaultScope", "default_scope"),
      ) ?? DEFAULT_SCOPE,
  };
}

function normalizeScope(v: unknown): MemoryScope | undefined {
  return typeof v === "string" && SCOPES.includes(v as MemoryScope)
    ? (v as MemoryScope)
    : undefined;
}

function normalizeKind(v: unknown): MemoryKind {
  if (typeof v !== "string") return "task_learning";
  const n = v === "fixed" ? "bug_fix" : v === "learned" ? "task_learning" : v;
  return KINDS.includes(n as MemoryKind) ? (n as MemoryKind) : "task_learning";
}

// ─── Project resolution ───────────────────────────────────────────────────────

function findGitRoot(start: string): string | null {
  let cur = resolve(start || process.cwd());
  while (true) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function resolveProjectId(explicit?: string): string {
  const cfg = memoryConfig();
  if (explicit) return explicit;
  if (cfg.projectId) return cfg.projectId;
  const root = findGitRoot(process.cwd());
  return basename(root ?? resolve(process.cwd())) || "local-project";
}

// ─── API ──────────────────────────────────────────────────────────────────────

class MemoryApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function apiRequest(
  path: string,
  body: unknown,
  signal?: AbortSignal,
  method = "POST",
): Promise<Record<string, unknown>> {
  const { baseUrl, apiKey } = memoryConfig();
  if (!apiKey) {
    throw new Error(
      "ASAKI_MEMORY_API_KEY is not set. Add it to the MCP server env in ~/.codex/config.toml or to ~/.codex/asaki-memory.json.",
    );
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body == null ? undefined : JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new MemoryApiError(
      res.status,
      text,
      `Asaki Memory API ${res.status}: ${text || res.statusText}`,
    );
  }
  return res.json() as Promise<Record<string, unknown>>;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatLine(item: Record<string, unknown>, index?: number): string {
  const prefix = index == null ? "" : `${index + 1}. `;
  const id = item.id ? ` id=${item.id}` : "";
  const scope = item.scope ? ` scope=${item.scope}` : "";
  const kind = item.kind ? ` kind=${item.kind}` : "";
  const status = item.status ? ` status=${item.status}` : "";
  const importance =
    typeof item.importance === "number" ? ` importance=${(item.importance as number).toFixed(2)}` : "";
  const updatedAt = item.updated_at ? ` updated_at=${item.updated_at}` : "";
  const content = item.content ?? item.memory ?? item.text;
  return `${prefix}${typeof content === "string" ? content : JSON.stringify(item)}${id}${scope}${kind}${status}${importance}${updatedAt}`;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({ name: "asaki-memory", version: "0.1.0" });

server.tool(
  "asaki_memory_search",
  "Search Asaki personal memory. Use when the task depends on remembered preferences, prior project decisions, conventions, task learnings, or explicitly requested past context. Skip for simple standalone tasks.",
  {
    query: z.string().describe("Natural-language query for relevant memories."),
    top_k: z.number().int().min(1).max(50).optional().describe("Maximum results to return."),
    scope: z
      .enum(["global", "project", "session"])
      .optional()
      .describe("Optional scope filter. Omit to search global + current project."),
    project_id: z
      .string()
      .optional()
      .describe("Project id override. Defaults to git repo basename of cwd."),
    session_id: z.string().optional().describe("Session id override."),
  },
  async ({ query, top_k, scope, project_id, session_id }) => {
    const cfg = memoryConfig();
    const projectId = resolveProjectId(project_id);
    const sessionId = session_id || cfg.sessionId || undefined;
    const body: Record<string, unknown> = {
      query,
      user_id: cfg.userId,
      project_id: projectId,
      top_k: top_k ?? 10,
    };
    if (sessionId) body.session_id = sessionId;
    if (scope) body.scope = scope;
    const data = await apiRequest("/v1/memories/search", body);
    const results = Array.isArray(data?.results) ? (data.results as Record<string, unknown>[]) : [];
    if (results.length === 0) {
      return { content: [{ type: "text" as const, text: "No matching Asaki memories found." }] };
    }
    const text = results
      .map((item, i) => {
        const score =
          typeof item.score === "number" ? ` score=${(item.score as number).toFixed(3)}` : "";
        return `${formatLine(item, i)}${score}`;
      })
      .join("\n");
    return { content: [{ type: "text" as const, text }] };
  },
);

server.tool(
  "asaki_memory_add",
  "Store a durable memory in Asaki personal memory. Use after completing meaningful work, recording decisions, bug fixes, conventions, or user preferences. Do not store secrets or sensitive transient data.",
  {
    text: z.string().describe("Concise, self-contained memory text to store."),
    type: z
      .string()
      .optional()
      .describe(
        "Memory kind: preference, rule, fact, decision, task_learning, bug_fix, workflow.",
      ),
    scope: z
      .enum(["global", "project", "session"])
      .optional()
      .describe("Memory scope. Defaults to project."),
    project_id: z.string().optional().describe("Project id override."),
    session_id: z.string().optional().describe("Session id override."),
    importance: z.number().min(0).max(1).optional().describe("Importance 0–1. Default 0.6."),
    confidence: z.number().min(0).max(1).optional().describe("Confidence 0–1. Default 0.9."),
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
    const requestBody: Record<string, unknown> = {
      user_id: cfg.userId,
      source: SOURCE_TAG,
      candidates: [candidate],
    };
    if (resolvedScope === "project") requestBody.project_id = projectId;
    if (resolvedScope === "session") requestBody.session_id = sessionId;
    const data = await apiRequest("/v1/memories/candidates", requestBody);
    const decisions = Array.isArray(data?.decisions)
      ? (data.decisions as Record<string, unknown>[])
      : [];
    const decision = decisions[0] ?? {};
    const action = (decision.action as string) || "ok";
    const memId =
      (decision as Record<string, Record<string, unknown>>)?.memory?.id ||
      (decision as Record<string, Record<string, unknown>>)?.matched_memory?.id;
    const reason = decision.reason ? `: ${decision.reason}` : "";
    return {
      content: [
        {
          type: "text" as const,
          text: `Asaki memory ${action}${memId ? ` id=${memId}` : ""}${reason}`,
        },
      ],
    };
  },
);

server.tool(
  "asaki_memory_list",
  "List memories from Asaki personal memory with optional filters. Use during explicit memory audit.",
  {
    scope: z.enum(["global", "project", "session"]).optional(),
    project_id: z.string().optional(),
    session_id: z.string().optional(),
    kind: z
      .string()
      .optional()
      .describe(
        "Filter by kind: preference, rule, fact, decision, task_learning, bug_fix, workflow.",
      ),
    status: z
      .string()
      .optional()
      .describe("Filter by status: active (default), archived, deleted, all."),
    limit: z.number().int().min(1).max(100).optional().describe("Max memories. Default 50."),
    offset: z.number().int().min(0).optional(),
  },
  async ({ scope, project_id, session_id, kind, status, limit, offset }) => {
    const cfg = memoryConfig();
    const projectId = resolveProjectId(project_id);
    const sessionId = session_id || cfg.sessionId || undefined;
    const body: Record<string, unknown> = { user_id: cfg.userId };
    if (scope) body.scope = scope;
    if (projectId) body.project_id = projectId;
    if (sessionId) body.session_id = sessionId;
    if (kind) body.kind = kind;
    if (status) body.status = status;
    if (limit != null) body.limit = limit;
    if (offset != null) body.offset = offset;
    const data = await apiRequest("/v1/memories/list", body);
    const memories = Array.isArray(data?.memories)
      ? (data.memories as Record<string, unknown>[])
      : [];
    if (memories.length === 0) {
      return { content: [{ type: "text" as const, text: "No Asaki memories found." }] };
    }
    return {
      content: [
        { type: "text" as const, text: memories.map((m, i) => formatLine(m, i)).join("\n") },
      ],
    };
  },
);

server.tool(
  "asaki_memory_update",
  "Update an existing Asaki memory by id. Only call after the user has explicitly approved the change.",
  {
    id: z.string().describe("Memory id to update."),
    content: z.string().optional().describe("New memory content."),
    scope: z.enum(["global", "project", "session"]).optional(),
    project_id: z.string().optional(),
    session_id: z.string().optional(),
    kind: z.string().optional(),
    importance: z.number().min(0).max(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    status: z.enum(["active", "archived", "deleted"]).optional(),
  },
  async ({ id, content, scope, project_id, session_id, kind, importance, confidence, status }) => {
    const cfg = memoryConfig();
    const body: Record<string, unknown> = { user_id: cfg.userId };
    if (content !== undefined) body.content = content;
    if (scope !== undefined) body.scope = scope;
    if (project_id !== undefined) body.project_id = project_id;
    if (session_id !== undefined) body.session_id = session_id;
    if (kind !== undefined) body.kind = kind;
    if (importance !== undefined) body.importance = importance;
    if (confidence !== undefined) body.confidence = confidence;
    if (status !== undefined) body.status = status;
    const data = await apiRequest(`/v1/memories/${id}`, body, undefined, "PATCH");
    const memory = (data as Record<string, unknown>)?.memory as Record<string, unknown> | undefined;
    return {
      content: [
        {
          type: "text" as const,
          text: memory ? `Updated: ${formatLine(memory)}` : `Memory ${id} updated.`,
        },
      ],
    };
  },
);

server.tool(
  "asaki_memory_delete",
  "Soft-delete a memory from Asaki personal memory by id. Only call after the user has explicitly approved the deletion.",
  {
    id: z.string().describe("Memory id to delete."),
  },
  async ({ id }) => {
    const cfg = memoryConfig();
    const data = await apiRequest(
      `/v1/memories/${id}`,
      { user_id: cfg.userId },
      undefined,
      "DELETE",
    );
    const memory = (data as Record<string, unknown>)?.memory as Record<string, unknown> | undefined;
    return {
      content: [
        {
          type: "text" as const,
          text: memory ? `Deleted: ${formatLine(memory)}` : `Memory ${id} deleted.`,
        },
      ],
    };
  },
);

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
