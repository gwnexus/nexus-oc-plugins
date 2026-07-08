# nexus-headroom-intercept

Pre-injection context compression for Nexus MCP tool outputs.

Uses the OpenCode `tool.execute.after` hook to apply policy-based deterministic
compression before tool results enter the agent context window.

**Current version:** `0.5.9`  
**Default mode:** `observe` (safe — metrics only, no mutation)  
**Transform mode:** experimental, requires explicit opt-in and provider-level verification

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
  -> if compress (transform mode): store original, replace output with compact summary
  -> compact result enters session state and provider prompt
```

## Installation

1. Copy `nexus-headroom-intercept.ts` to your project's `.opencode/plugins/` directory,
   or use `nexus pull --force` if you have the Nexus CLI configured.

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

The default mode is **`observe`** — the plugin collects metrics and logs
potential savings, but does not mutate any tool outputs.

To enable compression, set explicitly:

```bash
export HEADROOM_MODE=transform   # apply compression (requires provider verification)
```

To return to safe mode:

```bash
export HEADROOM_MODE=observe     # metrics only, no mutation (default)
```

> **Note:** Transform mode effectiveness at the provider level (i.e. whether the
> compact result, rather than the original MCP response, is serialized into the
> provider request) has not yet been verified by a provider-level sentinel test.
> Use transform mode only in controlled development environments until verification
> is complete.

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
- `passthrough` — Never compress (write operations, explicit retrieval calls)
- `skip` — Ignore entirely (`bash`/`shell` handled by RTK, active editing tools)

**Profiles:**
- `reference-data` — For `kb_memory`, `kb_get`, ADRs. Preserves titles, IDs, status, excerpts.
- `structured-list` — For `dispatch_sweep`, `dispatch_inbox`, task/doc lists. Aggregates by status.
- `search-results` — For `kb_search`. Preserves titles, scores, brief snippets.

## Original Content Retrieval

Compressed outputs include a retrieval handle pointing to the **plugin-owned** retrieval tool:

```
Full content available via plugin retrieval tool:
  nexus_headroom_intercept_retrieve(hash="<sha256>")
```

The plugin registers `nexus_headroom_intercept_retrieve` as an agent-callable tool.
Originals are stored in-memory (current session) and on disk (`.nexus/headroom-cache/`)
for cross-session access (TTL: 24h, quota: 100 MB).

**Retrieval parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `hash` | required | Full SHA-256 hash from the compressed output header |
| `query` | — | Optional substring filter (line-level match) |
| `max_lines` | 100 | Maximum lines to return |
| `max_chars` | 12000 | Maximum characters to return |
| `allow_full` | false | Set to `true` to retrieve the complete original |

If a query matches no lines, a `matched_lines: 0` response is returned with
re-query guidance — the full original is **not** returned by default.

## Storage and Security

- Cache directory: `.nexus/headroom-cache/` — permissions `0700`
- Cache files: `0600`, TTL: 24h, quota: 100 MB / 200 entries
- `.nexus/.gitignore` is created/updated automatically to exclude cache and logs
- **Observe mode** does not persist original content to disk (metrics only)
- **Transform mode** persists originals before replacement for retrieval

## Logs

Activity is logged as structured JSONL to `.nexus/headroom-intercept.jsonl`
(10 MB rotation, 3 retained files, `0600` permissions).

## Compatibility Matrix

| Nexus Core | Plugin version | OpenCode SDK | Default mode | Notes |
|------------|----------------|--------------|--------------|-------|
| `v0.9.2`   | `0.4.0`        | `>=1.14`     | `observe`    | |
| `v0.9.3`   | `0.5.0`        | `>=1.14`     | `observe`    | |
| `v0.9.4`   | `0.5.1`        | `>=1.14`     | `observe`    | |
| `v0.9.5`   | `0.5.2`        | `>=1.14`     | `observe`    | |
| `v0.9.6`   | `0.5.3`        | `>=1.14`     | `observe`    | |
| `v0.9.7`   | `0.5.4`        | `>=1.14`     | `observe`    | |
| `v0.9.8`   | `0.5.5`        | `>=1.14`     | `observe`    | |
| `v0.9.9`   | `0.5.6`        | `>=1.14`     | `observe`    | |
| `v0.9.10`  | `0.5.7`        | `>=1.14`     | `observe`    | §2–§8 fixes |
| `v0.9.11`  | `0.5.8`        | `>=1.14`     | `observe`    | Preflight URL fix (PAT auth) |
| `v0.9.12`  | `0.5.9`        | `>=1.14`     | `observe`    | Complete policy map (37→55 entries, nexus-mcp v0.10.1) |

## Requirements

- OpenCode with `@opencode-ai/plugin` `^1.14.0`
- Nexus MCP server configured
- `NEXUS_API_URL` and `NEXUS_PRIVATE_TOKEN` (or `~/.config/nexus/` TOML files)

## Architecture Decision

See ADR-0060: Headroom Pre-Injection Compression via OpenCode Plugin.

## License

MIT — Gatewarden GmbH
