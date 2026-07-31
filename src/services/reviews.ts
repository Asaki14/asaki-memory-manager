import type { Env, MemoryReviewRecord, MemoryReviewRow } from '../types';
import { UserFacingError } from '../utils/errors';
import { createMemory, deleteMemory, getMemory, searchMemories, updateMemoryContent } from './memories';
import { writeMemoryEvent } from './memoryEvents';
import { parseMemoryMetadata, recordCorrectionOrigin, reinforceMemory, type ReinforcementResult } from './memoryLifecycle';
import { BATCH_DEDUP_SIMILARITY_THRESHOLD, bestUsableMatch, heuristicDecision, lexicalSimilarity, mergeContent, usableMatches, type ProcessMemoryCandidateInput } from './candidateDecision';
import { findCrossProjectMatches, findLexicalMatch } from './candidates';

function nowIso(): string {
  return new Date().toISOString();
}

// Shared by findActiveDuplicate (creation-time preemption) and listMemoryReviews'
// include_suggestions (display-time hint): the same search + deterministic-match machinery
// processMemoryCandidate() uses for the auto-add bucket (searchMemories + findLexicalMatch +
// bestUsableMatch), stopping at the deterministic heuristic — no LLM dedup call here.
async function findBestMatch(env: Env, candidate: ProcessMemoryCandidateInput) {
  const similar = await searchMemories(env, {
    query: candidate.content,
    user_id: candidate.user_id,
    scope: candidate.scope,
    project_id: candidate.project_id ?? null,
    session_id: candidate.session_id ?? null,
    top_k: 5,
    // Suggesting a memory as a dedup target must not refresh its last_accessed_at (§5.3d).
    track_access: false,
  });
  return bestUsableMatch(candidate, [...similar, await findLexicalMatch(env, candidate)]);
}

// Display-time supersession hint: which ACTIVE memory does this correction invalidate?
//
// The query text is deliberately `supersedes_query` — the affirmative restatement of the old
// behaviour — not the candidate's own (negative) rule text: a negation scores 0.176-0.333 lexically
// against the memory it contradicts, which is below the usable-match floor. With no
// `supersedes_query` the lookup does not run at all; a bad query is worse than no suggestion.
//
// `scope` is omitted on purpose so isVisibleInScope() admits global + the current project/session
// (a project correction retiring an over-broad global rule is the direction that matters most).
// `project_context` is a scope-neutral client hint and is preferred over project_id precisely
// because a global correction carries no project_id; it never touches scope validation or the
// review row's project_id column. Cross-project search is deliberately not done here.
export async function findSupersedeCandidates(
  env: Env,
  candidate: ProcessMemoryCandidateInput,
  reviewProjectId?: string | null,
): Promise<NonNullable<MemoryReviewRow['supersedes_candidates']>> {
  const query = typeof candidate.supersedes_query === 'string' ? candidate.supersedes_query.trim() : '';
  if (!query) return [];

  const synthetic: ProcessMemoryCandidateInput = { ...candidate, content: query };
  const projectId = candidate.project_context ?? candidate.project_id ?? reviewProjectId ?? null;
  const similar = await searchMemories(env, {
    query,
    user_id: candidate.user_id,
    project_id: projectId,
    session_id: candidate.session_id ?? null,
    top_k: 5,
    track_access: false,
  });

  // `retract` is the only rule form that asks for the memory to go away; everything else rewrites it.
  const suggestedAction = candidate.rule_form === 'retract' ? ('delete' as const) : ('update' as const);
  // The lexical scan can return a memory the vector search already found; keep the higher-scoring
  // entry (the list is sorted best-first) rather than suggesting the same target twice.
  const seen = new Set<string>();
  return usableMatches(synthetic, [...similar, await findLexicalMatch(env, synthetic)])
    .filter(({ match }) => (seen.has(match.id) ? false : (seen.add(match.id), true)))
    .slice(0, 3)
    .map(({ match, score }) => ({
      memory_id: match.id,
      content: match.content,
      score,
      target_scope: match.scope,
      target_kind: match.kind,
      target_confidence: match.confidence,
      suggested_action: suggestedAction,
    }));
}

// Display-time global-promotion hint (captain decision 8): the same rule this project correction
// states already exists as a project-scoped rule/preference in a DIFFERENT project, which is the
// evidence that it is really a global rule.
//
// Unlike findSupersedeCandidates() this queries the candidate's OWN content, not `supersedes_query`:
// promotion is a same-direction match ("this rule exists elsewhere too"), supersession is the
// opposite direction ("this rule contradicts that memory"). Suggestion only — nothing is rescoped
// here, and the review row's project_id is never touched. `project_context` is accepted as the
// scope-neutral client hint, same precedence as the supersession lookup.
export async function findPromotionCandidates(
  env: Env,
  candidate: ProcessMemoryCandidateInput,
  reviewProjectId?: string | null,
): Promise<NonNullable<MemoryReviewRow['promotion_candidates']>> {
  if (candidate.signal !== 'correction') return [];
  if (candidate.scope !== 'project') return [];
  const projectId = candidate.project_id ?? candidate.project_context ?? reviewProjectId ?? null;
  if (!projectId) return [];

  const rows = await findCrossProjectMatches(env, candidate, projectId);
  const seen = new Set<string>();
  return usableMatches(candidate, rows)
    .filter(({ match }) => (seen.has(match.id) ? false : (seen.add(match.id), true)))
    .slice(0, 3)
    .map(({ match, score }) => ({
      memory_id: match.id,
      content: match.content,
      score,
      target_project_id: match.project_id,
      target_kind: match.kind,
      suggested_action: 'promote_to_global' as const,
    }));
}

// Catches the gap a review-queue-only dedup (findSimilarPendingReview below) can't: a candidate
// that duplicates a memory that's already `active` (not merely another pending review). Only
// preempts the review on a heuristic "ignore" (genuine duplicate, nothing new); "merge"/"update"/
// "delete" verdicts still require human judgment via the normal review path, since auto-mutating
// an active memory from an unvetted (global/low-importance) candidate would defeat the point of
// routing it to review in the first place.
async function findActiveDuplicate(env: Env, candidate: ProcessMemoryCandidateInput) {
  const match = await findBestMatch(env, candidate);
  if (!match) return undefined;
  return heuristicDecision(candidate, match).action === 'ignore' ? match : undefined;
}

// Finds an existing pending review that's "the same fact" as `candidate`, so repeated mentions
// of the same preference/decision across separate extraction calls merge into one queued review
// instead of piling up near-duplicate pending rows. Scoped the same way visibility is scoped
// elsewhere (same scope, and matching project_id/session_id when the candidate has one) —
// LIMIT 100 most-recently-touched pending reviews per user is the same bound used for the
// lexical DB scan in candidates.ts's findLexicalMatch.
async function findSimilarPendingReview(env: Env, candidate: ProcessMemoryCandidateInput): Promise<MemoryReviewRecord | undefined> {
  const result = await env.DB.prepare(
    `SELECT * FROM memory_reviews WHERE user_id = ?1 AND status = 'pending' ORDER BY updated_at DESC LIMIT 100`
  )
    .bind(candidate.user_id)
    .all<MemoryReviewRecord>();

  let best: { row: MemoryReviewRecord; similarity: number } | undefined;
  for (const row of result.results ?? []) {
    const existing = JSON.parse(row.candidate_json) as ProcessMemoryCandidateInput;
    if (existing.scope !== candidate.scope) continue;
    if (candidate.scope === 'project' && (existing.project_id ?? null) !== (candidate.project_id ?? null)) continue;
    if (candidate.scope === 'session' && (existing.session_id ?? null) !== (candidate.session_id ?? null)) continue;
    const similarity = lexicalSimilarity(candidate.content, existing.content);
    if (similarity >= BATCH_DEDUP_SIMILARITY_THRESHOLD && (!best || similarity > best.similarity)) {
      best = { row, similarity };
    }
  }
  return best?.row;
}

function parseReview(row: MemoryReviewRecord): MemoryReviewRow {
  return {
    id: row.id,
    user_id: row.user_id,
    status: row.status,
    candidate: JSON.parse(row.candidate_json) as ProcessMemoryCandidateInput,
    resolved_action: row.resolved_action,
    memory_id: row.memory_id,
    project_id: row.project_id,
    session_id: row.session_id,
    source: row.source,
    reason: row.reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
    resolved_at: row.resolved_at,
  };
}

export interface CreateMemoryReviewsResult {
  reviews: MemoryReviewRow[];
  // Candidates that reinforced an existing standing rule instead of queueing a row (recurrence).
  reinforcements: ReinforcementResult[];
}

export async function createMemoryReviews(env: Env, candidates: ProcessMemoryCandidateInput[]): Promise<CreateMemoryReviewsResult> {
  const timestamp = nowIso();
  const reviews: MemoryReviewRow[] = [];
  const reinforcements: ReinforcementResult[] = [];
  const createdIds: string[] = [];
  const mergedIds: string[] = [];
  const skippedDuplicateIds: string[] = [];

  for (const candidate of candidates) {
    const activeDuplicate = await findActiveDuplicate(env, candidate);
    if (activeDuplicate) {
      skippedDuplicateIds.push(activeDuplicate.id);
      // Recurrence (captain decision 4): a correction restating a rule that is already ACTIVE means
      // the agent repeated a mistake that rule covers. Nothing is queued — the human already made
      // this rule — but the rule gets a bounded importance bump and a recurrence counter, which is
      // what makes repeat rate measurable (lifecycleReport()). Same-direction by construction: it is
      // the candidate's own rule text that matched, not its `supersedes_query`.
      if (candidate.signal === 'correction') {
        const reinforcement = await reinforceMemory(env, activeDuplicate, candidate);
        if (reinforcement) reinforcements.push(reinforcement);
      }
      continue;
    }

    // Set below when a correction refuses to merge into the pending row it contradicts, so the
    // human sees both rows and the link between them. Server-written, never client-supplied.
    let outgoing = candidate;
    const similar = await findSimilarPendingReview(env, candidate);

    if (similar) {
      const existing = JSON.parse(similar.candidate_json) as ProcessMemoryCandidateInput;
      const incomingIsCorrection = candidate.signal === 'correction';
      const existingIsCorrection = existing.signal === 'correction';
      // A correction and the affirmative statement it invalidates score >= 0.5 against each other
      // (they reuse the same wording), so today's merge would newline-concatenate a preference with
      // its own negation into one row AND keep the older, affirmative evidence. Never merge across
      // that boundary; and merge two corrections only when they are the same kind of correction.
      const mergeable = incomingIsCorrection === existingIsCorrection
        && (!incomingIsCorrection
          || ((existing.signal_subtype ?? '') === (candidate.signal_subtype ?? '') && (existing.rule_form ?? null) === (candidate.rule_form ?? null)));

      if (!mergeable) {
        if (incomingIsCorrection) outgoing = { ...candidate, supersedes_pending_review_id: similar.id };
      } else {
        // Newest evidence wins for a correction↔correction merge: the incoming candidate's
        // correction/supersedes_query/antecedent_source/signal_subtype describe the more recent
        // moment. Legacy (non-correction) merges keep spreading the existing candidate.
        const merged: ProcessMemoryCandidateInput = incomingIsCorrection
          ? {
              ...existing,
              signal: candidate.signal,
              signal_subtype: candidate.signal_subtype,
              rule_form: candidate.rule_form,
              antecedent_source: candidate.antecedent_source,
              correction: candidate.correction,
              supersedes_query: candidate.supersedes_query,
              supersedes_pending_review_id: candidate.supersedes_pending_review_id,
              project_context: candidate.project_context,
              source: candidate.source ?? existing.source ?? null,
              content: mergeContent(existing.content, candidate.content),
              importance: Math.max(existing.importance, candidate.importance),
              confidence: Math.max(existing.confidence, candidate.confidence),
            }
          : {
              ...existing,
              content: mergeContent(existing.content, candidate.content),
              importance: Math.max(existing.importance, candidate.importance),
              confidence: Math.max(existing.confidence, candidate.confidence),
            };
        // The row's `source` column — not just the JSON — must follow the surviving evidence:
        // parseReview() and listMemoryReviews()'s source filter both read the column, so leaving it
        // stale makes the queue lie about which client produced what's now in the row.
        const mergedSource = candidate.source ?? similar.source;
        await env.DB.prepare(`UPDATE memory_reviews SET candidate_json = ?1, source = ?2, updated_at = ?3 WHERE id = ?4`)
          .bind(JSON.stringify(merged), mergedSource, timestamp, similar.id)
          .run();

        mergedIds.push(similar.id);
        reviews.push({
          id: similar.id,
          user_id: similar.user_id,
          status: 'pending',
          candidate: merged,
          resolved_action: null,
          memory_id: null,
          project_id: similar.project_id,
          session_id: similar.session_id,
          source: mergedSource,
          reason: null,
          created_at: similar.created_at,
          updated_at: timestamp,
          resolved_at: null,
        });
        continue;
      }
    }

    // candidate_json is free-form TEXT, so the whole validated candidate — including the
    // correction-evidence fields — is persisted verbatim with no schema change. The row's
    // project_id stays the candidate's real project_id: `project_context` is a scope-neutral
    // display/lookup hint and must never drive the column, scope validation, or visibility.
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO memory_reviews (
        id, user_id, status, candidate_json, project_id, session_id, source, created_at, updated_at
      ) VALUES (?1, ?2, 'pending', ?3, ?4, ?5, ?6, ?7, ?8)`
    )
      .bind(id, outgoing.user_id, JSON.stringify(outgoing), outgoing.project_id ?? null, outgoing.session_id ?? null, outgoing.source ?? null, timestamp, timestamp)
      .run();

    createdIds.push(id);
    reviews.push({
      id,
      user_id: outgoing.user_id,
      status: 'pending',
      candidate: outgoing,
      resolved_action: null,
      memory_id: null,
      project_id: outgoing.project_id ?? null,
      session_id: outgoing.session_id ?? null,
      source: outgoing.source ?? null,
      reason: null,
      created_at: timestamp,
      updated_at: timestamp,
      resolved_at: null,
    });
  }

  if (createdIds.length > 0) {
    await writeMemoryEvent(env, {
      userId: candidates[0].user_id,
      eventType: 'review_create',
      payload: { count: createdIds.length, review_ids: createdIds },
    });
  }
  if (mergedIds.length > 0) {
    await writeMemoryEvent(env, {
      userId: candidates[0].user_id,
      eventType: 'review_merge',
      payload: { count: mergedIds.length, review_ids: mergedIds },
    });
  }
  if (skippedDuplicateIds.length > 0) {
    await writeMemoryEvent(env, {
      userId: candidates[0].user_id,
      eventType: 'review_skip_duplicate',
      payload: { count: skippedDuplicateIds.length, matched_memory_ids: skippedDuplicateIds },
    });
  }

  return { reviews, reinforcements };
}

// `signal` lives inside candidate_json, so both the correction-first ordering and the signal filter
// have to be SQL expressions — sorting a returned page client-side cannot work when the query
// paginates. The `CASE WHEN json_valid(...)` wrapper is required, not decorative: SQLite does not
// short-circuit AND, so `json_valid(x) AND json_extract(x, '$.signal')` still throws on a malformed
// row. No index exists on this expression and none is added (that would be a migration); at
// single-operator volume scanning one user's reviews is fine — revisit past ~10k rows.
const SIGNAL_EXPR = `(CASE WHEN json_valid(candidate_json) THEN COALESCE(json_extract(candidate_json, '$.signal'), '') ELSE '' END)`;

// Suggestion lookups cost one search each, so cap how many a single response can trigger. Rows past
// the cap report supersedes_candidates: null plus suggestions_truncated on the response.
const MAX_SUPERSEDE_LOOKUPS_PER_RESPONSE = 20;

// The promotion lookup is a separate D1 scan with its own eligibility (project-scoped corrections,
// no `supersedes_query` needed), hence its own budget. Rows past it report promotion_candidates: null
// and set the same `suggestions_truncated` flag — "some suggestion on this page was not computed".
const MAX_PROMOTION_LOOKUPS_PER_RESPONSE = 20;

export async function listMemoryReviews(env: Env, input: { user_id: string; status: 'pending' | 'resolved' | 'all'; project_id?: string | null; session_id?: string | null; source?: string | null; signal?: string | null; limit: number; offset: number; include_suggestions?: boolean }): Promise<{ reviews: MemoryReviewRow[]; suggestions_truncated: boolean }> {
  const clauses = ['user_id = ?'];
  const bindings: unknown[] = [input.user_id];

  if (input.status !== 'all') {
    clauses.push('status = ?');
    bindings.push(input.status);
  }
  if (input.project_id) {
    clauses.push('(project_id IS NULL OR project_id = ?)');
    bindings.push(input.project_id);
  }
  if (input.session_id) {
    clauses.push('session_id = ?');
    bindings.push(input.session_id);
  }
  if (input.source) {
    clauses.push('source = ?');
    bindings.push(input.source);
  }
  if (input.signal) {
    // Candidates written before the evidence fields existed (and ones whose signal was coerced to
    // 'none') both read as "no signal", so `signal=none` must match the empty string too.
    if (input.signal === 'none') {
      clauses.push(`${SIGNAL_EXPR} IN ('none', '')`);
    } else {
      clauses.push(`${SIGNAL_EXPR} = ?`);
      bindings.push(input.signal);
    }
  }

  const result = await env.DB.prepare(
    `SELECT * FROM memory_reviews
     WHERE ${clauses.join(' AND ')}
     ORDER BY (${SIGNAL_EXPR} = 'correction') DESC, updated_at DESC, created_at DESC
     LIMIT ? OFFSET ?`
  )
    .bind(...bindings, input.limit, input.offset)
    .all<MemoryReviewRecord>();

  const reviews = (result.results ?? []).map(parseReview);
  if (!input.include_suggestions) return { reviews, suggestions_truncated: false };

  // Supersession lookups run only for pending correction rows that actually carry a query, and only
  // for the first N of them in page order — everything else would be a search that can't produce a
  // suggestion anyway.
  const supersedeEligible = new Set<string>();
  // `promotionShaped` is "this row could have a promotion suggestion at all"; `promotionEligible` is
  // the subset inside this response's budget. The distinction matters: only a shaped-but-over-budget
  // row may report `null` ("not computed"), never one that was simply never promotable.
  const promotionShaped = new Set<string>();
  const promotionEligible = new Set<string>();
  let suggestionsTruncated = false;
  for (const review of reviews) {
    if (review.status !== 'pending') continue;
    if (review.candidate.signal !== 'correction') continue;
    // A project correction can be promotable without carrying a supersedes_query, so the two
    // eligibility tests are independent.
    if (review.candidate.scope === 'project' && (review.candidate.project_id ?? review.candidate.project_context ?? review.project_id)) {
      promotionShaped.add(review.id);
      if (promotionEligible.size >= MAX_PROMOTION_LOOKUPS_PER_RESPONSE) suggestionsTruncated = true;
      else promotionEligible.add(review.id);
    }
    if (!review.candidate.supersedes_query?.trim()) continue;
    if (supersedeEligible.size >= MAX_SUPERSEDE_LOOKUPS_PER_RESPONSE) {
      suggestionsTruncated = true;
      continue;
    }
    supersedeEligible.add(review.id);
  }

  // Only worth computing for still-pending rows — a resolved review's suggestion is moot.
  const withSuggestions = await Promise.all(
    reviews.map(async (review): Promise<MemoryReviewRow> => {
      if (review.status !== 'pending') return { ...review, potential_duplicate: null };

      const supersedes = supersedeEligible.has(review.id)
        ? await findSupersedeCandidates(env, review.candidate, review.project_id)
        : review.candidate.signal === 'correction' && review.candidate.supersedes_query?.trim()
          ? null
          : undefined;
      const supersedesField = supersedes === undefined ? {} : { supersedes_candidates: supersedes };

      // Same three-state contract as supersedes: an array when computed, null when eligible but
      // over budget, absent when the row was never eligible (so non-correction rows stay byte-clean).
      const promotions = promotionEligible.has(review.id)
        ? await findPromotionCandidates(env, review.candidate, review.project_id)
        : promotionShaped.has(review.id)
          ? null
          : undefined;
      const promotionField = promotions === undefined ? {} : { promotion_candidates: promotions };

      const match = await findBestMatch(env, review.candidate);
      if (!match) return { ...review, potential_duplicate: null, ...supersedesField, ...promotionField };
      const { action, reason } = heuristicDecision(review.candidate, match);
      return { ...review, potential_duplicate: { memory_id: match.id, content: match.content, action, reason }, ...supersedesField, ...promotionField };
    })
  );

  return { reviews: withSuggestions, suggestions_truncated: suggestionsTruncated };
}

export async function resolveMemoryReview(env: Env, id: string, input: { user_id: string; action: 'add' | 'merge' | 'update' | 'delete' | 'ignore'; memory_id?: string | null; reason?: string | null; promote_to_global?: boolean }): Promise<{ review: MemoryReviewRow; memory?: Awaited<ReturnType<typeof createMemory>>; promoted_to_global?: boolean }> {
  const existing = await env.DB.prepare('SELECT * FROM memory_reviews WHERE id = ?1 AND user_id = ?2').bind(id, input.user_id).first<MemoryReviewRecord>();
  if (!existing) throw new UserFacingError('Review not found.');
  // `promote_to_global` accepts the row's promotion suggestion (captain decision 8) in the same call
  // that activates it. Only meaningful for `add`: merge/update write into an EXISTING memory, and
  // rescoping someone else's memory as a side effect of resolving a review is exactly the silent
  // rescope the decision forbids — those stay an explicit asaki_memory_update.
  if (input.promote_to_global && input.action !== 'add') {
    throw new UserFacingError('promote_to_global is only supported when action is add.');
  }

  const review = parseReview(existing);
  const timestamp = nowIso();

  // Atomically claim the review: fold the "is it still pending" check and the resolved-status
  // write into one conditional UPDATE, so two concurrent resolve requests can't both read
  // status='pending' and both go on to run add/merge/update/delete side effects. Only the
  // request whose UPDATE actually changes a row (changes === 1) proceeds; the loser throws the
  // same "already resolved" error it would have gotten from the old in-memory check.
  const claim = await env.DB.prepare(
    `UPDATE memory_reviews
     SET status = 'resolved', resolved_action = ?1, memory_id = ?2, reason = ?3, updated_at = ?4, resolved_at = ?5
     WHERE id = ?6 AND user_id = ?7 AND status = 'pending'`
  )
    .bind(input.action, input.memory_id ?? null, input.reason ?? null, timestamp, timestamp, id, input.user_id)
    .run();

  if (claim.meta.changes !== 1) throw new UserFacingError('Review is already resolved.');

  let memory: Awaited<ReturnType<typeof createMemory>> | undefined;
  let memoryId: string | null = null;
  let mutated = false;

  // The claim above already committed status='resolved' so a second concurrent resolve can't
  // also run these side effects — but that means a failure here (e.g. a stale/deleted
  // memory_id) must not leave the review permanently stuck "resolved" with nothing having
  // actually happened. Revert the claim back to 'pending' on failure so the review stays
  // retryable — but ONLY while no memory mutation has committed yet: once createMemory/
  // updateMemoryContent/deleteMemory has durably run, reverting to 'pending' would invite a
  // retry that re-applies the action (e.g. a second duplicate memory for 'add' whose first
  // copy nothing references). After the mutation, a trailing failure keeps the review
  // resolved and rethrows.
  const promoted = input.promote_to_global === true && review.candidate.scope !== 'global';

  try {
    if (input.action === 'add') {
      // Promotion is a human decision made at resolve time; the stored candidate is left untouched so
      // the review row keeps saying what the classifier actually proposed.
      memory = await createMemory(env, promoted ? { ...review.candidate, scope: 'global', project_id: null, session_id: null } : review.candidate);
      mutated = true;
    }

    if (input.action === 'merge') {
      if (!input.memory_id) throw new UserFacingError('memory_id is required when action is merge.');
      const target = await getMemory(env, input.memory_id, input.user_id);
      if (!target) throw new UserFacingError('Target memory not found.');
      memory = await updateMemoryContent(env, target, {
        content: mergeContent(target.content, review.candidate.content),
        importance: Math.max(target.importance, review.candidate.importance),
        confidence: Math.max(target.confidence, review.candidate.confidence),
      });
      mutated = true;
    }

    if (input.action === 'update') {
      if (!input.memory_id) throw new UserFacingError('memory_id is required when action is update.');
      const target = await getMemory(env, input.memory_id, input.user_id);
      if (!target) throw new UserFacingError('Target memory not found.');
      memory = await updateMemoryContent(env, target, {
        content: review.candidate.content,
        importance: review.candidate.importance,
        confidence: review.candidate.confidence,
        // A correction resolved as `update` usually retypes the target (a `rule` replacing a
        // `fact`); scope stays untouched — rescoping is a separate, explicit audit action.
        kind: review.candidate.kind !== target.kind ? review.candidate.kind : undefined,
      });
      mutated = true;
    }

    if (input.action === 'delete') {
      if (!input.memory_id) throw new UserFacingError('memory_id is required when action is delete.');
      const deleted = await deleteMemory(env, input.memory_id, input.user_id);
      if (!deleted) throw new UserFacingError('Target memory not found.');
      memory = deleted;
      mutated = true;
    }

    memoryId = memory?.id ?? input.memory_id ?? null;
    if (memory?.id && memory.id !== (input.memory_id ?? null)) {
      // action === 'add': createMemory() only generates the new memory's id after the claim
      // UPDATE above already ran (it didn't know this id yet), so backfill it now. No WHERE
      // status = 'pending' guard needed here — this row is already exclusively ours from the claim.
      await env.DB.prepare(`UPDATE memory_reviews SET memory_id = ?1 WHERE id = ?2 AND user_id = ?3`)
        .bind(memoryId, id, input.user_id)
        .run();
    }
  } catch (error) {
    if (!mutated) {
      await env.DB.prepare(
        `UPDATE memory_reviews
         SET status = 'pending', resolved_action = NULL, memory_id = NULL, reason = NULL, updated_at = ?1, resolved_at = NULL
         WHERE id = ?2 AND user_id = ?3`
      )
        .bind(nowIso(), id, input.user_id)
        .run();
    }
    throw error;
  }

  // Provenance on activation (captain decision 9): a correction that just became (or rewrote) an
  // active memory stamps the compressed correction moment onto that memory, so its origin survives
  // after nobody consults review rows any more. `delete` is excluded on purpose — there is no
  // activated memory to carry provenance, only a retired one. Best-effort inside
  // recordCorrectionOrigin(): the mutation above has already committed.
  if (memory && (input.action === 'add' || input.action === 'update' || input.action === 'merge')) {
    const origin = await recordCorrectionOrigin(env, memory, review.candidate, id);
    if (origin) memory = { ...memory, metadata_json: JSON.stringify({ ...parseMemoryMetadata(memory.metadata_json), correction_origin: origin }) };
  }

  await writeMemoryEvent(env, {
    memoryId,
    userId: input.user_id,
    eventType: 'review_resolve',
    payload: { review_id: id, action: input.action, reason: input.reason ?? null, promoted_to_global: promoted },
  });

  return {
    review: {
      ...review,
      status: 'resolved',
      resolved_action: input.action,
      memory_id: memoryId,
      reason: input.reason ?? null,
      updated_at: timestamp,
      resolved_at: timestamp,
    },
    memory,
    ...(promoted ? { promoted_to_global: true } : {}),
  };
}
