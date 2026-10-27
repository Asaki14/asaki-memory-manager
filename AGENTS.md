# AGENTS.md

## Project

Asaki Memory Manager is a Cloudflare-native personal memory layer for AI agents. It uses Workers, Hono, D1, Vectorize, and Workers AI. It is single-operator, not a multi-tenant product.

## Repository map

- `src/index.ts`: Hono routes, authentication, and request limits.
- `src/services/`: memory CRUD, search, candidate review, lifecycle, and session-context selection.
- `src/utils/`: request validation, sensitive-content checks, and public errors.
- `migrations/`: D1 schema history.
- `integrations/claude-code/`: Claude Code plugin hooks and classifier prompts.
- `integrations/pi/asaki-memory.ts`: optional Pi extension; its project-context implementation mirrors Claude Code.
- `integrations/mcp/`: stdio MCP server.
- `integrations/codex/`: Codex hook integration.
- `test/fixtures/`: offline regression inputs.
- `scripts/eval-*.{mjs,ts,sh}`: offline evals; `package.json` defines commands.
- `wrangler.example.jsonc`: generic Cloudflare binding template.
- `docs/`: API, configuration, architecture, and security references.

## Development

```sh
npm ci
npm run typecheck
npm run typecheck:pi
npm run eval:prompt-sync
npm run eval:project-context
npm run eval:standing-rules
npm run eval:project-digest
npm run eval:inject-env
npm run eval:session-inject
```

CI's offline-evals job lists the full required eval set. Run the corresponding eval after changing its source. `npm run eval:classifier` calls a local classifier and can incur model use; it does not require a Worker or API key.

## Maintainer notes

- Keep D1 as the source of truth. Vectorize is a recoverable semantic index.
- Background classifier candidates enter human review; they do not write memories automatically.
- Claude Code and Pi project-context logic must remain semantically aligned. Run `npm run eval:project-context` after changing either copy.
- Prompt copies are guarded by `npm run eval:prompt-sync`.
- Keep secrets, personal paths, and real deployment settings out of tracked files. Use `wrangler.example.jsonc` for generic configuration.
- Do not deploy or run live Cloudflare operations during offline development.
