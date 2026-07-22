# nexus-compaction-plus

An [OpenCode](https://opencode.ai) plugin that preserves [Nexus](https://nexus.gatewarden.eu) session context across compaction events.

**Current version:** `v1.8.0`  
**Requires:** Nexus MCP server (`NEXUS_API_URL`, `NEXUS_PRIVATE_TOKEN`)

When OpenCode compacts a long conversation, important session metadata — active tasks, recent decisions, project directives — can be lost. This plugin hooks into compaction to:

1. **Inject Nexus context** into the compaction prompt (`experimental.session.compacting`) so the continuation summary includes project-relevant state
2. **Record the compaction event** in the active Nexus session (`session.compacted`) as an auditable `compaction` entry

## Installation

### From local file (recommended)

```bash
# Copy into your project
cp nexus-compaction-plus.ts /path/to/your-project/.opencode/plugins/
```

### Dependencies

Ensure your `.opencode/package.json` includes the plugin SDK:

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "^1.14.0"
  }
}
```

### Environment variables

The plugin reads MCP config from your `opencode.json`. Ensure the Nexus MCP server is configured:

```json
{
  "mcp": {
    "nexus": {
      "type": "local",
      "command": ["npx", "--yes", "@gwdn/nexus-mcp@latest"],
      "environment": {
        "NEXUS_API_URL": "https://nexus.gatewarden.eu",
        "NEXUS_PRIVATE_TOKEN": "nxs_pat_..."
      }
    }
  }
}
```

## How it works

### Pre-compaction (`experimental.session.compacting`)

Before the LLM generates a continuation summary, the plugin injects structured context:

- Active Nexus session ID and title
- Open tasks (title + status)
- Recent ADRs (title + status)
- Enabled project directives
- Key file paths from the session

This ensures the compacted summary retains awareness of ongoing Nexus work.

### Post-compaction (`session.compacted`)

After compaction completes, the plugin appends a `compaction` entry to the active Nexus session via MCP:

```
nexus_session_append({
  session_id: "<active-session>",
  entry_type: "compaction",
  summary: "Session compacted at HH:MM — N messages → M tokens retained"
})
```

This creates an auditable trail of compaction events visible in the Nexus session timeline.

## Configuration

The plugin auto-discovers the active Nexus session and project from MCP tool calls in the conversation history. No additional configuration is needed beyond the MCP server setup.

## Testing

```bash
npm test -- 100-compaction-plus
```

11 unit tests covering hook registration, context injection, state extraction,
compaction lifecycle, and legacy tool-invocation shape support.

## License

MIT — see [LICENSE](../LICENSE)
