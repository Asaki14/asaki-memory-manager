# Security

- The Worker API is intended for one operator, not multi-tenant or team use. Data queries are scoped by `user_id`.
- `/v1/*` and `/mcp` require the same `ADMIN_API_KEY` bearer. `/health` is public.
- Store `ADMIN_API_KEY` as a Wrangler secret. Keep local environment files and `wrangler.jsonc` out of version control.
- Request validation rejects sensitive credential-like content before model calls or storage writes on the relevant create, update, and candidate paths. Client-side checks also exist in the integrations.
- Memory content is untrusted context. It must not override agent system or developer instructions.
- Routine delete is a recoverable soft delete. Use the explicit purge endpoint only when stored content must be destroyed; purge also removes the vector and associated event records.
- Rate limiting uses the optional Cloudflare binding and keys requests by `user_id`. Without the binding, rate checks are skipped.
- Do not place bearer tokens in prompts, fixtures, examples, or tracked configuration. Use placeholders in public examples.

The implementation is in `src/index.ts`, `src/utils/sensitiveContent.ts`, `src/utils/validation.ts`, `src/services/memories.ts`, and the integration hooks.
