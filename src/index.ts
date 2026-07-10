import { Hono, type Context } from 'hono';
import type { Env } from './types';
import { dedupeCandidateBatch, isAutoAddEligible, isUnsupervisedSource, processMemoryCandidates } from './services/candidates';
import { extractMemoryCandidates } from './services/extraction';
import { backfillPendingIndex, createMemory, deleteMemory, getMemory, listMemories, pruneStaleMemories, purgeMemory, searchMemories, updateMemory } from './services/memories';
import { createMemoryReviews, listMemoryReviews, resolveMemoryReview } from './services/reviews';
import { validateBackfillIndex, validateCreateMemory, validateCreateMemoryReviews, validateExtractMemories, validateListMemories, validateListMemoryReviews, validateMemoryIdInput, validatePruneStale, validateProcessCandidates, validatePurgeMemory, validateResolveMemoryReview, validateSearchMemories, validateUpdateMemory } from './utils/validation';

type Bindings = Env;

const app = new Hono<{ Bindings: Bindings }>();

async function readJson(c: Context<{ Bindings: Bindings }>): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return { ok: false, response: c.json({ error: 'Invalid JSON body.' }, 400) };
  }
}

// Guards the expensive routes (embeddings/Vectorize/LLM dedup calls) with the Cloudflare
// Rate Limiting binding, keyed per user_id. Degrades to a no-op when RATE_LIMITER isn't
// configured (e.g. local dev), matching the "binding absent -> skip" pattern used elsewhere
// (see upsertVector() in services/memories.ts).
async function checkRateLimit(c: Context<{ Bindings: Bindings }>, key: string): Promise<Response | null> {
  if (!c.env.RATE_LIMITER) return null;
  const { success } = await c.env.RATE_LIMITER.limit({ key });
  if (!success) return c.json({ error: 'Rate limit exceeded. Try again shortly.' }, 429);
  return null;
}

app.use('/v1/*', async (c, next) => {
  const configuredKey = c.env.ADMIN_API_KEY;
  if (!configuredKey) {
    return c.json({ error: 'Service misconfigured: ADMIN_API_KEY is not set.' }, 503);
  }
  const authorization = c.req.header('Authorization');
  if (authorization !== `Bearer ${configuredKey}`) {
    return c.json({ error: 'Unauthorized.' }, 401);
  }
  return next();
});

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'asaki-memory-manager',
    timestamp: new Date().toISOString(),
  });
});

app.post('/v1/memories', async (c) => {
  const body = await readJson(c);
  if (!body.ok) return body.response;

  const validation = validateCreateMemory(body.body);
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  const memory = await createMemory(c.env, validation.data);
  return c.json({ memory }, 201);
});

app.post('/v1/memories/search', async (c) => {
  const body = await readJson(c);
  if (!body.ok) return body.response;

  const validation = validateSearchMemories(body.body);
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  const results = await searchMemories(c.env, validation.data);
  return c.json({ results });
});

app.post('/v1/memories/candidates', async (c) => {
  const body = await readJson(c);
  if (!body.ok) return body.response;

  const validation = validateProcessCandidates(body.body);
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  // Candidates from an unsupervised background classifier never auto-add/merge/update/delete —
  // they always land in the review queue, regardless of scope/importance. See
  // isUnsupervisedSource() for why.
  const autoBucket = validation.data.filter((item) => !isUnsupervisedSource(item.source));
  const reviewBucket = validation.data.filter((item) => isUnsupervisedSource(item.source));

  const decisions = autoBucket.length > 0 ? await processMemoryCandidates(c.env, autoBucket) : [];
  const reviews = reviewBucket.length > 0 ? await createMemoryReviews(c.env, reviewBucket) : [];
  return c.json({ decisions, reviews });
});

app.post('/v1/memories/extract', async (c) => {
  const body = await readJson(c);
  if (!body.ok) return body.response;

  const validation = validateExtractMemories(body.body);
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  const { text, user_id, scope, project_id, session_id, source, dry_run } = validation.data;
  const extracted = await extractMemoryCandidates(c.env, text, user_id);
  const candidates = extracted.map((item) => {
    // An explicit request-level scope forces every candidate into it. Otherwise each candidate
    // keeps its own LLM-inferred scope (global vs project) instead of being forced into one.
    let resolvedScope = scope ?? item.scope;
    if (resolvedScope === 'project' && !project_id) resolvedScope = 'global';
    return {
      content: item.content,
      user_id,
      scope: resolvedScope,
      project_id: resolvedScope === 'project' ? project_id : null,
      session_id: resolvedScope === 'session' ? session_id : null,
      kind: item.kind,
      importance: item.importance,
      confidence: 0.7,
      source: source ?? 'extraction',
    };
  });

  const deduped = dedupeCandidateBatch(candidates);
  const autoBucket = deduped.filter((item) => isAutoAddEligible(item));
  const reviewBucket = deduped.filter((item) => !isAutoAddEligible(item));

  // Calibration mode: report what the pipeline would extract and how it would bucket without
  // writing anything (no processMemoryCandidates, no createMemoryReviews). Used by the
  // shadow-run script to diff cloud extraction against real agent-side adds.
  if (dry_run) {
    return c.json({ extracted_count: extracted.length, auto_eligible: autoBucket, review_eligible: reviewBucket });
  }

  const decisions = autoBucket.length > 0 ? await processMemoryCandidates(c.env, autoBucket) : [];
  const reviews = reviewBucket.length > 0 ? await createMemoryReviews(c.env, reviewBucket) : [];
  return c.json({ decisions, reviews, extracted_count: extracted.length });
});

app.post('/v1/memories/list', async (c) => {
  const body = await readJson(c);
  if (!body.ok) return body.response;

  const validation = validateListMemories(body.body);
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  const memories = await listMemories(c.env, validation.data);
  return c.json({ memories });
});

app.post('/v1/memories/backfill-index', async (c) => {
  const body = await readJson(c);
  if (!body.ok) return body.response;

  const validation = validateBackfillIndex(body.body);
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  const result = await backfillPendingIndex(c.env, validation.data.limit);
  return c.json(result);
});

app.post('/v1/memories/prune-stale', async (c) => {
  const body = await readJson(c);
  if (!body.ok) return body.response;

  const validation = validatePruneStale(body.body);
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  const result = await pruneStaleMemories(c.env, validation.data);
  return c.json(result);
});

app.post('/v1/memories/reviews', async (c) => {
  const body = await readJson(c);
  if (!body.ok) return body.response;

  const validation = validateCreateMemoryReviews(body.body);
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  const reviews = await createMemoryReviews(c.env, validation.data);
  return c.json({ reviews }, 201);
});

app.post('/v1/memories/reviews/list', async (c) => {
  const body = await readJson(c);
  if (!body.ok) return body.response;

  const validation = validateListMemoryReviews(body.body);
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  const reviews = await listMemoryReviews(c.env, validation.data);
  return c.json({ reviews });
});

app.post('/v1/memories/reviews/:id/resolve', async (c) => {
  const body = await readJson(c);
  if (!body.ok) return body.response;

  const validation = validateResolveMemoryReview(body.body);
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  try {
    const result = await resolveMemoryReview(c.env, c.req.param('id'), validation.data);
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, message.includes('not found') ? 404 : 400);
  }
});

app.get('/v1/memories/:id', async (c) => {
  const validation = validateMemoryIdInput({ user_id: c.req.query('user_id') });
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  const memory = await getMemory(c.env, c.req.param('id'), validation.data.user_id);
  if (!memory) return c.json({ error: 'Memory not found.' }, 404);
  return c.json({ memory });
});

app.patch('/v1/memories/:id', async (c) => {
  const body = await readJson(c);
  if (!body.ok) return body.response;

  const validation = validateUpdateMemory(body.body);
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  try {
    const memory = await updateMemory(c.env, c.req.param('id'), validation.data);
    if (!memory) return c.json({ error: 'Memory not found.' }, 404);
    return c.json({ memory });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

app.delete('/v1/memories/:id', async (c) => {
  const body = await readJson(c);
  if (!body.ok) return body.response;

  const validation = validateMemoryIdInput(body.body);
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  const memory = await deleteMemory(c.env, c.req.param('id'), validation.data.user_id);
  if (!memory) return c.json({ error: 'Memory not found.' }, 404);
  return c.json({ memory });
});

// Unlike DELETE (soft delete — recoverable, content stays in D1), purge is for content that
// should never have been stored (a leaked credential, etc): it wipes the memory's content,
// the Vectorize entry, and every prior memory_events row for it. Separate endpoint so it's
// never triggered by a routine delete call.
app.post('/v1/memories/:id/purge', async (c) => {
  const body = await readJson(c);
  if (!body.ok) return body.response;

  const validation = validatePurgeMemory(body.body);
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  const memory = await purgeMemory(c.env, c.req.param('id'), validation.data.user_id, validation.data.reason);
  if (!memory) return c.json({ error: 'Memory not found.' }, 404);
  return c.json({ memory });
});

app.notFound((c) => c.json({ error: 'Not found.' }, 404));

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: 'Internal server error.' }, 500);
});

export default app;
