// Manual stale-memory cleanup (ROADMAP.md lifecycle policy): calls POST /v1/memories/prune-stale,
// which soft-deletes (status='deleted' + Vectorize deleteByIds, same as DELETE /v1/memories/:id)
// active memories whose last_accessed_at (falling back to created_at when never accessed) is
// older than --days. Defaults to dry-run — always review the candidate list before --apply.
//
// Usage:
//   node --experimental-strip-types scripts/prune-stale.ts [--days 90] [--limit 100] [--apply] [--max-rounds 20]

type Args = { days: number; limit: number; apply: boolean; maxRounds: number };

function numberArg(flag: string, raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.error(`${flag} requires a numeric value, got: ${raw ?? '(missing)'}`);
    process.exit(1);
  }
  return value;
}

function parseArgs(argv: string[]): Args {
  let days = 90;
  let limit = 100;
  let apply = false;
  let maxRounds = 20;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--days') days = numberArg(arg, argv[++i]);
    else if (arg === '--limit') limit = numberArg(arg, argv[++i]);
    else if (arg === '--apply') apply = true;
    else if (arg === '--max-rounds') maxRounds = numberArg(arg, argv[++i]);
  }
  return { days, limit, apply, maxRounds };
}

type Candidate = { id: string; user_id: string; scope: string; content: string; kind: string; importance: number; last_accessed_at: string | null; created_at: string };
type PruneResult = { checked: number; deleted: number; candidates: Candidate[] };

function printCandidates(candidates: Candidate[]) {
  for (const candidate of candidates) {
    const preview = candidate.content.length > 80 ? `${candidate.content.slice(0, 80)}...` : candidate.content;
    const lastSeen = candidate.last_accessed_at ?? `never (created ${candidate.created_at})`;
    console.log(`- [${candidate.kind} importance=${candidate.importance}] last_accessed=${lastSeen} :: ${preview}`);
  }
}

async function callPrune(baseUrl: string, apiKey: string, args: Args): Promise<PruneResult> {
  const response = await fetch(`${baseUrl}/v1/memories/prune-stale`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ days: args.days, limit: args.limit, apply: args.apply }),
  });
  if (!response.ok) {
    console.error(`prune-stale request failed: ${response.status} ${await response.text()}`);
    process.exit(1);
  }
  return response.json() as Promise<PruneResult>;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const baseUrl = (process.env.ASAKI_MEMORY_BASE_URL || process.env.ASAKI_MEMORY_API_URL || '').replace(/\/$/, '');
  const apiKey = process.env.ASAKI_MEMORY_API_KEY || process.env.ADMIN_API_KEY || '';
  if (!baseUrl || !apiKey) {
    console.error('ASAKI_MEMORY_BASE_URL (or ASAKI_MEMORY_API_URL) and ASAKI_MEMORY_API_KEY (or ADMIN_API_KEY) must be set.');
    process.exit(1);
  }

  if (!args.apply) {
    const result = await callPrune(baseUrl, apiKey, args);
    console.log(`dry-run: ${result.checked} memories not accessed in ${args.days}+ days (limit ${args.limit}).`);
    printCandidates(result.candidates);
    if (result.checked > 0) console.log('\nRe-run with --apply to soft-delete these. Nothing was changed.');
    return;
  }

  let totalChecked = 0;
  let totalDeleted = 0;
  let round = 0;
  while (round < args.maxRounds) {
    round++;
    const result = await callPrune(baseUrl, apiKey, args);
    totalChecked += result.checked;
    totalDeleted += result.deleted;
    console.log(`round ${round}: deleted ${result.deleted}`);
    printCandidates(result.candidates);
    if (result.checked < args.limit) break; // queue drained
  }

  console.log(`prune done: ${totalDeleted} memory(ies) soft-deleted across ${round} round(s).`);
}

main();
