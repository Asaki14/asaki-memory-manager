import type { Env } from '../types';

function extractEmbedding(response: unknown): number[] | null {
  const value = response as any;
  const candidates = [
    value?.data?.[0],
    value?.result?.data?.[0],
    value?.result?.[0],
    value?.embeddings?.[0],
    value?.embedding,
    Array.isArray(value) ? value[0] : null,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.every((item) => typeof item === 'number')) {
      return candidate;
    }
  }

  return null;
}

export async function generateEmbedding(env: Env, text: string): Promise<number[] | null> {
  if (!env.AI) return null;
  try {
    const model = env.EMBEDDING_MODEL || '@cf/baai/bge-m3';
    const response = await env.AI.run(model, { text: [text] });
    return extractEmbedding(response);
  } catch (error) {
    console.warn('Embedding generation skipped:', error instanceof Error ? error.message : String(error));
    return null;
  }
}
