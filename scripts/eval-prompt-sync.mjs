#!/usr/bin/env node
// Drift guard for the classifier prompt copies.
//
// The same two system prompts exist in three places each — the Claude Code hook, the Pi
// extension, and the eval harness that is supposed to be testing what production runs. AGENTS.md
// has always said they must stay in sync; nothing enforced it, so "in sync" meant "whoever edited
// last remembered all three". This makes drift a CI failure instead.
//
// What is compared:
//   CORRECTION_SYSTEM_PROMPT  — byte-identical across all three copies.
//   CLASSIFIER_SYSTEM_PROMPT  — byte-identical across all three copies EXCEPT the first line,
//                               which names the client that will execute the write and therefore
//                               legitimately differs per client.
//   The JSON schemas          — identical between the hook and the eval harness, and both must
//                               declare project_id (the Pi client parses, it does not constrain).
// Host-language escaping is normalised first: the same text is a bash single-quoted string in two
// copies and a TypeScript template literal in the third.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "integrations/claude-code/stop-extract.sh");
const EVAL = join(ROOT, "scripts/eval-classifier.sh");
const PI = join(ROOT, "integrations/pi/asaki-memory.ts");

const failures = [];
let pass = 0;
function check(name, ok, detail = "") {
  if (ok) pass += 1;
  else failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}

// Read the shell WORD assigned to `name`, the way bash itself would: single-quoted runs are
// literal, and adjacent quoted/unquoted runs concatenate (these prompts use both — `'"'"'` in one
// place and bare `'[::1]'` concatenation in another). Stopping at the first `'` would silently
// compare a truncated prompt, which is exactly the kind of false green this file exists to stop.
function bashString(file, name) {
  const source = readFileSync(file, "utf8");
  const open = source.indexOf(`${name}=`);
  if (open < 0) throw new Error(`${name} not found in ${file}`);
  let i = open + `${name}=`.length;
  let out = "";
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'") {
      const end = source.indexOf("'", i + 1);
      if (end < 0) throw new Error(`${name} in ${file} has an unterminated single-quoted run`);
      out += source.slice(i + 1, end);
      i = end + 1;
    } else if (ch === '"') {
      const end = source.indexOf('"', i + 1);
      if (end < 0) throw new Error(`${name} in ${file} has an unterminated double-quoted run`);
      out += source.slice(i + 1, end);
      i = end + 1;
    } else if (ch === "\\") {
      out += source[i + 1] ?? "";
      i += 2;
    } else if (ch === "\n" || ch === " " || ch === "\t") {
      break; // unquoted whitespace ends the word
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function tsTemplate(file, name) {
  const source = readFileSync(file, "utf8");
  const open = source.indexOf(`const ${name} = \``);
  if (open < 0) throw new Error(`${name} not found in ${file}`);
  const start = open + `const ${name} = \``.length;
  const end = source.indexOf("`", start);
  if (end < 0) throw new Error(`${name} in ${file} is not terminated`);
  return source.slice(start, end);
}

// `\"` is a literal backslash-quote inside bash single quotes but an escaped quote inside a TS
// template literal — same prompt text, different host syntax. Compare the text the model sees.
const normalize = (text) => text.replace(/\\"/g, '"');

function comparePrompt(label, copies, { ignoreFirstLine = false } = {}) {
  const dropFirstLine = (t) => (ignoreFirstLine ? t.slice(t.indexOf("\n") + 1) : t);
  const [refName, refText] = copies[0];
  for (const [name, text] of copies.slice(1)) {
    const a = dropFirstLine(normalize(refText));
    const b = dropFirstLine(normalize(text));
    if (a === b) {
      pass += 1;
      continue;
    }
    const lineA = a.split("\n");
    const lineB = b.split("\n");
    const at = lineA.findIndex((line, i) => line !== lineB[i]);
    failures.push(
      `${label}: ${name} differs from ${refName} at line ${at + 1}\n    ${refName}: ${JSON.stringify(lineA[at])}\n    ${name}: ${JSON.stringify(lineB[at])}`,
    );
  }
}

const correction = [
  ["stop-extract.sh", bashString(HOOK, "CORRECTION_SYSTEM_PROMPT")],
  ["eval-classifier.sh", bashString(EVAL, "CORRECTION_SYSTEM_PROMPT")],
  ["pi/asaki-memory.ts", tsTemplate(PI, "CORRECTION_SYSTEM_PROMPT")],
];
comparePrompt("CORRECTION_SYSTEM_PROMPT", correction);

const legacy = [
  ["stop-extract.sh", bashString(HOOK, "CLASSIFIER_SYSTEM_PROMPT")],
  ["eval-classifier.sh", bashString(EVAL, "LEGACY_SYSTEM_PROMPT")],
  ["pi/asaki-memory.ts", tsTemplate(PI, "CLASSIFIER_SYSTEM_PROMPT")],
];
comparePrompt("CLASSIFIER_SYSTEM_PROMPT", legacy, { ignoreFirstLine: true });

// Every copy must actually carry the project-attribution contract, so a partial edit that keeps
// the three copies identical but drops the field still fails.
for (const [label, copies] of [
  ["CORRECTION_SYSTEM_PROMPT", correction],
  ["CLASSIFIER_SYSTEM_PROMPT", legacy],
]) {
  for (const [name, text] of copies) {
    check(`${label}/${name} documents project_id`, text.includes("- project_id: which repository this memory belongs to"));
    check(`${label}/${name} names the Project context block`, text.includes("Project context (authoritative"));
    check(`${label}/${name} emits project_id`, text.includes('"project_id":"<one known project id when scope=project, else empty string>"'));
  }
}

const schemas = [
  ["CLASSIFIER_SCHEMA", bashString(HOOK, "CLASSIFIER_SCHEMA"), bashString(EVAL, "LEGACY_SCHEMA")],
  ["CORRECTION_SCHEMA", bashString(HOOK, "CORRECTION_SCHEMA"), bashString(EVAL, "CORRECTION_SCHEMA")],
];
for (const [name, hookSchema, evalSchema] of schemas) {
  check(`${name} identical between the hook and the eval`, hookSchema === evalSchema);
  const parsed = JSON.parse(hookSchema);
  check(`${name} declares project_id`, parsed.properties?.project_id?.type === "string");
  check(`${name} requires project_id`, (parsed.required || []).includes("project_id"));
}

console.log(`prompt-sync eval: ${pass} checks passed`);
if (failures.length > 0) {
  console.log("fail:");
  for (const f of failures) console.log(`- ${f}`);
  process.exit(1);
}
