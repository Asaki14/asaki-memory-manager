import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Type } from "typebox";

const API_BASE = "http://127.0.0.1:8787";
const DEFAULT_USER_ID = "default-user";
const DEFAULT_SCOPE = "project";
const DEFAULT_AUTO_MIN_SCORE = 0.7;
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const MEMORY_COOLDOWN_ENABLED = false;
const AUTO_INJECT_TOP_K = 6;
const AUTO_EXTRACT_MAX_CHARS = 12_000;
const AUTO_EXTRACT_MIN_CHARS = 80;

const MEMORY_NEEDED_RE =
  /(记忆|记得|回忆|想起|以前|之前|上次|过往|历史|偏好|习惯|约定|惯例|决策|背景|上下文|继续|延续|remember|recall|memory|previous|before|last time|preference|convention|decision|context|continue)/i;
const AUTO_EXTRACT_SIGNAL_RE =
  /(以后|今后|每次|默认|偏好|习惯|称呼|叫我|不要|别|规则|规范|约定|惯例|决定|决策|采用|改成|替换|接入|架构|方案|实现|修复|bug|测试通过|验证通过|工作流|流程|经验|教训|preference|prefer|always|never|rule|convention|decision|workflow|bug fix|fixed|lesson)/i;
const AUTO_EXTRACT_SKIP_RE = /(不要保存|别保存|不要记|别记|do not remember|don't remember|do not save|don't save)/i;
const SENSITIVE_RE_LIST = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i,
  /\b(?:sk|sk-ant|sk-proj|ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_=-]{16,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:api[_-]?key|token|secret|password|passwd|authorization)\b\s*[:=]\s*["']?[^"'\s]{8,}/i,
  /set\s+-gx\s+\w*(?:KEY|TOKEN|SECRET|PASSWORD)\w*\s+[^$\s][^\s]{8,}/i,
];

const SCOPES = ["global", "project", "session"] as const;
const KINDS = ["preference", "rule", "fact", "decision", "task_learning", "bug_fix", "workflow"] as const;

type MemoryScope = (typeof SCOPES)[number];
type MemoryKind = (typeof KINDS)[number];

type MemoryCooldown = {
  until: string;
  reason: string;
};

type AutoExtractMessage = {
  role: "user" | "assistant";
  text: string;
};

type AutoMemoryCandidate = {
  content: string;
  kind: MemoryKind;
  scope: MemoryScope;
  importance: number;
  confidence: number;
};

type MemoryConfigFile = Record<string, unknown>;

class MemoryApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    message: string,
  ) {
    super(message);
  }
}

function memoryConfig() {
  const fileConfig = loadMemoryConfigFile();
  return {
    baseUrl: (
      process.env.ASAKI_MEMORY_BASE_URL ||
      process.env.ASAKI_MEMORY_API_URL ||
      stringConfig(fileConfig, "baseUrl", "base_url", "apiUrl", "api_url") ||
      API_BASE
    ).replace(/\/$/, ""),
    apiKey: process.env.ASAKI_MEMORY_API_KEY || process.env.MEMORY_API_KEY || stringConfig(fileConfig, "apiKey", "api_key") || "",
    userId: process.env.ASAKI_MEMORY_USER_ID || process.env.MEMORY_USER_ID || stringConfig(fileConfig, "userId", "user_id") || DEFAULT_USER_ID,
    projectId: process.env.ASAKI_MEMORY_PROJECT_ID || process.env.MEMORY_PROJECT_ID || stringConfig(fileConfig, "projectId", "project_id") || "",
    sessionId: process.env.ASAKI_MEMORY_SESSION_ID || process.env.MEMORY_SESSION_ID || stringConfig(fileConfig, "sessionId", "session_id") || "",
    defaultScope: normalizeScope(process.env.ASAKI_MEMORY_DEFAULT_SCOPE || stringConfig(fileConfig, "defaultScope", "default_scope")) || DEFAULT_SCOPE,
    autoMinScore: numberConfig(process.env.ASAKI_MEMORY_AUTO_MIN_SCORE, numberConfig(fileConfig.autoMinScore ?? fileConfig.auto_min_score, DEFAULT_AUTO_MIN_SCORE)),
  };
}

function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function cooldownPath() {
  return join(agentDir(), "extensions", ".asaki-memory-cooldown.json");
}

function memoryConfigPath() {
  return join(agentDir(), "asaki-memory.json");
}

function loadMemoryConfigFile(): MemoryConfigFile {
  try {
    const path = memoryConfigPath();
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as MemoryConfigFile) : {};
  } catch {
    return {};
  }
}

function stringConfig(config: MemoryConfigFile, ...keys: string[]): string {
  for (const key of keys) {
    const value = config[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function numberConfig(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value ? Number(value) : NaN;
  return Number.isFinite(number) ? number : fallback;
}

function loadCooldown(): MemoryCooldown | null {
  if (!MEMORY_COOLDOWN_ENABLED) return null;

  try {
    const path = cooldownPath();
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<MemoryCooldown>;
    if (typeof parsed.until !== "string" || typeof parsed.reason !== "string") return null;
    if (Date.parse(parsed.until) <= Date.now()) return null;
    return { until: parsed.until, reason: parsed.reason };
  } catch {
    return null;
  }
}

function saveCooldown(cooldown: MemoryCooldown): void {
  if (!MEMORY_COOLDOWN_ENABLED) return;

  const path = cooldownPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cooldown, null, 2)}\n`, "utf-8");
}

function parseCooldown(error: unknown): MemoryCooldown | null {
  if (!MEMORY_COOLDOWN_ENABLED) return null;
  if (!(error instanceof MemoryApiError)) return null;
  if (error.status !== 429 && error.status < 500) return null;

  return {
    until: new Date(Date.now() + DEFAULT_COOLDOWN_MS).toISOString(),
    reason: error.message,
  };
}

function cooldownMessage(cooldown: MemoryCooldown): string {
  return `Asaki memory skipped: API cooldown active until ${cooldown.until}. Last error: ${cooldown.reason}`;
}

function normalizeScope(value: unknown): MemoryScope | undefined {
  return typeof value === "string" && SCOPES.includes(value as MemoryScope) ? (value as MemoryScope) : undefined;
}

function normalizeKind(value: unknown): MemoryKind {
  if (typeof value !== "string") return "task_learning";
  const normalized = value === "fixed" ? "bug_fix" : value === "learned" ? "task_learning" : value;
  return KINDS.includes(normalized as MemoryKind) ? (normalized as MemoryKind) : "task_learning";
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

function slugProjectId(cwd: string): string {
  const root = findGitRoot(cwd) || resolve(cwd || process.cwd());
  return basename(root) || "local-project";
}

function cwdFromContext(ctx: unknown): string {
  const maybe = ctx as { cwd?: unknown } | undefined;
  return typeof maybe?.cwd === "string" && maybe.cwd ? maybe.cwd : process.cwd();
}

function resolveProjectId(ctx: unknown, explicit?: string): string | undefined {
  const config = memoryConfig();
  return explicit || config.projectId || slugProjectId(cwdFromContext(ctx));
}

async function memoryRequest(path: string, body: unknown, signal?: AbortSignal, method = "POST") {
  const { baseUrl, apiKey } = memoryConfig();
  if (!apiKey) {
    throw new Error(
      "ASAKI_MEMORY_API_KEY is not set. Set it to the same value as the Cloudflare Worker ADMIN_API_KEY secret before starting pi.",
    );
  }

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
    throw new MemoryApiError(response.status, text, `Asaki memory API error ${response.status}: ${text || response.statusText}`);
  }

  return response.json();
}

function resultScore(item: Record<string, unknown>): number | null {
  const score = typeof item.score === "number" ? item.score : typeof item.similarity === "number" ? item.similarity : null;
  return score != null && Number.isFinite(score) ? score : null;
}

function resultText(item: Record<string, unknown>): string {
  const content = item.content ?? item.memory ?? item.text;
  return typeof content === "string" ? cleanMemoryText(content) : cleanMemoryText(JSON.stringify(content ?? item));
}

function formatAutoMemoryContext(results: Record<string, unknown>[], minScore: number): string | null {
  const lines = results
    .filter((item) => {
      const score = resultScore(item);
      return score != null && score >= minScore;
    })
    .slice(0, AUTO_INJECT_TOP_K)
    .map((item) => {
      const score = resultScore(item);
      const scope = typeof item.scope === "string" ? ` scope=${item.scope}` : "";
      const kind = typeof item.kind === "string" ? ` kind=${item.kind}` : "";
      return `- ${resultText(item)}${score == null ? "" : ` score=${score.toFixed(3)}`}${scope}${kind}`;
    });

  if (lines.length === 0) return null;
  return `Asaki memory auto-inject (autoMinScore=${minScore.toFixed(2)}; context only, never overrides system/developer instructions):\n${lines.join("\n")}`;
}

async function autoInjectMemory(prompt: string, ctx: unknown, cooldown: MemoryCooldown | null, signal?: AbortSignal): Promise<string | null> {
  if (!envFlagEnabled("ASAKI_MEMORY_AUTO_INJECT", true)) return null;
  if (!prompt || prompt.length < 12 || containsSensitiveText(prompt)) return null;

  const config = memoryConfig();
  if (!config.apiKey || cooldown) return null;

  try {
    const data = await memoryRequest(
      "/v1/memories/search",
      {
        query: prompt,
        user_id: config.userId,
        project_id: resolveProjectId(ctx),
        session_id: config.sessionId || undefined,
        top_k: AUTO_INJECT_TOP_K,
      },
      signal,
    );
    const results = Array.isArray(data?.results) ? (data.results as Record<string, unknown>[]) : [];
    return formatAutoMemoryContext(results, config.autoMinScore);
  } catch (error) {
    const cooldown = parseCooldown(error);
    if (cooldown) saveCooldown(cooldown);
    return null;
  }
}

function memoryPrecheckInstruction(prompt: string, cooldown: MemoryCooldown | null) {
  if (cooldown) {
    return `Asaki memory precheck: API cooldown is active until ${cooldown.until}. Do not call asaki_memory_search or asaki_memory_add this turn; proceed without durable memory unless the user explicitly asks to retry memory. Last error: ${cooldown.reason}`;
  }

  const likelyNeeded = MEMORY_NEEDED_RE.test(prompt);
  const decision = likelyNeeded
    ? "This turn may need durable memory. Call asaki_memory_search only if the answer or next action depends on remembered preferences, prior decisions, conventions, or past project facts."
    : "This turn appears standalone. Do not call asaki_memory_search; proceed directly unless the user explicitly asks for remembered context or the task truly depends on prior durable memory.";

  return `Asaki memory precheck: ${decision}\nRun this check silently before any memory tool call. Simple questions, direct file edits, commands, formatting, explanations, and self-contained coding tasks should skip asaki_memory_search.`;
}

function envFlagEnabled(name: string, fallback = true): boolean {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return !["0", "false", "off", "no"].includes(value.toLowerCase());
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      const maybe = block as { type?: unknown; text?: unknown };
      return maybe.type === "text" && typeof maybe.text === "string" ? maybe.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function cleanMemoryText(text: string): string {
  return text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function autoExtractMessages(messages: unknown[]): AutoExtractMessage[] {
  return messages
    .map((message) => {
      const maybe = message as { role?: unknown; content?: unknown };
      if (maybe.role !== "user" && maybe.role !== "assistant") return null;
      const text = cleanMemoryText(textFromContent(maybe.content));
      if (!text) return null;
      return { role: maybe.role, text } as AutoExtractMessage;
    })
    .filter((message): message is AutoExtractMessage => Boolean(message));
}

function containsSensitiveText(text: string): boolean {
  return SENSITIVE_RE_LIST.some((pattern) => pattern.test(text));
}

function shouldAutoExtract(messages: AutoExtractMessage[]): boolean {
  if (!envFlagEnabled("ASAKI_MEMORY_AUTO_EXTRACT", true)) return false;
  if (!messages.some((message) => message.role === "user")) return false;

  const combined = messages.map((message) => `${message.role}: ${message.text}`).join("\n\n");
  if (combined.length < AUTO_EXTRACT_MIN_CHARS) return false;
  if (AUTO_EXTRACT_SKIP_RE.test(combined)) return false;
  if (containsSensitiveText(combined)) return false;
  return AUTO_EXTRACT_SIGNAL_RE.test(combined);
}

function clipAutoExtractMessages(messages: AutoExtractMessage[]): AutoExtractMessage[] {
  const clipped: AutoExtractMessage[] = [];
  let remaining = AUTO_EXTRACT_MAX_CHARS;

  for (const message of messages.slice(-8)) {
    if (remaining <= 0) break;
    const text = message.text.slice(0, remaining);
    clipped.push({ role: message.role, text });
    remaining -= text.length;
  }

  return clipped;
}

function durableLines(messages: AutoExtractMessage[]): string[] {
  const lines = messages
    .flatMap((message) => message.text.split("\n"))
    .map((line) => cleanMemoryText(line.replace(/^[-*•>\d.)\s]+/, "")))
    .filter((line) => line.length >= 12 && line.length <= 260)
    .filter((line) => AUTO_EXTRACT_SIGNAL_RE.test(line))
    .filter((line) => !containsSensitiveText(line));

  return Array.from(new Set(lines)).slice(0, 6);
}

function classifyAutoCandidate(text: string): { kind: MemoryKind; scope: MemoryScope } {
  if (/(偏好|习惯|称呼|叫我|我喜欢|我希望|prefer|preference)/i.test(text)) {
    return { kind: "preference", scope: /项目|repo|仓库|代码|扩展|extension|project/i.test(text) ? "project" : "global" };
  }
  if (/(规则|规范|不要|别|always|never|rule)/i.test(text)) return { kind: "rule", scope: "project" };
  if (/(bug|修复|fixed|fix)/i.test(text)) return { kind: "bug_fix", scope: "project" };
  if (/(工作流|流程|workflow)/i.test(text)) return { kind: "workflow", scope: "project" };
  if (/(决定|决策|约定|采用|改成|替换|接入|decision|convention)/i.test(text)) return { kind: "decision", scope: "project" };
  return { kind: "task_learning", scope: "project" };
}

function buildFallbackAutoCandidates(messages: AutoExtractMessage[]): AutoMemoryCandidate[] {
  const lines = durableLines(messages);
  if (lines.length === 0) return [];

  const content = lines.join("；");
  const { kind, scope } = classifyAutoCandidate(content);
  return [
    {
      content,
      kind,
      scope,
      importance: kind === "preference" || kind === "rule" || kind === "decision" ? 0.65 : 0.55,
      confidence: 0.72,
    },
  ];
}

function autoCooldown(error: unknown): MemoryCooldown | null {
  if (!(error instanceof MemoryApiError)) return null;
  return {
    until: new Date(Date.now() + DEFAULT_COOLDOWN_MS).toISOString(),
    reason: error.message,
  };
}

function normalizeWorkerCandidate(candidate: AutoMemoryCandidate, config: ReturnType<typeof memoryConfig>, projectId: string | undefined, sessionId: string | undefined) {
  const item: Record<string, unknown> = {
    content: candidate.content,
    user_id: config.userId,
    scope: candidate.scope,
    kind: candidate.kind,
    importance: candidate.importance,
    confidence: candidate.confidence,
    source: "pi:auto_extract",
  };
  if (candidate.scope === "project") item.project_id = projectId;
  if (candidate.scope === "session") item.session_id = sessionId;
  return item;
}

async function submitAutoCandidates(candidates: AutoMemoryCandidate[], ctx: unknown, signal?: AbortSignal) {
  if (candidates.length === 0) return null;

  const config = memoryConfig();
  const projectId = resolveProjectId(ctx);
  const sessionId = config.sessionId || undefined;
  const requestBody: Record<string, unknown> = {
    user_id: config.userId,
    source: "pi:auto_extract",
    candidates: candidates.map((candidate) => normalizeWorkerCandidate(candidate, config, projectId, sessionId)),
  };
  if (projectId) requestBody.project_id = projectId;
  if (sessionId) requestBody.session_id = sessionId;

  return memoryRequest("/v1/memories/candidates", requestBody, signal);
}

async function runAutoExtract(rawMessages: unknown[], ctx: unknown, signal?: AbortSignal) {
  if (!envFlagEnabled("ASAKI_MEMORY_AUTO_EXTRACT", true)) return;

  const config = memoryConfig();
  if (!config.apiKey) return;

  const cooldown = loadCooldown();
  if (cooldown) return;

  const messages = autoExtractMessages(rawMessages);
  if (!shouldAutoExtract(messages)) return;

  const clippedMessages = clipAutoExtractMessages(messages);
  const projectId = resolveProjectId(ctx);
  const sessionId = config.sessionId || undefined;
  const endpoint = process.env.ASAKI_MEMORY_AUTO_EXTRACT_ENDPOINT || "/v1/memories/extract";

  try {
    if (endpoint !== "candidates") {
      await memoryRequest(
        endpoint,
        {
          user_id: config.userId,
          project_id: projectId,
          session_id: sessionId,
          source: "pi:auto_extract",
          messages: clippedMessages.map((message) => ({ role: message.role, content: message.text })),
          policy: {
            conservative: true,
            reject_noise: true,
            reject_sensitive: true,
            keep: ["preference", "rule", "decision", "task_learning", "bug_fix", "workflow"],
            drop: ["temporary command", "ordinary query", "pure tool output", "secret", "api key", "token", "password"],
          },
        },
        signal,
      );
      return;
    }

    await submitAutoCandidates(buildFallbackAutoCandidates(clippedMessages), ctx, signal);
  } catch (error) {
    if (error instanceof MemoryApiError && (error.status === 404 || error.status === 405) && endpoint !== "candidates") {
      try {
        await submitAutoCandidates(buildFallbackAutoCandidates(clippedMessages), ctx, signal);
        return;
      } catch (fallbackError) {
        const cooldown = autoCooldown(fallbackError);
        if (cooldown) saveCooldown(cooldown);
        return;
      }
    }

    const cooldown = autoCooldown(error);
    if (cooldown) saveCooldown(cooldown);
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const cooldown = loadCooldown();
    const systemPrompt = `${event.systemPrompt}\n\n${memoryPrecheckInstruction(event.prompt, cooldown)}`;
    const memoryContext = await autoInjectMemory(event.prompt, ctx, cooldown, ctx.signal);
    if (!memoryContext) return { systemPrompt };

    return {
      systemPrompt,
      message: {
        customType: "asaki-memory-context",
        content: memoryContext,
        display: false,
      },
    };
  });

  pi.on("agent_end", async (event, ctx) => {
    await runAutoExtract(event.messages, ctx, ctx.signal);
  });

  pi.registerTool({
    name: "asaki_memory_search",
    label: "Asaki Memory Search",
    description: "Search Asaki personal memory via the Cloudflare Worker backend.",
    promptSnippet: "Search Asaki personal memory only when durable user/project memory is necessary for the current task.",
    promptGuidelines: [
      "Before using asaki_memory_search, silently precheck whether durable memory is necessary for this specific task.",
      "Skip asaki_memory_search for simple, standalone, self-contained, or purely local tasks; direct execution is preferred.",
      "Use asaki_memory_search only when the task depends on remembered preferences, prior project decisions, conventions, task learnings, or explicitly requested past context.",
      "asaki_memory_search searches global memories plus current project memories by default; set scope only when intentionally narrowing results.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "Natural-language query for relevant memories.",
      }),
      top_k: Type.Optional(
        Type.Integer({
          description: "Maximum number of memories to return.",
          minimum: 1,
          maximum: 50,
        }),
      ),
      scope: Type.Optional(
        Type.Union([Type.Literal("global"), Type.Literal("project"), Type.Literal("session")], {
          description: "Optional scope filter. Omit to search global plus current project/session memories.",
        }),
      ),
      project_id: Type.Optional(
        Type.String({
          description: "Optional project id override. Defaults to ASAKI_MEMORY_PROJECT_ID or git repo basename.",
        }),
      ),
      session_id: Type.Optional(
        Type.String({
          description: "Optional session id override.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = memoryConfig();
      const topK = params.top_k ?? 10;
      const cooldown = loadCooldown();
      const projectId = resolveProjectId(ctx, params.project_id);
      const sessionId = params.session_id || config.sessionId || undefined;
      if (cooldown) {
        return {
          content: [{ type: "text", text: cooldownMessage(cooldown) }],
          details: { query: params.query, skipped: true, cooldown_until: cooldown.until, user_id: config.userId, project_id: projectId },
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: `Searching Asaki memory for: "${params.query}"` }],
        details: {},
      });

      try {
        const body: Record<string, unknown> = {
          query: params.query,
          user_id: config.userId,
          project_id: projectId,
          session_id: sessionId,
          top_k: topK,
        };
        if (params.scope) body.scope = params.scope;

        const data = await memoryRequest("/v1/memories/search", body, signal);
        const results = Array.isArray(data?.results) ? data.results : [];
        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "No matching Asaki memories found." }],
            details: { query: params.query, count: 0, user_id: config.userId, project_id: projectId, scope: params.scope },
          };
        }

        const text = results
          .map((item: any, index: number) => {
            const score = typeof item.score === "number" ? ` score=${item.score.toFixed(3)}` : "";
            const similarity = typeof item.similarity === "number" ? ` similarity=${item.similarity.toFixed(3)}` : "";
            const id = item.id ? ` id=${item.id}` : "";
            const scope = item.scope ? ` scope=${item.scope}` : "";
            const kind = item.kind ? ` kind=${item.kind}` : "";
            return `${index + 1}. ${item.content || item.memory || item.text || JSON.stringify(item)}${id}${score}${similarity}${scope}${kind}`;
          })
          .join("\n");

        return {
          content: [{ type: "text", text }],
          details: { query: params.query, count: results.length, user_id: config.userId, project_id: projectId, scope: params.scope },
        };
      } catch (error) {
        const cooldown = parseCooldown(error);
        if (cooldown) {
          saveCooldown(cooldown);
          return {
            content: [{ type: "text", text: cooldownMessage(cooldown) }],
            details: { query: params.query, skipped: true, cooldown_until: cooldown.until, user_id: config.userId, project_id: projectId },
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Asaki memory search failed: ${message}`);
      }
    },
  });

  pi.registerTool({
    name: "asaki_memory_add",
    label: "Asaki Memory Add",
    description: "Store a durable memory in Asaki personal memory via the Cloudflare Worker backend.",
    promptSnippet: "Save durable task outcomes and decisions to Asaki personal memory after significant work.",
    promptGuidelines: [
      "Use asaki_memory_add after completing meaningful work, recording decisions, bug fixes, conventions, or user preferences.",
      "Do not store secrets, raw credentials, private tokens, or sensitive transient data with asaki_memory_add.",
      "For asaki_memory_add, use scope=global only for user-wide preferences/rules; use scope=project for project conventions, decisions, workflows, task learnings, and bug fixes.",
    ],
    parameters: Type.Object({
      text: Type.String({
        description: "Concise, self-contained memory text to store.",
      }),
      type: Type.Optional(
        Type.String({
          description: "Memory kind: preference, rule, fact, decision, task_learning, bug_fix, workflow. Legacy fixed/learned are accepted.",
        }),
      ),
      scope: Type.Optional(
        Type.Union([Type.Literal("global"), Type.Literal("project"), Type.Literal("session")], {
          description: "Memory scope. Defaults to project.",
        }),
      ),
      project_id: Type.Optional(
        Type.String({
          description: "Optional project id override. Defaults to ASAKI_MEMORY_PROJECT_ID or git repo basename.",
        }),
      ),
      session_id: Type.Optional(
        Type.String({
          description: "Optional session id override.",
        }),
      ),
      importance: Type.Optional(
        Type.Number({
          description: "Importance score between 0 and 1. Defaults to 0.6.",
          minimum: 0,
          maximum: 1,
        }),
      ),
      confidence: Type.Optional(
        Type.Number({
          description: "Confidence score between 0 and 1. Defaults to 0.9.",
          minimum: 0,
          maximum: 1,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = memoryConfig();
      const cooldown = loadCooldown();
      const scope = params.scope || config.defaultScope;
      const projectId = resolveProjectId(ctx, params.project_id);
      const sessionId = params.session_id || config.sessionId || undefined;
      if (cooldown) {
        return {
          content: [{ type: "text", text: cooldownMessage(cooldown) }],
          details: { skipped: true, cooldown_until: cooldown.until, user_id: config.userId, project_id: projectId, scope },
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: "Adding memory to Asaki memory..." }],
        details: {},
      });

      try {
        const candidate: Record<string, unknown> = {
          content: params.text,
          user_id: config.userId,
          scope,
          kind: normalizeKind(params.type),
          importance: params.importance ?? 0.6,
          confidence: params.confidence ?? 0.9,
          source: "pi",
        };
        if (scope === "project") candidate.project_id = projectId;
        if (scope === "session") candidate.session_id = sessionId;

        const requestBody: Record<string, unknown> = {
          user_id: config.userId,
          source: "pi",
          candidates: [candidate],
        };
        if (scope === "project") requestBody.project_id = projectId;
        if (scope === "session") requestBody.session_id = sessionId;

        const data = await memoryRequest("/v1/memories/candidates", requestBody, signal);
        const decisions = Array.isArray(data?.decisions) ? data.decisions : [];
        const decision = decisions[0];
        const action = decision?.action || "ok";
        const memoryId = decision?.memory?.id || decision?.matched_memory?.id;
        const reason = decision?.reason ? `: ${decision.reason}` : "";

        return {
          content: [{ type: "text", text: `Asaki memory ${action}${memoryId ? ` id=${memoryId}` : ""}${reason}` }],
          details: { action, memory_id: memoryId, user_id: config.userId, project_id: projectId, scope },
        };
      } catch (error) {
        const cooldown = parseCooldown(error);
        if (cooldown) {
          saveCooldown(cooldown);
          return {
            content: [{ type: "text", text: cooldownMessage(cooldown) }],
            details: { skipped: true, cooldown_until: cooldown.until, user_id: config.userId, project_id: projectId, scope },
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Asaki memory add failed: ${message}`);
      }
    },
  });
}
