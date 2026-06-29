# Codex setup

Use the shared MCP server at `integrations/mcp/asaki-memory.ts`.

```toml
[mcp_servers.asaki-memory]
command = "node"
args = ["--experimental-strip-types", "/absolute/path/to/integrations/mcp/asaki-memory.ts"]

[mcp_servers.asaki-memory.env]
ASAKI_MEMORY_SOURCE = "codex"
ASAKI_MEMORY_CONFIG_FILE = "~/.codex/asaki-memory.json"
ASAKI_MEMORY_API_KEY = "your-admin-api-key"
```

Optional hooks: `session-start.sh`, `user-prompt.sh`.
