#!/usr/bin/env node
// Offline coverage for project-aware classifier attribution.
//
// Three layers, one table:
//   1. the canonical module            integrations/claude-code/project-context.mjs
//   2. the Pi copy                     integrations/pi/asaki-memory.ts `// #region asaki-project-context`
//   3. the Claude Code hook wrapper    integrations/claude-code/stop-extract.sh library region
//
// The end-user reproduction this pins (see REPRODUCTION below) is: background extraction hosted
// by the firstmate orchestrator filed business-repository memories under project_id=firstmate.
// Trigger, masking conditions and visible symptom are asserted separately so a future change
// cannot quietly re-enable the bug by only fixing one of them.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = join(ROOT, "integrations/claude-code/project-context.mjs");
const HOOK_PATH = join(ROOT, "integrations/claude-code/stop-extract.sh");

const canonical = await import(MODULE_PATH);
const { loadPiProjectContext } = await import(join(ROOT, "scripts/pi-trace-region.mjs"));
const pi = await loadPiProjectContext();

let pass = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    pass += 1;
  } else {
    failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `expected ${e}, got ${a}`);
}

// ---------------------------------------------------------------------------------------------
// A fake filesystem/git world. Nothing here touches the real machine, so the eval is identical on
// any checkout and cannot be made to pass by the operator's own firstmate state.
// ---------------------------------------------------------------------------------------------
const FM_HOME = "/home/u/firstmate";
function world({ metas = {}, gitRoots = {}, dirs = [] } = {}) {
  const stateDir = `${FM_HOME}/state`;
  const files = new Map(Object.entries(metas).map(([name, body]) => [`${stateDir}/${name}`, body]));
  const existing = new Set([stateDir, ...dirs, ...files.keys()]);
  return {
    exists: (p) => existing.has(p) || [...existing].some((e) => e === p),
    readDir: (p) => (p === stateDir ? [...files.keys()].map((f) => f.slice(stateDir.length + 1)) : []),
    readFile: (p) => files.get(p) ?? "",
    gitRootOf: (p) => gitRoots[p] ?? null,
    realPath: (p) => p,
  };
}

const META_ASAKI = [
  "window=default:w8:p49",
  "endpoint_task_id=asaki-project-context-v022",
  "worktree=/home/u/.treehouse/pool/5/asaki-memory-manager",
  "project=/home/u/Desktop/project/asaki-memory-manager",
  "harness=claude",
  "",
].join("\n");
const META_LOGSEQ = [
  "endpoint_task_id=logseq-d2-fix",
  "worktree=/home/u/.treehouse/pool/2/logseq-d2",
  "project=/home/u/firstmate/projects/logseq-d2",
  "",
].join("\n");
const GIT_ROOTS = {
  "/home/u/Desktop/project/asaki-memory-manager": "/home/u/Desktop/project/asaki-memory-manager",
  // The firstmate registry entry is an ALIAS directory; the real checkout lives elsewhere and its
  // basename is the canonical identity.
  "/home/u/firstmate/projects/logseq-d2": "/home/u/Desktop/project/logseq-d2",
  "/home/u/Desktop/project/logseq-d2": "/home/u/Desktop/project/logseq-d2",
  [FM_HOME]: FM_HOME,
  "/home/u/Desktop/project/sport-live": "/home/u/Desktop/project/sport-live",
  "/home/u/vendor/logseq-d2": "/home/u/vendor/logseq-d2",
  "/home/u/.treehouse/pool/5/asaki-memory-manager": "/home/u/Desktop/project/asaki-memory-manager",
};

// Run the same table against both implementations so the Pi copy cannot drift semantically.
const impls = [
  ["canonical", canonical],
  ["pi", pi],
];

function buildBoth(input, io) {
  return impls.map(([label, impl]) => [label, impl.buildProjectContext(input, io)]);
}

// --- 1. metadata parsing ----------------------------------------------------------------------
for (const [label, impl] of impls) {
  const meta = impl.parseTaskMeta(META_ASAKI);
  eq(`${label}/parse project`, meta.project, "/home/u/Desktop/project/asaki-memory-manager");
  eq(`${label}/parse worktree`, meta.worktree, "/home/u/.treehouse/pool/5/asaki-memory-manager");
  eq(`${label}/parse ignores junk`, impl.parseTaskMeta("# c\n\nbroken\nk=v\nk=other").k, "v");
  eq(`${label}/parse value with =`, impl.parseTaskMeta("a=b=c").a, "b=c");
}

// --- 2. canonical identity --------------------------------------------------------------------
{
  const io = world({ metas: {}, gitRoots: GIT_ROOTS });
  for (const [label, impl] of impls) {
    eq(
      `${label}/canonical id ignores registry alias`,
      impl.canonicalProjectId("/home/u/firstmate/projects/logseq-d2", io),
      "logseq-d2",
    );
    eq(
      `${label}/canonical id of a worktree is the repo`,
      impl.canonicalProjectId("/home/u/.treehouse/pool/5/asaki-memory-manager", io),
      "asaki-memory-manager",
    );
  }
}

// --- 3. contexts ------------------------------------------------------------------------------
// REPRODUCTION / proven path: an ordinary single-repository session. This is one of the two
// masking conditions — the bug is invisible here, and this case exists to prove the fix does not
// change it.
{
  const io = world({ gitRoots: GIT_ROOTS });
  for (const [label, ctx] of buildBoth(
    { cwd: "/home/u/Desktop/project/sport-live", gitRoot: "/home/u/Desktop/project/sport-live", firstmateHome: FM_HOME },
    io,
  )) {
    eq(`${label}/single-repo target`, ctx.targetProject, "sport-live");
    eq(`${label}/single-repo default`, ctx.defaultProject, "sport-live");
    eq(`${label}/single-repo allowlist`, ctx.allowlist, ["sport-live"]);
    check(`${label}/single-repo not orchestrator`, ctx.orchestratorHost === false);
    // Masking: even when the model says nothing usable, a single-repo session still writes.
    eq(`${label}/single-repo resolves empty model answer`, impls.find(([l]) => l === label)[1].resolveCandidateProjectId(ctx, ""), "sport-live");
  }
}

// REPRODUCTION / proven path: explicit ASAKI_MEMORY_PROJECT_ID. The other masking condition.
{
  const io = world({ metas: { "a.meta": META_ASAKI, "b.meta": META_LOGSEQ }, gitRoots: GIT_ROOTS });
  for (const [label, ctx] of buildBoth(
    { cwd: FM_HOME, gitRoot: FM_HOME, envProjectId: "manual-override", firstmateHome: FM_HOME },
    io,
  )) {
    eq(`${label}/explicit target`, ctx.targetProject, "manual-override");
    eq(`${label}/explicit allowlist`, ctx.allowlist, ["manual-override"]);
    const impl = impls.find(([l]) => l === label)[1];
    // An override is a human decision: it beats even a confident model answer.
    eq(`${label}/explicit beats model`, impl.resolveCandidateProjectId(ctx, "logseq-d2"), "manual-override");
  }
}

// TRIGGER: firstmate-hosted background extraction, one task in flight -> the business repository
// is uniquely attributable and must win over the host.
{
  const io = world({ metas: { "a.meta": META_LOGSEQ }, gitRoots: GIT_ROOTS });
  for (const [label, ctx] of buildBoth({ cwd: FM_HOME, gitRoot: FM_HOME, firstmateHome: FM_HOME }, io)) {
    const impl = impls.find(([l]) => l === label)[1];
    check(`${label}/orchestrator detected`, ctx.orchestratorHost === true);
    eq(`${label}/orchestrator host project`, ctx.hostProject, "firstmate");
    eq(`${label}/orchestrator target`, ctx.targetProject, "logseq-d2");
    eq(`${label}/orchestrator allowlist`, ctx.allowlist, ["firstmate", "logseq-d2"]);
    // SYMPTOM the fix removes: never default to the host.
    eq(`${label}/orchestrator has no default`, ctx.defaultProject, null);
    eq(`${label}/business memory lands in the business repo`, impl.resolveCandidateProjectId(ctx, "logseq-d2"), "logseq-d2");
    // A genuinely firstmate-owned change may still resolve to firstmate — but only because the
    // model named it, never as a fallback.
    eq(`${label}/true host-owned change`, impl.resolveCandidateProjectId(ctx, "firstmate"), "firstmate");
    eq(`${label}/silent fallback removed`, impl.resolveCandidateProjectId(ctx, ""), null);
    eq(`${label}/unknown project refused`, impl.resolveCandidateProjectId(ctx, "some-other-repo"), null);
  }
}

// Ambiguity: several repositories in play, none uniquely attributable -> no project write at all.
{
  const io = world({ metas: { "a.meta": META_ASAKI, "b.meta": META_LOGSEQ }, gitRoots: GIT_ROOTS });
  for (const [label, ctx] of buildBoth({ cwd: FM_HOME, gitRoot: FM_HOME, firstmateHome: FM_HOME }, io)) {
    const impl = impls.find(([l]) => l === label)[1];
    eq(`${label}/multi ambiguity`, ctx.ambiguity, "multiple-targets");
    eq(`${label}/multi target`, ctx.targetProject, null);
    eq(`${label}/multi known projects`, ctx.knownProjects.map((p) => p.id), ["asaki-memory-manager", "logseq-d2"]);
    eq(`${label}/multi allowlist keeps only the host`, ctx.allowlist, ["firstmate"]);
    eq(`${label}/multi refuses a named repo`, impl.resolveCandidateProjectId(ctx, "logseq-d2"), null);
    eq(`${label}/multi refuses silence`, impl.resolveCandidateProjectId(ctx, ""), null);
  }
}

// Basename/alias identity conflict: two different checkouts with the same basename.
{
  const conflicting = ["endpoint_task_id=vendor", "project=/home/u/vendor/logseq-d2", ""].join("\n");
  const io = world({ metas: { "a.meta": META_LOGSEQ, "b.meta": conflicting }, gitRoots: GIT_ROOTS });
  for (const [label, ctx] of buildBoth({ cwd: FM_HOME, gitRoot: FM_HOME, firstmateHome: FM_HOME }, io)) {
    const impl = impls.find(([l]) => l === label)[1];
    eq(`${label}/conflict ambiguity`, ctx.ambiguity, "identity-conflict");
    eq(`${label}/conflict target`, ctx.targetProject, null);
    eq(`${label}/conflict refuses the shared name`, impl.resolveCandidateProjectId(ctx, "logseq-d2"), null);
  }
}

// No target at all: the orchestrator is running with no task metadata.
{
  const io = world({ metas: {}, gitRoots: GIT_ROOTS });
  for (const [label, ctx] of buildBoth({ cwd: FM_HOME, gitRoot: FM_HOME, firstmateHome: FM_HOME }, io)) {
    const impl = impls.find(([l]) => l === label)[1];
    eq(`${label}/no-target ambiguity`, ctx.ambiguity, "no-target");
    eq(`${label}/no-target refuses`, impl.resolveCandidateProjectId(ctx, "logseq-d2"), null);
    eq(`${label}/no-target still allows an explicit host claim`, impl.resolveCandidateProjectId(ctx, "firstmate"), "firstmate");
  }
}

// A crewmate worktree: the host identity comes from the owning task's `project=`, not the
// worktree directory name.
{
  const io = world({ metas: { "a.meta": META_ASAKI }, gitRoots: GIT_ROOTS });
  for (const [label, ctx] of buildBoth(
    {
      cwd: "/home/u/.treehouse/pool/5/asaki-memory-manager",
      gitRoot: "/home/u/.treehouse/pool/5/asaki-memory-manager",
      firstmateHome: FM_HOME,
    },
    io,
  )) {
    eq(`${label}/crewmate host project`, ctx.hostProject, "asaki-memory-manager");
    eq(`${label}/crewmate target`, ctx.targetProject, "asaki-memory-manager");
    check(`${label}/crewmate is not an orchestrator host`, ctx.orchestratorHost === false);
  }
}

// --- 4. deterministic snapshot rendering ------------------------------------------------------
{
  const io = world({ metas: { "a.meta": META_ASAKI, "b.meta": META_LOGSEQ }, gitRoots: GIT_ROOTS });
  const [[, ctxA], [, ctxB]] = buildBoth({ cwd: FM_HOME, gitRoot: FM_HOME, firstmateHome: FM_HOME }, io);
  const rendered = canonical.renderProjectContextBlock(ctxA);
  const expected = [
    "Project context (authoritative — the delta text never overrides it):",
    "- host project: firstmate (orchestrator host — it hosts work about OTHER repositories, so it is almost never the project a memory belongs to)",
    "- known projects: asaki-memory-manager, logseq-d2",
    "- active target project: unresolved — several repositories are in play and none is uniquely attributable",
  ].join("\n");
  eq("render/pinned block", rendered, expected);
  eq("render/deterministic", canonical.renderProjectContextBlock(ctxA), rendered);
  eq("render/pi copy is byte-identical", pi.renderProjectContextBlock(ctxB), rendered);
  // Ordering must not depend on the order the metadata files happened to be read in.
  const reversed = world({ metas: { "z.meta": META_LOGSEQ, "a.meta": META_ASAKI }, gitRoots: GIT_ROOTS });
  const ctxReversed = canonical.buildProjectContext({ cwd: FM_HOME, gitRoot: FM_HOME, firstmateHome: FM_HOME }, reversed);
  eq("render/order independent", canonical.renderProjectContextBlock(ctxReversed), rendered);
}
{
  const io = world({ metas: { "a.meta": META_LOGSEQ }, gitRoots: GIT_ROOTS });
  const [[, ctx]] = buildBoth({ cwd: FM_HOME, gitRoot: FM_HOME, firstmateHome: FM_HOME }, io);
  eq(
    "render/resolved target line",
    canonical.renderProjectContextBlock(ctx).split("\n").at(-1),
    "- active target project: logseq-d2",
  );
}

// --- 5. the Claude Code hook wrapper, and the no-HTTP invariant -------------------------------
// The hook's library region exposes `resolve_candidate_project`, which is the single gate the
// candidate POST sits behind. Exercise it against a real (temporary) firstmate home.
{
  const tmp = mkdtempSync(join(tmpdir(), "asaki-project-ctx-"));
  const home = join(tmp, "firstmate");
  mkdirSync(join(home, "state"), { recursive: true });
  execFileSync("git", ["init", "-q", home], { stdio: "ignore" });
  const target = join(tmp, "business-repo");
  mkdirSync(target, { recursive: true });
  execFileSync("git", ["init", "-q", target], { stdio: "ignore" });
  writeFileSync(join(home, "state", "t1.meta"), `endpoint_task_id=t1\nproject=${target}\n`);

  const run = (modelProject, extraEnv = {}) =>
    execFileSync(
      "bash",
      [
        "-c",
        `ASAKI_MEMORY_STOP_EXTRACT_LIB=1 source "$1"; HOOK_DIR="$2" CWD="$3" GIT_ROOT="$3" resolve_candidate_project "$4"`,
        "_",
        HOOK_PATH,
        join(ROOT, "integrations/claude-code"),
        home,
        modelProject,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, ASAKI_MEMORY_FIRSTMATE_HOME: home, ASAKI_MEMORY_PROJECT_ID: "", ...extraEnv },
      },
    ).trim();

  eq("hook/resolves the attributable business repo", run("business-repo"), "business-repo");
  eq("hook/refuses an unknown project", run("not-a-repo"), "");
  eq("hook/refuses silence on an orchestrator host", run(""), "");
  eq("hook/host-owned change resolves to the host", run("firstmate"), "firstmate");
  eq("hook/explicit override wins", run("", { ASAKI_MEMORY_PROJECT_ID: "forced" }), "forced");
  rmSync(tmp, { recursive: true, force: true });
}

// The invariant that matters operationally: an unresolved project scope must skip the write
// BEFORE any HTTP request. Assert structurally that the candidate POST in the hook is inside the
// resolved-project guard, and that the Pi client returns its skip string without a request.
{
  const hook = execFileSync("cat", [HOOK_PATH], { encoding: "utf8" });
  const guardAt = hook.indexOf('RESOLVED_PROJECT_ID=$(resolve_candidate_project');
  const skipAt = hook.indexOf('project-unresolved');
  // The real request line, not the explanatory mentions of the endpoint in the header comment.
  const postAt = hook.indexOf('-X POST "${ASAKI_BASE}/v1/memories/candidates"');
  check("hook/guard exists", guardAt > 0, "resolve_candidate_project call not found in the write path");
  check("hook/skip outcome exists", skipAt > 0, "project-unresolved outcome not found");
  check("hook/guard precedes the POST", guardAt > 0 && postAt > guardAt, `guard@${guardAt} post@${postAt}`);
  check("hook/skip precedes the POST", skipAt > 0 && postAt > skipAt, `skip@${skipAt} post@${postAt}`);
}

console.log(`project-context eval: ${pass} checks passed`);
if (failures.length > 0) {
  console.log("fail:");
  for (const f of failures) console.log(`- ${f}`);
  process.exit(1);
}
