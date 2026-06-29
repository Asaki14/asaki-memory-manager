import type { Env } from '../types';

export async function writeMemoryEvent(env: Env, params: { memoryId?: string | null; userId: string; eventType: string; payload?: unknown }): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO memory_events (id, memory_id, user_id, event_type, payload)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(crypto.randomUUID(), params.memoryId ?? null, params.userId, params.eventType, params.payload ? JSON.stringify(params.payload) : null)
    .run();
}
