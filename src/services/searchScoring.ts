import type { MemoryRow, SearchMemoriesInput, SearchResult, SearchScoreDetails } from '../types';

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function scopeWeight(memory: MemoryRow, input: SearchMemoriesInput): number {
  if (memory.scope === 'project' && input.project_id && memory.project_id === input.project_id) return 0.08;
  if (memory.scope === 'global') return 0.04;
  if (memory.scope === 'session' && input.session_id && memory.session_id === input.session_id) return 0.03;
  return 0;
}

function recencyWeight(memory: MemoryRow): number {
  const created = Date.parse(memory.updated_at || memory.created_at);
  if (Number.isNaN(created)) return 0;
  const ageDays = Math.max(0, (Date.now() - created) / 86_400_000);
  return Math.max(0, 0.04 - ageDays * 0.001);
}

function metadataScore(memory: MemoryRow, input: SearchMemoriesInput): number {
  return clampScore(
    memory.importance * 0.25 +
      memory.confidence * 0.25 +
      (scopeWeight(memory, input) / 0.08) * 0.3 +
      (recencyWeight(memory) / 0.04) * 0.2
  );
}

const SEARCH_STOP_TOKENS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'be',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'not',
  'of',
  'on',
  'or',
  'the',
  'this',
  'to',
  'was',
  'with',
]);

function addSearchToken(tokens: Set<string>, token: string): void {
  if (token.length < 2 || SEARCH_STOP_TOKENS.has(token)) return;
  tokens.add(token);
}

function searchTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of value.toLowerCase().match(/[a-z0-9][a-z0-9@_-]*/g) ?? []) {
    addSearchToken(tokens, raw);
    for (const part of raw.split(/[_-]+/)) addSearchToken(tokens, part);
  }
  // The ASCII match above is blind to CJK text (no [a-z0-9] characters at all), which left
  // keyword/fallback search with an empty token set — and therefore zero keyword score — for
  // any Chinese-only memory or query. Chinese has no whitespace word boundaries, so per-character
  // tokens are the practical choice (same reasoning as candidateDecision.ts's tokenize()).
  for (const char of value.match(/[一-鿿㐀-䶿]/g) ?? []) {
    tokens.add(char);
  }
  return tokens;
}

function entityTokens(value: string): Set<string> {
  const entities = new Set<string>();
  for (const raw of value.match(/\/[a-z0-9][a-z0-9/_-]*|[A-Z][A-Z0-9_]{2,}|[a-zA-Z0-9]+(?:[-_][a-zA-Z0-9]+)+|[\w.-]+(?:\/[\w.-]+)+/g) ?? []) {
    entities.add(raw.toLowerCase().replace(/[^a-z0-9/_-]+$/g, ''));
  }
  return entities;
}

function keywordScore(query: string, content: string): number {
  const queryTokens = searchTokens(query);
  const contentTokens = searchTokens(content);
  if (queryTokens.size === 0 || contentTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) overlap += 1;
  }

  const recall = overlap / queryTokens.size;
  const jaccard = overlap / (queryTokens.size + contentTokens.size - overlap);
  return clampScore(recall * 0.7 + jaccard * 0.3);
}

function entityScore(query: string, content: string): number {
  const queryEntities = entityTokens(query);
  const contentEntities = entityTokens(content);
  if (queryEntities.size === 0 || contentEntities.size === 0) return 0;

  let score = 0;
  for (const queryEntity of queryEntities) {
    if (contentEntities.has(queryEntity)) {
      score += 1;
      continue;
    }
    for (const contentEntity of contentEntities) {
      if (queryEntity.length >= 4 && (contentEntity.startsWith(queryEntity) || queryEntity.startsWith(contentEntity))) {
        score += 0.5;
        break;
      }
    }
  }

  return clampScore(score / queryEntities.size);
}

export function scoreMemoryForSearch(
  memory: MemoryRow,
  input: SearchMemoriesInput,
  semantic: number,
  source: SearchScoreDetails['source']
): Pick<SearchResult, 'score' | 'score_details'> {
  const details: SearchScoreDetails = {
    semantic: clampScore(semantic),
    keyword: keywordScore(input.query, memory.content),
    entity: entityScore(input.query, memory.content),
    metadata: metadataScore(memory, input),
    source,
  };
  const score =
    source === 'vector' && details.semantic > 0
      ? details.semantic * 0.65 + details.keyword * 0.25 + details.entity * 0.07 + details.metadata * 0.03
      : details.keyword * 0.75 + details.entity * 0.2 + details.metadata * 0.05;

  return { score: clampScore(score), score_details: details };
}
