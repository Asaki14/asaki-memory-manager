import { Hono } from 'hono';
import type { Env } from './types';
import { processMemoryCandidates } from './services/candidates';
import { extractMemories } from './services/extract';
import { createMemory, deleteMemory, getMemory, listMemories, searchMemories, updateMemory } from './services/memories';
import { validateCreateMemory, validateExtractMemories, validateListMemories, validateMemoryIdInput, validateProcessCandidates, validateSearchMemories, validateUpdateMemory } from './utils/validation';

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

app.post('/v1/memories/list', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body.' }, 400);
  }

  const validation = validateListMemories(body);
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  const memories = await listMemories(c.env, validation.data);
  return c.json({ memories });
});

app.get('/v1/memories/:id', async (c) => {
  const validation = validateMemoryIdInput({ user_id: c.req.query('user_id') });
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  const memory = await getMemory(c.env, c.req.param('id'), validation.data.user_id);
  if (!memory) return c.json({ error: 'Memory not found.' }, 404);
  return c.json({ memory });
});

app.patch('/v1/memories/:id', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body.' }, 400);
  }

  const validation = validateUpdateMemory(body);
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
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body.' }, 400);
  }

  const validation = validateMemoryIdInput(body);
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  const memory = await deleteMemory(c.env, c.req.param('id'), validation.data.user_id);
  if (!memory) return c.json({ error: 'Memory not found.' }, 404);
  return c.json({ memory });
});

app.notFound((c) => c.json({ error: 'Not found.' }, 404));

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: 'Internal server error.' }, 500);
});

export default app;
