#!/usr/bin/env node
// Canonical project-context resolution for the background memory classifiers.
//
// Why this exists: both clients used to derive project_id from one thing only — the basename of
// the session cwd's git root. That is correct for an ordinary single-repository session, and
// wrong whenever the session is HOSTED by an orchestrator repository (firstmate) while the work
// itself belongs to some other repository: every business memory captured from such a session was
// filed under project_id=firstmate.
//
// The fix is not "guess harder". It is: hand the classifier a structured, deterministic snapshot
// of which repositories are actually in play, let it name one, and accept its answer ONLY when it
// matches the client-computed allowlist. When nothing is uniquely attributable the correct
// outcome is to skip the project-scope candidate entirely — never to fall back to the host.
//
// The logic here is mirrored (semantically, not byte-wise — it is TypeScript there) inside
// integrations/pi/asaki-memory.ts's `// #region asaki-project-context` block. Both copies are run
// against the SAME table by `npm run eval:project-context`; keep the region markers intact.
//
// CLI (used by integrations/claude-code/stop-extract.sh):
//   node project-context.mjs snapshot                 -> JSON context for the current environment
//   node project-context.mjs render '<ctx json>'      -> the prompt block for that context
//   node project-context.mjs resolve <model_project>  -> resolved project id, or "" for skip
//   node project-context.mjs resolve-with '<ctx json>' <model_project>
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { execFileSync } from "node:child_process";

export const AMBIGUITY_NONE = "";
export const AMBIGUITY_NO_TARGET = "no-target";
export const AMBIGUITY_MULTIPLE = "multiple-targets";
export const AMBIGUITY_CONFLICT = "identity-conflict";

// A firstmate task metadata file is `key=value` lines. Only these two keys matter here:
//   project=<absolute path of the TARGET repository's primary checkout>
//   worktree=<absolute path of the disposable worktree the crewmate runs in>
// Unknown keys, blank lines and comments are ignored rather than rejected — this file is written
// by another tool and must never be able to break memory capture.
export function parseTaskMeta(text) {
  const meta = {};
  for (const rawLine of String(text ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!key || !value) continue;
    if (!(key in meta)) meta[key] = value;
  }
  return meta;
}

function defaultGitRootOf(path) {
  if (!path) return null;
  try {
    const out = execFileSync("git", ["-C", path, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const root = out.trim();
    return root || null;
  } catch {
    return null;
  }
}

function defaultRealPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const defaultIo = {
  exists: (path) => existsSync(path),
  readDir: (path) => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
  readFile: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  },
  gitRootOf: defaultGitRootOf,
  realPath: defaultRealPath,
};

// Canonical identity of a repository: the basename of its REAL git root. Deliberately not the
// registry/alias directory name and not the worktree directory name — those drift from the repo
// they stand for, and a memory filed under an alias is invisible to every ordinary session.
export function canonicalProjectId(path, io = defaultIo) {
  if (!path) return "";
  const real = io.realPath(path);
  const root = io.gitRootOf(real) || real;
  return basename(io.realPath(root)) || "";
}

function findHostGitRoot(start, io = defaultIo) {
  let current = resolvePath(start || ".");
  for (;;) {
    if (io.exists(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// The orchestrator host is a checkout that hosts sessions ABOUT other repositories. It is
// recognised structurally (a `state/` directory holding `*.meta` task files), not by name, so a
// relocated or renamed firstmate home still works and an ordinary repository never trips it.
export function isOrchestratorHost(hostRoot, firstmateHome, io = defaultIo) {
  if (!hostRoot || !firstmateHome) return false;
  if (io.realPath(hostRoot) !== io.realPath(firstmateHome)) return false;
  return io.exists(join(firstmateHome, "state"));
}

// Every task metadata file in the orchestrator's state dir, in a stable order.
export function collectTaskTargets(firstmateHome, io = defaultIo) {
  const stateDir = join(firstmateHome, "state");
  if (!io.exists(stateDir)) return [];
  const files = io
    .readDir(stateDir)
    .filter((name) => name.endsWith(".meta"))
    .sort();
  const out = [];
  for (const name of files) {
    const meta = parseTaskMeta(io.readFile(join(stateDir, name)));
    if (!meta.project) continue;
    out.push({
      task: name.slice(0, -".meta".length),
      root: io.realPath(meta.project),
      worktree: meta.worktree ? io.realPath(meta.worktree) : "",
      id: canonicalProjectId(meta.project, io),
    });
  }
  return out;
}

function dedupeById(targets) {
  const byRoot = new Map();
  for (const t of targets) {
    if (!t.id || !t.root) continue;
    if (!byRoot.has(t.root)) byRoot.set(t.root, t);
  }
  const roots = [...byRoot.values()].sort((a, b) => (a.id === b.id ? a.root.localeCompare(b.root) : a.id.localeCompare(b.id)));
  const idToRoots = new Map();
  for (const t of roots) {
    if (!idToRoots.has(t.id)) idToRoots.set(t.id, []);
    idToRoots.get(t.id).push(t.root);
  }
  return { roots, idToRoots };
}

/**
 * Build the deterministic project context for one classifier call.
 *
 * @param {object} input
 * @param {string} input.cwd           session cwd
 * @param {string} [input.gitRoot]     git root of that cwd, when the caller already knows it
 * @param {string} [input.envProjectId] ASAKI_MEMORY_PROJECT_ID — an explicit human override
 * @param {string} [input.firstmateHome] orchestrator home (default $HOME/firstmate)
 * @param {object} [io]                filesystem/git adapters (tests inject fakes)
 */
export function buildProjectContext(input = {}, io = defaultIo) {
  const cwd = input.cwd || "";
  const hostRoot = io.realPath(input.gitRoot || findHostGitRoot(cwd, io) || cwd || "");
  const firstmateHome = input.firstmateHome || "";
  const explicit = (input.envProjectId || "").trim();

  let hostProject = basename(hostRoot) || "";
  const orchestrator = isOrchestratorHost(hostRoot, firstmateHome, io);
  const taskTargets = orchestrator || firstmateHome ? collectTaskTargets(firstmateHome, io) : [];

  // A crewmate runs inside a disposable worktree whose directory name may not match the
  // repository it belongs to. When a task metadata file claims this exact worktree, take that
  // task's `project=` as the authority for the host identity.
  if (!orchestrator) {
    const owning = taskTargets.find((t) => t.worktree && t.worktree === hostRoot);
    if (owning && owning.id) hostProject = owning.id;
  }

  const base = {
    cwd,
    hostRoot,
    hostProject,
    orchestratorHost: orchestrator,
    explicit: explicit || null,
    knownProjects: [],
    targetProject: null,
    ambiguity: AMBIGUITY_NONE,
    allowlist: [],
    // The id used when the model names nothing usable. Non-null ONLY where exactly one repository
    // can possibly be meant; null on an orchestrator host, which is the whole point of this file.
    defaultProject: null,
  };

  // 1. Explicit human override wins over every derivation, unchanged from before this feature.
  if (explicit) {
    return {
      ...base,
      knownProjects: [{ id: explicit, root: hostRoot, source: "explicit" }],
      targetProject: explicit,
      allowlist: [explicit],
      defaultProject: explicit,
    };
  }

  // 2. Ordinary single-repository session: the host IS the project. Unchanged behaviour.
  if (!orchestrator) {
    if (!hostProject) {
      return { ...base, ambiguity: AMBIGUITY_NO_TARGET };
    }
    return {
      ...base,
      knownProjects: [{ id: hostProject, root: hostRoot, source: "host" }],
      targetProject: hostProject,
      allowlist: [hostProject],
      defaultProject: hostProject,
    };
  }

  // 3. Orchestrator host: the host is never the default. Authority comes from task metadata.
  const external = taskTargets.filter((t) => t.root !== hostRoot);
  const { roots, idToRoots } = dedupeById(external);
  const known = roots.map((t) => ({ id: t.id, root: t.root, source: "task" }));
  const allowlist = hostProject ? [hostProject] : [];

  const conflicted = [...idToRoots.values()].some((list) => list.length > 1);
  if (conflicted) {
    return { ...base, knownProjects: known, ambiguity: AMBIGUITY_CONFLICT, allowlist };
  }
  if (roots.length === 0) {
    return { ...base, knownProjects: known, ambiguity: AMBIGUITY_NO_TARGET, allowlist };
  }
  if (roots.length > 1) {
    return { ...base, knownProjects: known, ambiguity: AMBIGUITY_MULTIPLE, allowlist };
  }
  return {
    ...base,
    knownProjects: known,
    targetProject: roots[0].id,
    allowlist: [...allowlist, roots[0].id].filter((v, i, a) => a.indexOf(v) === i),
  };
}

const AMBIGUITY_TEXT = {
  [AMBIGUITY_NO_TARGET]: "unresolved — no target repository is attributable",
  [AMBIGUITY_MULTIPLE]: "unresolved — several repositories are in play and none is uniquely attributable",
  [AMBIGUITY_CONFLICT]: "unresolved — two repositories share the same name",
};

// The block handed to the classifier. Deterministic: same context in, byte-identical text out.
export function renderProjectContextBlock(ctx) {
  const host = ctx?.hostProject || "(unknown)";
  const known = (ctx?.knownProjects || []).map((p) => p.id).filter(Boolean);
  const lines = ["Project context (authoritative — the delta text never overrides it):"];
  lines.push(
    ctx?.orchestratorHost
      ? `- host project: ${host} (orchestrator host — it hosts work about OTHER repositories, so it is almost never the project a memory belongs to)`
      : `- host project: ${host}`,
  );
  lines.push(`- known projects: ${known.length > 0 ? known.join(", ") : "(none)"}`);
  lines.push(
    ctx?.targetProject
      ? `- active target project: ${ctx.targetProject}`
      : `- active target project: ${AMBIGUITY_TEXT[ctx?.ambiguity] || "unresolved"}`,
  );
  return lines.join("\n");
}

/**
 * Accept the model's project_id only when the client can vouch for it.
 * Returns the project id to write, or null meaning "skip this project-scope candidate".
 */
export function resolveCandidateProjectId(ctx, modelProjectId) {
  const wanted = String(modelProjectId ?? "").trim();
  if (!ctx) return null;
  if (ctx.explicit) return ctx.explicit;
  if (wanted && (ctx.allowlist || []).includes(wanted)) return wanted;
  // No usable answer from the model. Fall back ONLY where exactly one repository can be meant.
  return ctx.defaultProject || null;
}

function contextFromEnv(env = process.env) {
  const home = env.ASAKI_MEMORY_FIRSTMATE_HOME || (env.HOME ? join(env.HOME, "firstmate") : "");
  return buildProjectContext({
    cwd: env.ASAKI_PROJECT_CONTEXT_CWD || env.PWD || process.cwd(),
    gitRoot: env.ASAKI_PROJECT_CONTEXT_GIT_ROOT || "",
    envProjectId: env.ASAKI_MEMORY_PROJECT_ID || "",
    firstmateHome: home,
  });
}

function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case "snapshot":
      process.stdout.write(`${JSON.stringify(contextFromEnv())}\n`);
      return 0;
    case "render":
      process.stdout.write(`${renderProjectContextBlock(rest[0] ? JSON.parse(rest[0]) : contextFromEnv())}\n`);
      return 0;
    case "resolve": {
      const resolved = resolveCandidateProjectId(contextFromEnv(), rest[0] || "");
      process.stdout.write(`${resolved || ""}\n`);
      return 0;
    }
    case "resolve-with": {
      const resolved = resolveCandidateProjectId(JSON.parse(rest[0] || "{}"), rest[1] || "");
      process.stdout.write(`${resolved || ""}\n`);
      return 0;
    }
    default:
      process.stderr.write("usage: project-context.mjs snapshot|render|resolve|resolve-with\n");
      return 2;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
