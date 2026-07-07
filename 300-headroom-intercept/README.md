# nexus-headroom-intercept

Pre-injection context compression for Nexus MCP tool outputs.

Uses the OpenCode `tool.execute.after` hook to apply policy-based deterministic
compression before tool results enter the agent context window.

## Problem

Headroom's MCP tools (`headroom_compress`, `headroom_retrieve`) operate post-hoc:
the agent can only invoke compression **after** a tool response has already been
consumed into the context window. This plugin moves compression to the runtime
layer, intercepting large outputs before they reach the model.

## How It Works

```
MCP tool execution
  -> result returned to OpenCode
  -> tool.execute.after hook fires
  -> nexus-headroom-intercept evaluates policy
  -> if compress: store original, replace output with compact summary
  -> compact result enters session state and provider prompt
```

## Installation

1. Copy `nexus-headroom-intercept.ts` to your project's `.opencode/plugins/` directory.

2. Ensure `@opencode-ai/plugin` is available:

```json
// .opencode/package.json
{
  "dependencies": {
    "@opencode-ai/plugin": "^1.14.0"
  }
}
```

3. The plugin loads automatically on the next OpenCode start.

## Configuration

### Mode

Set via environment variable:

```bash
export HEADROOM_MODE=transform   # default: apply compression
export HEADROOM_MODE=observe     # log metrics only, no mutation
```

### Policies

Edit the `POLICIES` object in the plugin source to add or modify tool-specific
compression rules:

```ts
const POLICIES = {
  nexus_kb_memory: {
    action: "compress",
    profile: "reference-data",
    minTokens: 2000,
  },
  // ...
}
```

**Actions:**
- `compress` — Apply deterministic compression when output exceeds threshold
- `passthrough` — Never compress (e.g. `headroom_retrieve`)
- `skip` — Ignore entirely (e.g. `bash`, handled by RTK)

**Profiles:**
- `reference-data` — For kb_memory, ADRs, documentation. Preserves titles, IDs, status.
- `structured-list` — For dispatch_sweep, session_list. Aggregates by status, shows top-N.
- `search-results` — For kb_search. Preserves titles, scores, brief snippets.

## Original Content Retrieval

Compressed outputs include a retrieval handle:

```
Full content available: use headroom_retrieve(hash="abc123")
```

Originals are stored in-memory (current session) and on disk
(`.nexus/headroom-cache/`) for cross-session access.

## Logs

Activity is logged to `.nexus/headroom-intercept.log`.

## Requirements

- OpenCode v1.14+
- `@opencode-ai/plugin` ^1.14.0
- Nexus MCP server configured

## Architecture Decision

See ADR-0060: Headroom Pre-Injection Compression via OpenCode Plugin.

## License

MIT - Gatewarden GmbH
