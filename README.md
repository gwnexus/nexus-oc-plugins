# nexus-oc-plugins

[![CI](https://github.com/gwnexus/nexus-oc-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/gwnexus/nexus-oc-plugins/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-22%2B-green.svg)](https://nodejs.org)
[![OpenCode 1.14+](https://img.shields.io/badge/opencode-1.14%2B-black.svg)](https://opencode.ai)

OpenCode plugins for the [Nexus](https://nexus.gatewarden.eu) platform.

These plugins extend OpenCode with deep Nexus integration. Each plugin targets a
specific problem in the agent lifecycle: session continuity across compaction
events, cost visibility via session timeline recording, and context budget
management through pre-injection compression of Nexus MCP outputs.

Plugins are standalone `.ts` files — no build step, no monorepo toolchain. Each
plugin is independently installable via the OpenCode auto-discovery mechanism
(`.opencode/plugins/`).

## Plugins

| Plugin | Version | Description |
| --- | --- | --- |
| [**Compaction Plus**](./100-compaction-plus/README.md) | `v1.8.1` | Preserves Nexus session context across OpenCode compaction events |
| [**Cost Control**](./200-cost-control/README.md) | `v1.0.1` | Token usage and cost tracking via native message data |
| [**Headroom Intercept**](./300-headroom-intercept/README.md) | `v0.5.13` | Pre-injection context compression for Nexus MCP tool outputs |
| [**Session Guard**](./400-session-guard/README.md) | `v1.1.2` | Enforces session append discipline after code-changing tool calls |

## Compaction Plus

**`v1.8.1` · [`100-compaction-plus`](./100-compaction-plus)**

OpenCode compacts long conversations to manage context budget. During
compaction, the LLM generates a continuation summary from the conversation
history — but Nexus state (active session, open tasks, recent ADRs, project
directives) is not part of that history in a structured way, so it risks being
lost or summarized away.

This plugin solves that by hooking directly into the compaction lifecycle:

- **`experimental.session.compacting`** -- Before the LLM generates the
  continuation summary, the plugin injects structured Nexus context: active
  session ID, open tasks, recent ADRs, enabled directives, and key file paths.
  The compacted summary retains awareness of ongoing Nexus work.

- **`session.compacted`** -- After compaction completes, the plugin appends a
  `compaction` entry to the active Nexus session via MCP. This creates an
  auditable trail of compaction events in the session timeline.

**Required:** Nexus MCP server (`NEXUS_API_URL`, `NEXUS_PRIVATE_TOKEN`)

## Cost Control

**`v1.0.1` · [`200-cost-control`](./200-cost-control)**

Makes token usage and cost visible in the Nexus session timeline by connecting
[Helicone](https://helicone.ai) -- an LLM observability proxy -- to the Nexus
session recording pipeline.

- **Session grouping** -- injects the active Nexus session ID as a
  `Helicone-Session-Id` property so every LLM call in a session is grouped and
  queryable in the Helicone dashboard.

- **`session.idle` recording** -- when the agent finishes a work burst, queries
  Helicone for cumulative token and cost data and appends a structured summary
  to the Nexus session timeline. Recording is debounced (5-minute minimum
  interval) to avoid timeline noise.

- **`nexus_cost_summary` tool** -- exposes an agent-callable tool for on-demand
  live cost snapshots at any point in a session.

**Required:** `HELICONE_API_KEY`, Nexus MCP server  
**Roadmap:** `v2.0.0` will read cost data from OpenCode native message data,
removing the Helicone dependency.

## Headroom Intercept

**`v0.5.13` · [`300-headroom-intercept`](./300-headroom-intercept)**

Nexus MCP tools can return large payloads -- `kb_memory` at `depth: deep`,
`dispatch_inbox` with many entries, `kb_search` result sets -- that consume
significant context budget before the agent can decide whether to compress
them. The Headroom MCP tools (`headroom_compress`, `headroom_retrieve`)
operate post-hoc: by the time the agent calls them, the original output is
already in the context window.

This plugin moves compression to the runtime layer via the `tool.execute.after`
hook, intercepting Nexus MCP outputs before they enter the agent context:

```
MCP tool executes -> result returned -> tool.execute.after fires
  -> plugin evaluates policy -> if threshold exceeded: store original,
    replace output with compact summary -> compact result enters context
```

Compression is policy-based and per-tool: each Nexus MCP tool has an explicit
action (`compress`, `passthrough`, `skip`) with a configurable token threshold
and compression profile. Originals are retrievable via the plugin's own
`nexus_headroom_intercept_retrieve` tool (in-memory + disk cache, 24h TTL).

**Default mode:** `observe` (metrics only, no mutation -- safe for all environments)  
**Transform mode:** requires `HEADROOM_MODE=transform`

## Session Guard

**`v1.1.2` · [`400-session-guard`](./400-session-guard)**

Agents frequently skip `nexus_session_append` calls after completing work
packages, leaving gaps in the session audit trail. This plugin detects
code-changing tool completions and reminds the agent to append a session entry
before proceeding.

- **`tool.execute.after`** -- detects trigger tools (`Edit`, `Write`,
  `MultiEdit`, mutating `Bash`, `nexus_task_create`, `nexus_adr_create`,
  `nexus_adr_decide`) and injects a `<system-reminder>` into tool output when
  `nexus_session_append` hasn't been called since the last user instruction.

- **`event (message.created)`** -- tracks user turn index to determine work
  unit boundaries. The reminder fires once per user turn until an append is
  recorded.

- **Bash heuristic** -- read-only commands (`cat`, `grep`, `git status`,
  `ls`, `npm ls`, etc.) are excluded from triggers to avoid false positives.

**Required:** Nexus MCP server (session must be active)  
**Ref:** ADR-0066

## Installation

Each plugin is a single `.ts` file. Drop it into `.opencode/plugins/` and
OpenCode auto-discovers it on the next start.

```bash
# Example: install Compaction Plus
cp 100-compaction-plus/nexus-compaction-plus.ts /path/to/project/.opencode/plugins/
```

Declare the SDK dependency in `.opencode/package.json`:

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "^1.14.0"
  }
}
```

Set the shared environment variables:

```bash
export NEXUS_API_URL="https://nexus.gatewarden.eu"
export NEXUS_PRIVATE_TOKEN="nxs_pat_..."
```

See each plugin's README for plugin-specific configuration.

When using `nexus init` or `nexus pull`, recommended plugins are downloaded
automatically based on your project configuration.

## Project Structure

```
nexus-oc-plugins/
  100-compaction-plus/
    nexus-compaction-plus.ts   -- plugin source
    README.md
  200-cost-control/
    nexus-cost-control.ts      -- plugin source
    README.md
  300-headroom-intercept/
    nexus-headroom-intercept.ts -- plugin source
    README.md
  400-session-guard/
    nexus-session-guard.ts     -- plugin source
    README.md
```

## Requirements

- [OpenCode](https://opencode.ai) `v1.14+` with plugin support
- Node.js `>= 22` (for local typecheck)
- Nexus platform account with MCP access configured
- `NEXUS_API_URL` and `NEXUS_PRIVATE_TOKEN` environment variables
- `HELICONE_API_KEY` for `nexus-cost-control` (v1.0.x only)

## Development

```bash
# Install tooling
npm install

# Type-check all plugins
npm run typecheck

# Run tests
npm test

# Run tests in watch mode
npm run test:watch
```

## Related

- [nexus-cli](https://github.com/gwnexus/nexus-cli) -- Nexus command-line interface
- [nexus-mcp](https://github.com/gwnexus/nexus-mcp) -- Nexus MCP server
- [Gatewarden Nexus](https://nexus.gatewarden.eu) -- platform

## License

Apache-2.0 — Copyright 2025-2026 RELICFROG Holding UG, contributed by Patrick Paechatz. See [LICENSE](./LICENSE).
