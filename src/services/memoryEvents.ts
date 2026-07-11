import type { Env } from '../types';

export async function writeMemoryEvent(env: Env, params: { memoryId?: string | null; userId: string; eventType: string; payload?: unknown }): Promise<void> {
  // Explicit ISO timestamp instead of the column's datetime('now') default — the SQL default's
  // "YYYY-MM-DD HH:MM:SS" format isn't lexicographically comparable with the ISO strings every
  // other table's created_at/updated_at uses.
  await env.DB.prepare(
    `INSERT INTO memory_events (id, memory_id, user_id, event_type, payload, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind(crypto.randomUUID(), params.memoryId ?? null, params.userId, params.eventType, params.payload ? JSON.stringify(params.payload) : null, new Date().toISOString())
    .run();
}
