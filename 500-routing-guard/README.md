# nexus-routing-guard

An [OpenCode](https://opencode.ai) plugin that detects model routing divergence
between Nexus-configured agents and the effective merged provider/model
catalog of the running OpenCode instance, for the
[Nexus](https://nexus.gatewarden.eu) platform.

**Current version:** `v1.0.0`
**Requires:** none beyond `PluginInput.client` (no Nexus MCP session required)
**Ref:** ADR-0001, dispatch `46bc744a-17c6-4aa1-9d8f-7d6f5ad881a4` (NEXUS-APP)

## What it does

Nexus writes agent-to-provider/model routing into a project's
`opencode.json` (e.g. `nexus-plan -> github-copilot/claude-sonnet-5`). That
routing can silently diverge from what the running OpenCode instance can
actually serve, because the instance's merged provider catalog (global
`~/.config/opencode/` plus project config) is knowledge only the running
process has.

This plugin closes that gap by comparing, once per session, the effective
agent routing against the effective provider catalog, both read directly
from the running server via `PluginInput.client` — no config file parsing,
no re-derivation of merge order.

Two divergence classes are detected:

| Code | Meaning |
|---|---|
| `unknown_provider` | The agent's configured provider is not in the instance's merged catalog at all. |
| `unknown_model` | The provider is present and healthy, but the specific model id is not in that provider's model set. |

`unknown_model` is the bug class that motivated this plugin: a provider can
be entirely valid while a single model id is wrong (e.g. a hyphen where the
provider expects a dot). Provider-level checks alone are blind to it.

Agents without an explicit `model` (inheriting the instance default) are
never checked — they are valid by construction.

## Why not a simple session-start warning

OpenCode's plugin `Hooks` interface has no toast, banner, or notification
primitive, and there is no `session.start` hook. This plugin approximates a
session-start warning with three combined mechanisms:

1. **`client.app.log()`** — always logged, for the audit trail. The
   operator will not see this in the TUI.
2. **`experimental.chat.system.transform`** — reliably delivers the warning
   into the agent's context and instructs it to relay the message to the
   operator verbatim. Delivery is guaranteed; whether and how the agent
   relays it is at the model's discretion. In practice this is
   "nearly always", not "always" — stated here plainly rather than glossed
   over.
3. **One-shot tool-output banner** — a deterministic, fixed-text string
   injected into the first tool call's output of the session. This is the
   same injection mechanism `nexus-session-guard` uses for its reminders.
   It cannot be rephrased or dropped by the model, at the cost of firing on
   the first tool call rather than literally at session start.

Mechanism 3 is the deterministic backstop for mechanism 2. See ADR-0001 for
the full reasoning and trade-offs.

## Hard constraints

- **Silent when clean.** No confirmation banner, no "routing OK" message,
  ever. Seeing a routing-guard banner should always mean something is
  actually broken.
- **One-shot per session.** The banner fires at most once per session,
  regardless of how many tool calls follow.
- **Never blocks or slows session start.** Any failure to reach
  `client.config.providers()` or `client.app.agents()` is caught, logged,
  and treated as "no warning" — never surfaced, never fatal.
- **Not a startup snapshot.** The check runs once per session (on the first
  tool call), not once per instance lifetime, so a provider fixed or added
  mid-instance is picked up by the next session without an OpenCode
  restart.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `NEXUS_ROUTING_GUARD_ENABLED` | `true` | Set to `"false"` to disable the check entirely. No API calls are made when disabled. |

## Hooks

- **`experimental.chat.system.transform`** — best-effort reliable delivery
  to the agent.
- **`tool.execute.after`** — one-shot deterministic banner injection.

## Installation

Copy into your project's OpenCode plugins directory:

```bash
cp nexus-routing-guard.ts /path/to/your-project/.opencode/plugins/
```

Ensure `.opencode/package.json` includes the plugin SDK:

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "^1.14.0"
  }
}
```

## Testing

```bash
npm test -- 500-routing-guard
```

16 unit tests covering the pure divergence-detection function (clean config,
unknown provider, unknown model, agents without an explicit model, multiple
divergent agents), plugin behavior (silent-when-clean, one-shot banner,
banner suppression on subsequent calls, MCP content-array output shape,
system-prompt injection), and failure modes (provider/agent API errors
degrade silently, env var opt-out skips all API calls).

## Logs

Debug logs are written to `.nexus/routing-guard.log`.

## Architecture Decision

See ADR-0001: Routing guard surfacing mechanism (system prompt plus one-shot
tool-output banner).

## License

Apache-2.0 — Copyright 2025-2026 RELICFROG Holding UG, contributed by Patrick Paechatz. See [LICENSE](../LICENSE).
