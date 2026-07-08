import { readFileSync } from 'node:fs';
import { lexicalSimilarity, type ProcessMemoryCandidateInput } from '../src/services/candidateDecision.ts';
import type { MemoryRow } from '../src/types.ts';

// Calibration tool (ROADMAP.md "下一步 1"): runs the extraction pipeline against a Claude Code
// transcript in dry-run mode (no writes — see the `dry_run` branch in src/index.ts's
// /v1/memories/extract handler) and diffs the cloud candidates against memories the agent
// actually added directly (asaki_memory_add, not the extraction pipeline) in the same window.
// Deliberately skips the signal-word gate the Stop hook applies (see EXTRACT_SIGNAL_RE in
// integrations/pi/asaki-memory.ts) so this sees the LLM's full recall, not just what already
// slipped past the gate in production — that's the point of the comparison.
//
// Usage:
//   node --experimental-strip-types scripts/shadow-run-extraction.ts <transcript.jsonl> [...more]
//     --user <id>        default: $ASAKI_MEMORY_USER_ID or "asaki"
//     --project <id>     project_id hint sent to /extract and used to scope the memory lookup
//     --since-hours <n>  how far back to look for real agent-added memories to diff against (default 24)
//     --create-reviews   push cloud candidates the agent missed into the review queue (default: report only)

// KEEP IN SYNC with SENSITIVE_RE_LIST in integrations/pi/asaki-memory.ts and SENSITIVE_PATTERN in
// integrations/claude-code/stop-extract.sh — never send a transcript slice containing a secret
// off-machine, even for a calibration run.
const SENSITIVE_RE_LIST = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i,
  /\b(?:sk|sk-ant|sk-proj|ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_=-]{16,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:api[_-]?key|token|secret|password|passwd|authorization)\b\s*[:=]\s*["']?[^"'\s]{8,}/i,
  /set\s+-gx\s+\w*(?:KEY|TOKEN|SECRET|PASSWORD)\w*\s+[^$\s][^\s]{8,}/i,
];

const MAX_EXTRACT_CHARS = 20_000; // matches the /v1/memories/extract text length limit
const DIRECT_ADD_SUFFIX_RE = /:(extract|auto-extract|review)$/; // excludes pipeline-sourced memories
const SAME_FACT_SIMILARITY_THRESHOLD = 0.5; // mirrors BATCH_DEDUP_SIMILARITY_THRESHOLD
const MAX_REVIEW_CANDIDATES = 20; // /v1/memories/reviews caps candidates per request

type Args = {
  files: string[];
  user: string;
  project: string | null;
  sinceHours: number;
  createReviews: boolean;
};

function parseArgs(argv: string[]): Args {
  const files: string[] = [];
  let user = process.env.ASAKI_MEMORY_USER_ID || 'asaki';
  let project: string | null = null;
  let sinceHours = 24;
  let createReviews = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--user') user = argv[++i];
    else if (arg === '--project') project = argv[++i];
    else if (arg === '--since-hours') sinceHours = Number(argv[++i]);
    else if (arg === '--create-reviews') createReviews = true;
    else files.push(arg);
  }
  return { files, user, project, sinceHours, createReviews };
}

function transcriptToText(path: string): string {
  const lines = readFileSync(path, 'utf8').split('\n');
  const turns: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === 'user' && typeof entry.message?.content === 'string') {
      turns.push(`User: ${entry.message.content.trim()}`);
    } else if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      const text = entry.message.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join(' ')
        .trim();
      if (text) turns.push(`Assistant: ${text}`);
    }
  }
  return turns.join('\n\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.files.length === 0) {
    console.error(
      'Usage: shadow-run-extraction.ts <transcript.jsonl> [...] [--user id] [--project id] [--since-hours n] [--create-reviews]'
    );
    process.exit(1);
  }

  const baseUrl = (process.env.ASAKI_MEMORY_BASE_URL || process.env.ASAKI_MEMORY_API_URL || '').replace(/\/$/, '');
  const apiKey = process.env.ASAKI_MEMORY_API_KEY || process.env.ADMIN_API_KEY || '';
  if (!baseUrl || !apiKey) {
    console.error('ASAKI_MEMORY_BASE_URL (or ASAKI_MEMORY_API_URL) and ASAKI_MEMORY_API_KEY (or ADMIN_API_KEY) must be set.');
    process.exit(1);
  }

  const fullText = args.files.map(transcriptToText).filter(Boolean).join('\n\n');
  if (!fullText) {
    console.log('No user/assistant text found in the given transcript(s).');
    return;
  }
  if (SENSITIVE_RE_LIST.some((re) => re.test(fullText))) {
    console.error('Transcript text matched a sensitive-content pattern; aborting without contacting the Worker.');
    process.exit(1);
  }
  const text = fullText.length > MAX_EXTRACT_CHARS ? fullText.slice(-MAX_EXTRACT_CHARS) : fullText;

  const extractResp = await fetch(`${baseUrl}/v1/memories/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ text, user_id: args.user, project_id: args.project, source: 'shadow-run', dry_run: true }),
  });
  if (!extractResp.ok) {
    console.error(`extract request failed: ${extractResp.status} ${await extractResp.text()}`);
    process.exit(1);
  }
  const extractData = (await extractResp.json()) as {
    extracted_count: number;
    auto_eligible: ProcessMemoryCandidateInput[];
    review_eligible: ProcessMemoryCandidateInput[];
  };
  const cloudCandidates = [...extractData.auto_eligible, ...extractData.review_eligible];

  const listResp = await fetch(`${baseUrl}/v1/memories/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ user_id: args.user, project_id: args.project, status: 'active', limit: 100 }),
  });
  if (!listResp.ok) {
    console.error(`list request failed: ${listResp.status} ${await listResp.text()}`);
    process.exit(1);
  }
  const { memories } = (await listResp.json()) as { memories: MemoryRow[] };

  const sinceMs = Date.now() - args.sinceHours * 3_600_000;
  const directAdds = memories.filter(
    (m) => Date.parse(m.created_at) >= sinceMs && !!m.source && !DIRECT_ADD_SUFFIX_RE.test(m.source)
  );

  const gaps: ProcessMemoryCandidateInput[] = [];
  const covered: ProcessMemoryCandidateInput[] = [];
  for (const candidate of cloudCandidates) {
    const bestMatch = Math.max(0, ...directAdds.map((m) => lexicalSimilarity(candidate.content, m.content)));
    (bestMatch >= SAME_FACT_SIMILARITY_THRESHOLD ? covered : gaps).push(candidate);
  }

  console.log(
    `shadow-run: ${extractData.extracted_count} extracted, ${cloudCandidates.length} deduped cloud candidate(s), ${directAdds.length} real direct add(s) in the last ${args.sinceHours}h`
  );
  console.log(`covered by real adds: ${covered.length}`);
  console.log(`gaps (cloud found, agent didn't save): ${gaps.length}`);
  for (const gap of gaps) {
    console.log(`- [${gap.kind} scope=${gap.scope} importance=${gap.importance}] ${gap.content}`);
  }

  if (args.createReviews && gaps.length > 0) {
    const toQueue = gaps.slice(0, MAX_REVIEW_CANDIDATES);
    if (toQueue.length < gaps.length) {
      console.log(`only queuing the first ${MAX_REVIEW_CANDIDATES} gap(s); /v1/memories/reviews caps candidates per request.`);
    }
    const reviewResp = await fetch(`${baseUrl}/v1/memories/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ user_id: args.user, source: 'shadow-run', candidates: toQueue }),
    });
    if (!reviewResp.ok) {
      console.error(`failed to create reviews: ${reviewResp.status} ${await reviewResp.text()}`);
      process.exit(1);
    }
    console.log(`queued ${toQueue.length} gap candidate(s) to /v1/memories/reviews for human triage.`);
  }
}

main();
