// Manual Vectorize backfill trigger (ROADMAP.md "下一步 1"): D1/Vectorize/Workers AI bindings
// only exist inside the Worker runtime, so this script can't touch them directly — it just calls
// POST /v1/memories/backfill-index (which does the real work: find memories with
// index_status IN ('pending','failed'), regenerate embeddings, re-upsert into Vectorize) and
// repeats until the queue is drained. Same "hit the deployed Worker over HTTP" pattern as
// scripts/shadow-run-extraction.ts.
//
// Usage:
//   node --experimental-strip-types scripts/backfill-index.ts [--limit <n>] [--max-rounds <n>]

type Args = { limit: number; maxRounds: number };

function parseArgs(argv: string[]): Args {
  let limit = 50;
  let maxRounds = 20;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--limit') limit = Number(argv[++i]);
    else if (arg === '--max-rounds') maxRounds = Number(argv[++i]);
  }
  return { limit, maxRounds };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const baseUrl = (process.env.ASAKI_MEMORY_BASE_URL || process.env.ASAKI_MEMORY_API_URL || '').replace(/\/$/, '');
  const apiKey = process.env.ASAKI_MEMORY_API_KEY || process.env.ADMIN_API_KEY || '';
  if (!baseUrl || !apiKey) {
    console.error('ASAKI_MEMORY_BASE_URL (or ASAKI_MEMORY_API_URL) and ASAKI_MEMORY_API_KEY (or ADMIN_API_KEY) must be set.');
    process.exit(1);
  }

  let totalChecked = 0;
  let totalIndexed = 0;
  let round = 0;

  while (round < args.maxRounds) {
    round++;
    const response = await fetch(`${baseUrl}/v1/memories/backfill-index`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ limit: args.limit }),
    });
    if (!response.ok) {
      console.error(`backfill request failed: ${response.status} ${await response.text()}`);
      process.exit(1);
    }
    const result = (await response.json()) as { checked: number; indexed: number; remaining: number; remaining_ids: string[] };
    totalChecked += result.checked;
    totalIndexed += result.indexed;
    console.log(`round ${round}: checked ${result.checked}, indexed ${result.indexed}, still stuck ${result.remaining}`);
    if (result.remaining_ids.length > 0) {
      console.log(`  stuck ids: ${result.remaining_ids.join(', ')}`);
    }
    if (result.checked < args.limit) break; // queue drained
  }

  console.log(`backfill done: ${totalChecked} checked, ${totalIndexed} indexed across ${round} round(s).`);
}

main();
