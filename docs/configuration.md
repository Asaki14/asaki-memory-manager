# Configuration

## Deploying the Worker

1. Install Node.js 20 or newer and dependencies with `npm ci`.
2. Copy `wrangler.example.jsonc` to `wrangler.jsonc` and set the D1 `database_id`.
3. Create the Cloudflare D1 database and Vectorize index named `asaki-memory-manager`. Configure Vectorize metadata indexes for `user_id`, `scope`, `project_id`, `session_id`, and `kind`.
4. Set `ADMIN_API_KEY` with `npx wrangler secret put ADMIN_API_KEY`.
5. Apply migrations with `npm run db:migrate:remote` and deploy with `npm run deploy`.

Upgrading an existing deployment: run `npx wrangler d1 migrations apply asaki-memory-manager --remote` before `npm run deploy`. Migration `0007_rename_user_verdict.sql` rewrites the stored old verdict key to `user_verdict`. The Worker reads only `user_verdict`, so deploying before migrating shows empty verdicts for existing rows.

Create the Vectorize index with 1024 dimensions and cosine metric. The template configures Workers AI embedding model `@cf/baai/bge-m3`, the merge-decision model `@cf/meta/llama-3.1-8b-instruct-fp8`, and an optional rate-limit binding. The rate limit is keyed by `user_id`; the sample allows 30 requests per minute. Without the rate-limit binding, the Worker skips those checks.

For local development, copy the template, create local resources as needed, run `npm run db:migrate:local`, then `npm run dev`. Wrangler configuration and secrets are not committed.

## Client configuration

The Claude Code hooks use `ASAKI_MEMORY_BASE_URL`, `ASAKI_MEMORY_API_KEY`, and `ASAKI_MEMORY_USER_ID`. Pi accepts `ASAKI_MEMORY_BASE_URL` or `ASAKI_MEMORY_API_URL`, `ASAKI_MEMORY_API_KEY`, and `ASAKI_MEMORY_USER_ID`; it also supports its `asaki-memory.json` configuration file. Pi's default user ID is `asaki`. Codex uses its hook integration and a local stdio MCP server.

### Session context

| Setting | Default | Behavior |
|---|---:|---|
| `ASAKI_MEMORY_STANDING_RULES` | `1` | Enable the bounded standing-rule block. |
| `ASAKI_MEMORY_STANDING_RULES_MAX` | `20` | Maximum rules in the block. |
| `ASAKI_MEMORY_STANDING_RULES_KINDS` | `rule,preference` | Kinds rendered as instructions. Set to `rule` to omit preferences. |
| `ASAKI_MEMORY_PROJECT_DIGEST` | `1` | Enable the bounded project-memory digest. |
| `ASAKI_MEMORY_PROJECT_DIGEST_MAX` | `10` | Maximum expanded digest entries; clamped to 50. |
| `ASAKI_MEMORY_PROJECT_DIGEST_MAX_CHARS` | `6000` | Character budget for the full block; clamped to 20,000. |
| `ASAKI_MEMORY_PROJECT_DIGEST_CONTENT_CHARS` | `240` | Per-memory excerpt cap; clamped to 2,000. |
| `ASAKI_MEMORY_DIGEST_INDEX` | `1` | Include ID rows for memories not expanded in the digest. |

Both blocks use the list response the clients already fetch. Standing rules are capped at 4,000 characters, ordered by importance, recency, then ID. The digest is the dynamic complement of standing-rule kinds, so one memory cannot appear in both blocks. Its ID index contains at most 30 rows and 2,000 characters inside the overall digest budget.

### Pi classifier and retrieval

| Setting | Default | Behavior |
|---|---:|---|
| `ASAKI_MEMORY_AUTO_MIN_SCORE` | `0.67` | Minimum score for auto-injected results; must be in `[0,1]`. |
| `ASAKI_MEMORY_AUTO_INJECT_TOP_K` | `6` | Auto-injection result count; clamped to 20. |
| `ASAKI_MEMORY_AUTO_EXTRACT` | `0` | Deprecated server-side raw-text extraction; keep disabled for routine capture. |
| `ASAKI_MEMORY_AUTO_CLASSIFIER` | `1` | Enable the local background classifier. |
| `ASAKI_MEMORY_STARTUP_INJECT` | `1` | Enable startup retrieval. |
| `ASAKI_MEMORY_EXTRACT_MIN_INTERVAL_SECONDS` | `300` | Minimum interval between background classifier runs. |
| `ASAKI_MEMORY_CORRECTION_MODE` | `1` | Include correction evidence in classifier requests. |
| `ASAKI_MEMORY_ACTION_TRACE` | `1` | Include redacted tool-call traces in classifier input. |

The Pi configuration file supports the same client options. Invalid numeric values fall back to defaults or caps. Action traces leave the client device for classifier judgment; paths, URIs, and hosts are redacted, but non-path free text is not. See [Security](security.md) and the [Claude Code integration guide](../integrations/claude-code/README.md) before enabling trace transmission.

`ASAKI_MEMORY_ORCHESTRATOR_HOME` is optional and has no default. If set, Claude Code and Pi inspect its `state/*.meta` task metadata to attribute memories to repositories named by active tasks. Each metadata file uses `key=value` lines; `project` is the target repository path and optional `worktree` identifies a task worktree. If unset, this attribution feature is disabled and no home directory is inferred.

Other optional client settings and bounds are validated in `src/utils/validation.ts`, `integrations/claude-code/stop-extract.sh`, and `integrations/pi/asaki-memory.ts`. See the integration READMEs for client-specific setup.
