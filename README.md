# nexus-oc-plugins

OpenCode plugins for the [Gatewarden Nexus](https://nexus.gatewarden.eu) platform.

These plugins extend OpenCode with deep Nexus integration. Each plugin targets
a specific problem in the agent lifecycle: session continuity across compaction
events, cost visibility via session timeline recording, and context budget
management through pre-injection compression of Nexus MCP outputs.

Plugins are standalone `.ts` files — no build step, no monorepo toolchain.
Each plugin is independently installable via the OpenCode auto-discovery
mechanism (`.opencode/plugins/`).

## Plugins

| Plugin | Directory | Version | Hook(s) |
| --- | --- | --- | --- |
| [**Compaction Plus**](#compaction-plus) | [`100-compaction-plus`](./100-compaction-plus) | `v1.8.0` | `experimental.session.compacting`, `session.compacted` |
| [**Cost Control**](#cost-control) | [`200-cost-control`](./200-cost-control) | `v1.0.0` | `event (session.idle)` |
| [**Headroom Intercept**](#headroom-intercept) | [`300-headroom-intercept`](./300-headroom-intercept) | `v0.5.10` | `tool.execute.after` |

---

## Compaction Plus

**`v1.8.0` · [`100-compaction-plus`](./100-compaction-plus)**

OpenCode compacts long conversations to manage context budget. During
compaction, the LLM generates a continuation summary from the conversation
history — but Nexus state (active session, open tasks, recent ADRs, project
directives) is not part of that history in a structured way, so it risks being
lost or summarized away.

This plugin solves that by hooking directly into the compaction lifecycle:

- **`experimental.session.compacting`** — Before the LLM generates the
  continuation summary, the plugin injects structured Nexus context: active
  session ID, open tasks, recent ADRs, enabled directives, and key file paths.
  The compacted summary retains awareness of ongoing Nexus work.

- **`session.compacted`** — After compaction completes, the plugin appends a
  `compaction` entry to the active Nexus session via MCP. This creates an
  auditable trail of compaction events in the session timeline — visible in
  the Nexus dashboard and usable by resuming agents.

**Required:** Nexus MCP server (`NEXUS_API_URL`, `NEXUS_PRIVATE_TOKEN`)

---

## Cost Control

**`v1.0.0` · [`200-cost-control`](./200-cost-control)**

Makes token usage and cost visible in the Nexus session timeline by connecting
[Helicone](https://helicone.ai) — an LLM observability proxy — to the Nexus
session recording pipeline.

- **Session grouping**: injects the active Nexus session ID as a
  `Helicone-Session-Id` property so every LLM call in a session is grouped and
  queryable in the Helicone dashboard.

- **`session.idle` recording**: when the agent finishes a work burst, queries
  Helicone for cumulative token and cost data and appends a structured summary
  to the Nexus session timeline. Recording is debounced (5-minute minimum
  interval) to avoid timeline noise.

- **`nexus_cost_summary` tool**: exposes an agent-callable tool for on-demand
  live cost snapshots at any point in a session.

**Required:** `HELICONE_API_KEY`, Nexus MCP server  
**Roadmap:** `v2.0.0` will read cost data from OpenCode native message data,
removing the Helicone dependency.

---

## Headroom Intercept

**`v0.5.10` · [`300-headroom-intercept`](./300-headroom-intercept)**

Nexus MCP tools can return large payloads — `kb_memory` at `depth: deep`,
`dispatch_inbox` with many entries, `kb_search` result sets — that consume
significant context budget before the agent can decide whether to compress
them. The Headroom MCP tools (`headroom_compress`, `headroom_retrieve`)
operate post-hoc: by the time the agent calls them, the original output is
already in the context window.

This plugin moves compression to the runtime layer via the `tool.execute.after`
hook, intercepting Nexus MCP outputs **before** they enter the agent context:

```
MCP tool executes → result returned → tool.execute.after fires
  → plugin evaluates policy → if threshold exceeded: store original,
    replace output with compact summary → compact result enters context
```

Compression is **policy-based and per-tool**: each Nexus MCP tool has an
explicit action (`compress`, `passthrough`, `skip`) with a configurable token
threshold and compression profile. Originals are retrievable via the plugin's
own `nexus_headroom_intercept_retrieve` tool (in-memory + disk cache, 24h TTL).

**Default mode:** `observe` (metrics only, no mutation — safe for all
environments)  
**Transform mode:** requires `HEADROOM_MODE=transform` (experimental — see
plugin README for verification status)

---

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
automatically based on your project configuration — no manual copy needed.

## Requirements

- [OpenCode](https://opencode.ai) `v1.14+` with plugin support
- Nexus platform account with MCP access configured
- `NEXUS_API_URL` and `NEXUS_PRIVATE_TOKEN` environment variables
- `HELICONE_API_KEY` for `nexus-cost-control` (v1.0.0 only)

## License

MIT — see [LICENSE](./LICENSE)
