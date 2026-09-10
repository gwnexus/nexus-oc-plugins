# nexus-attribution-headers

An [OpenCode](https://opencode.ai) plugin that injects attribution headers
on outgoing requests to the Nexus gateway provider, for the
[Nexus](https://nexus.gatewarden.eu) platform.

**Current version:** `v1.0.0`
**Requires:** none beyond the standard plugin context (no Nexus MCP session
required)
**Ref:** dispatch `5999b7d6-8b1f-4b1a-8101-ce7f5d6695df` (NEXUS-APP)

## What it does

The Nexus gateway records `model_usage_events` / `route_decision_events` for
cost and routing analytics, but two dimensions of attribution -- which
session and which actor a request belongs to -- were entirely missing
(null on 100% of gateway rows), because nothing on the OpenCode side ever
emitted the headers the gateway was built to read.

This plugin closes that gap using the `chat.headers` hook, which fires
immediately before a chat completion request is sent and can inject
headers directly into that outgoing request:

| Header | Value |
|---|---|
| `x-nexus-session-id` | `input.sessionID`, always, when the guard below passes |
| `x-nexus-primary-slot` | `plan` / `act` / `review`, when `input.agent` is `nexus-plan` / `nexus-act` / `nexus-review` |
| `x-nexus-actor-slug` | `input.agent` verbatim, for every other agent name (sub-actor invocations, and OpenCode's own internal calls like `title`) |

These headers are **attribution-only**. They are never used for routing or
authentication on the gateway side (see dispatch `16973ead`, 2026-09-04,
which specified the gateway side of this contract).

## Scoping: nexus provider only

The plugin only ever acts when `input.provider.id === "nexus"`. Every other
configured provider (Anthropic, OpenAI, GitHub Copilot, a project's own
direct provider config, etc) is left completely untouched.

### A real discrepancy worth knowing about

The `chat.headers` hook's TypeScript signature (in `@opencode-ai/plugin`)
declares `input.provider` as a `ProviderContext`:

```ts
type ProviderContext = {
  source: "env" | "config" | "custom" | "api"
  info: Provider
  options: Record<string, any>
}
```

**At runtime this is wrong.** `input.provider` is actually the flat
`Provider` object directly (`{ id, source, name, env, options, models }`),
not wrapped in `.info`. Verified empirically against
`@opencode-ai/plugin`/`@opencode-ai/sdk` 1.17.18, OpenCode 1.18.27, by
capturing real outgoing requests from a throwaway plugin. Guarding on
`input.provider.info.id` -- the documented path -- would silently never
match, and the scoping check would fail open or closed depending on how it
was written.

This plugin guards on the runtime-correct `input.provider.id` and
documents the discrepancy in code, so a future upgrade of
`@opencode-ai/plugin` that fixes the type doesn't accidentally look like a
regression here.

## Agent-to-header mapping

`input.agent` is compared directly, no lookup table, no config:

- `nexus-plan`, `nexus-act`, `nexus-review` (the `nexus-` prefix stripped)
  → `x-nexus-primary-slot`
- anything else, including OpenCode's own internal calls (e.g. `title` for
  session-title generation) → `x-nexus-actor-slug` verbatim

Internal calls landing in `x-nexus-actor-slug` is intentional: they are
real, billed model calls and should be attributed to something rather than
silently uncounted.

## Hard constraints

- **Never blocks or breaks a request.** Any missing or malformed input
  (no provider, no `sessionID`, no `agent`) simply results in no headers
  being set -- never an error, never a thrown exception.
- **Stateless.** No caching, no config, no MCP dependency. Every call is
  evaluated independently from the hook's `input` alone.
- **Provider-scoped.** Never touches a request to any provider other than
  `nexus`.

## Hooks

- **`chat.headers`** -- the only hook this plugin implements.

## Installation

Copy into your project's OpenCode plugins directory:

```bash
cp nexus-attribution-headers.ts /path/to/your-project/.opencode/plugins/
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
npm test -- 600-attribution-headers
```

18 unit tests covering the pure header-mapping function (`nexus-plan` /
`nexus-act` / `nexus-review` → `primary_slot`, sub-actors and OpenCode's
internal `title` call → `actor_slug`, empty/missing agent names), and the
plugin's `chat.headers` hook (correct headers on the nexus provider,
no-op on any other provider, no-op when `provider.id` or `sessionID` is
missing, pre-existing headers on `output` are preserved, never throws on a
malformed/empty input).

## License

Apache-2.0 — Copyright 2025-2026 RELICFROG Holding UG, contributed by Patrick Paechatz. See [LICENSE](../LICENSE).
