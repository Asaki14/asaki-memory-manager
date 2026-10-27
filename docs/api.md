# API reference

The Worker exposes a bearer-authenticated REST API and a remote MCP endpoint. Send `Authorization: Bearer <ADMIN_API_KEY>` to `/v1/*` and `/mcp`. `GET /health` is public.

## Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness response. |
| `POST` | `/mcp` | Remote MCP JSON-RPC endpoint. |
| `POST` | `/v1/memories` | Create a memory. |
| `POST` | `/v1/memories/search` | Search scoped memories. |
| `POST` | `/v1/memories/candidates` | Submit pre-distilled candidates for decisions or review. |
| `POST` | `/v1/memories/extract` | Deprecated compatibility extraction endpoint. |
| `POST` | `/v1/memories/get` | Read up to 20 memories by ID. |
| `POST` | `/v1/memories/list` | List memories. |
| `POST` | `/v1/memories/projects` | List project IDs for a user. |
| `POST` | `/v1/memories/reviews` | Create review candidates. |
| `POST` | `/v1/memories/reviews/list` | List review candidates and optional suggestions. |
| `POST` | `/v1/memories/reviews/:id/resolve` | Resolve a review. |
| `POST` | `/v1/memories/lifecycle` | Read lifecycle and idle-rule report. |
| `POST` | `/v1/memories/backfill-index` | Rebuild pending or failed vector entries. |
| `POST` | `/v1/memories/prune-stale` | Dry-run or soft-delete stale memories. |
| `GET` | `/v1/memories/:id?user_id=...` | Read a memory. |
| `PATCH` | `/v1/memories/:id` | Update a memory. |
| `DELETE` | `/v1/memories/:id` | Soft-delete a memory. |
| `POST` | `/v1/memories/:id/purge` | Purge content and associated event/index data. |

Request and response schemas are defined in `src/utils/validation.ts`, `src/types.ts`, and the route handlers in `src/index.ts`. Validation errors return `400`; unauthenticated requests return `401`; missing records return `404`; an unset API key returns `503`; unexpected errors return a sanitized `500`.

## Scope and search

The memory kinds are `preference`, `rule`, `fact`, `decision`, `task_learning`, `bug_fix`, and `workflow`. Explicit `scope=project` requests require `project_id`; explicit `scope=session` requests require `session_id`. Search with no explicit scope returns global memories plus the supplied current project and session. Optional `min_score` filters results to scores in the inclusive range 0–1.

Listing with no explicit scope returns global memories plus only the `project_id` and `session_id` supplied in the request. Without either ID, listing is global-only, not a full-store listing. Use `POST /v1/memories/projects` to enumerate project IDs before listing each project. `status=all` includes archived and deleted memories.

Project enumeration returns distinct project IDs with memory counts, active-memory counts, and pending-review counts. It supports `limit`/`offset` paging and does not include projects represented only by review rows.

## Review queue

Resolve actions are `add`, `merge`, `update`, `delete`, and `ignore`. `merge`, `update`, and `delete` require `memory_id`. `update` replaces the target with candidate text unless explicit `content` is passed. `merge` appends candidate text and ignores `content`; use `update` with explicit `content` to set the exact merged text. Explicit content does not change the target kind, importance, or confidence unless those fields are also provided.

Review list responses include `pending_count`, the total pending review rows for that user across all scopes and projects, independent of filters and pagination. `include_suggestions=true` adds similarity-based duplicate, supersession, and promotion suggestions. This search-heavy mode requires `limit <= 12`. Use `offset` to page through larger queues. Promotion suggestions can be accepted with `{"action":"add","promote_to_global":true}`.

## Lifecycle and indexing

Lifecycle reports include per-rule recurrence counts, aggregate repeat rate, and standing rules with no reinforcement or retrieval within `idle_days` (default 30). Idle rules require a human keep/retire decision; they remain active until explicitly changed.

Backfill scans active memories with `index_status` `pending` or `failed`, re-embeds them, and retries their Vectorize upsert. Stale pruning uses the last retrieval time, falling back to creation time; it soft-deletes by default only when `apply=true`. `rule` and `preference` memories are never pruned by this route.

## Candidate processing

Background classifier sources are unsupervised and always enter review. They cannot automatically add, merge, update, or delete memories. Candidate sources that are not unsupervised may use deterministic duplicate checks and LLM-assisted decisions. Review resolution is explicit.

`POST /v1/memories/get` preserves request order, returns foreign or absent IDs in `missing`, does not truncate memory text, and refreshes `last_accessed_at` for returned memories.

`POST /v1/memories/:id/purge` is separate from routine deletion. It removes memory content, the Vectorize entry, and associated `memory_events` rows.

`POST /v1/memories/lifecycle` is read-only. It reports recurrence and idle standing rules for a human keep/retire decision; it does not delete or demote them.

`POST /v1/memories/prune-stale` defaults to dry-run. Applying it soft-deletes stale memories and excludes `rule` and `preference` kinds.
