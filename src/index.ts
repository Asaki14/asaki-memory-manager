import { Hono } from 'hono';
import type { Env } from './types';
import { processMemoryCandidates } from './services/candidates';
import { extractMemories } from './services/extract';
import { createMemory, searchMemories } from './services/memories';
import { validateCreateMemory, validateExtractMemories, validateProcessCandidates, validateSearchMemories } from './utils/validation';

type Bindings = Env;

const app = new Hono<{ Bindings: Bindings }>();

app.use('/v1/*', async (c, next) => {
  const configuredKey = c.env.ADMIN_API_KEY;
  if (!configuredKey) return next();
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
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body.' }, 400);
  }

  const validation = validateCreateMemory(body);
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  const memory = await createMemory(c.env, validation.data);
  return c.json({ memory }, 201);
});

app.post('/v1/memories/search', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body.' }, 400);
  }

  const validation = validateSearchMemories(body);
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  const results = await searchMemories(c.env, validation.data);
  return c.json({ results });
});

app.post('/v1/memories/candidates', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body.' }, 400);
  }

  const validation = validateProcessCandidates(body);
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  const decisions = await processMemoryCandidates(c.env, validation.data);
  return c.json({ decisions });
});

app.post('/v1/memories/extract', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body.' }, 400);
  }

  const validation = validateExtractMemories(body);
  if (!validation.ok) return c.json({ error: validation.error }, 400);
  if (!c.env.MEMORY_LLM_MODEL) {
    return c.json({ error: 'MEMORY_LLM_MODEL is not configured. Set a Workers AI chat model before using memory extraction.' }, 501);
  }
  if (!c.env.AI) return c.json({ error: 'Workers AI binding is not available.' }, 503);

  const result = await extractMemories(c.env, validation.data);
  return c.json(result);
});

app.notFound((c) => c.json({ error: 'Not found.' }, 404));

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: 'Internal server error.' }, 500);
});

export default app;
