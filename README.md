<div align="center">

<img src="assets/logo.svg" width="112" alt="Asaki Memory Manager logo">

# Asaki Memory Manager

**Durable, searchable memory for AI agents, built on Cloudflare.**

English · [中文](README_CN.md)

[![CI](https://github.com/Asaki14/asaki-memory-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/Asaki14/asaki-memory-manager/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/Asaki14/asaki-memory-manager?style=flat-square)](https://github.com/Asaki14/asaki-memory-manager/stargazers)
[![Version](https://img.shields.io/github/v/tag/Asaki14/asaki-memory-manager?sort=semver&style=flat-square)](https://github.com/Asaki14/asaki-memory-manager/tags)
[![License](https://img.shields.io/github/license/Asaki14/asaki-memory-manager?style=flat-square)](LICENSE)

</div>

## Features

| Feature | When | What it does |
|---|---|---|
| Scoped memory | Store preferences, decisions, or project knowledge | Separates global, project, and session memories. |
| Hybrid search | Retrieve relevant memories | Combines semantic search with a D1 lexical fallback. |
| Review queue | Capture from background classifiers | Holds unsupervised candidates for explicit approval. |
| Session context | Start or resume an agent session | Selects bounded standing rules and project context. |
| Memory lifecycle | Audit or clean up stored items | Tracks recurrence, suggests idle-rule review, and offers stale-memory pruning. |
| Cloudflare-native runtime | Self-host the service | Runs the API on Workers with D1, Vectorize, and Workers AI. |

## Quick start

Requires Node.js 20+, a Cloudflare account, and the Workers, D1, Vectorize, and Workers AI services.

```sh
npm ci
npx wrangler login
npx wrangler d1 create asaki-memory-manager
npx wrangler vectorize create asaki-memory-manager --dimensions 1024 --metric cosine
for p in user_id scope project_id session_id kind; do
  npx wrangler vectorize create-metadata-index asaki-memory-manager --propertyName "$p" --type string
done
cp wrangler.example.jsonc wrangler.jsonc
# Set the D1 database_id in wrangler.jsonc.
npm run db:migrate:remote
npx wrangler secret put ADMIN_API_KEY
npm run deploy
```

Configure your client with `ASAKI_MEMORY_BASE_URL`, `ASAKI_MEMORY_API_KEY`, and `ASAKI_MEMORY_USER_ID`. See [Configuration](docs/configuration.md) for local development and client-specific settings.


## Integrations

- **Claude Code:** plugin with local hooks and remote MCP. Install through the repository's Claude Code marketplace manifest; see [`integrations/claude-code/README.md`](integrations/claude-code/README.md).
- **Pi:** optional extension in [`integrations/pi/asaki-memory.ts`](integrations/pi/asaki-memory.ts).
- **Codex:** hook integration and stdio MCP server; setup is in [`integrations/codex/README.md`](integrations/codex/README.md).

The project also contains a local MCP integration in `integrations/mcp/`.

## Why

Most agent memory setups require you to operate a separate database service and memory backend. This project keeps the API and data store in a Cloudflare account: D1 is the source of truth, Vectorize is a recoverable search index, and Workers AI provides embeddings and candidate decisions. It is designed for one operator, not multi-tenant or team use.

## Reference

- [API](docs/api.md)
- [Configuration](docs/configuration.md)
- [Architecture](docs/architecture.md)
- [Security](docs/security.md)
- [Roadmap](ROADMAP.md)

## Uninstall

Remove the client plugin, extension, or hooks using that integration's documented removal steps. If retiring the service, remove the Worker, D1 database, Vectorize index, and their credentials from your Cloudflare account. Deleting a client integration does not delete stored memories.

## Contributing

Open an issue for a bug or proposal, then submit a pull request with a focused change. Keep fixtures synthetic and configuration examples free of real credentials or personal paths. Run the relevant checks from `.github/workflows/ci.yml` before submitting.

## License

[MIT](LICENSE)
