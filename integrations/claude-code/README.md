# Claude Code setup

Use the shared MCP server at `integrations/mcp/asaki-memory.ts`.

```json
{
  "mcpServers": {
    "asaki-memory": {
      "command": "node",
      "args": ["--experimental-strip-types", "/absolute/path/to/integrations/mcp/asaki-memory.ts"],
      "env": {
        "ASAKI_MEMORY_SOURCE": "claude-code",
        "ASAKI_MEMORY_CONFIG_FILE": "~/.claude/asaki-memory.json",
        "ASAKI_MEMORY_API_KEY": "your-admin-api-key"
      }
    }
  }
}
```

Optional hooks: `session-start.sh`, `user-prompt.sh`.
