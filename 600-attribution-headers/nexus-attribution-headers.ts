import { type Plugin } from "@opencode-ai/plugin"

/**
 * Plugin metadata — single source of truth for name/version.
 */
const PLUGIN_META = {
  name: "nexus-attribution-headers",
  version: "1.0.0",
  description:
    "Injects x-nexus-session-id/actor-slug/primary-slot attribution headers on outgoing requests to the Nexus gateway provider, so gateway-side model_usage_events can attribute usage to a session and actor.",
} as const

/** The only provider id this plugin ever acts on. */
const NEXUS_PROVIDER_ID = "nexus"

/** Agent names that map to a primary_slot rather than a raw actor_slug. */
const PRIMARY_SLOT_AGENTS = new Set(["plan", "act", "review"])
const PRIMARY_AGENT_PREFIX = "nexus-"

// ---------------------------------------------------------------------------
// Runtime provider shape
// ---------------------------------------------------------------------------

/**
 * The shape `input.provider` actually has at runtime for `chat.headers`.
 *
 * IMPORTANT: this does NOT match the `ProviderContext` type
 * (`{ source, info, options }`) declared for this hook in
 * `@opencode-ai/plugin`. At runtime `input.provider` is the flat `Provider`
 * object directly (`{ id, source, name, env, options, models }`). Verified
 * empirically against `@opencode-ai/plugin`/`@opencode-ai/sdk` 1.17.18,
 * OpenCode 1.18.27 — see dispatch `5999b7d6-8b1f-4b1a-8101-ce7f5d6695df`
 * (NEXUS-APP). Using the documented `.info.id` path here would make the
 * provider guard silently never match.
 */
type RuntimeProvider = {
  id?: string
}

/**
 * Compute the attribution headers for a given agent name, or an empty
 * object if the agent name cannot be attributed at all.
 *
 * - `nexus-plan` / `nexus-act` / `nexus-review` -> `x-nexus-primary-slot`
 *   (prefix stripped: `plan` / `act` / `review`)
 * - any other non-empty agent name -> `x-nexus-actor-slug` (verbatim,
 *   including internal OpenCode calls like `title`, which are real billed
 *   requests and should be attributed rather than silently uncounted)
 */
export function computeAttributionHeaders(agent: string | undefined | null): Record<string, string> {
  if (!agent) return {}

  if (agent.startsWith(PRIMARY_AGENT_PREFIX)) {
    const slot = agent.slice(PRIMARY_AGENT_PREFIX.length)
    if (PRIMARY_SLOT_AGENTS.has(slot)) {
      return { "x-nexus-primary-slot": slot }
    }
  }

  return { "x-nexus-actor-slug": agent }
}

// ---------------------------------------------------------------------------
// Plugin implementation
// ---------------------------------------------------------------------------

/**
 * Nexus Attribution Headers
 *
 * Sets `x-nexus-session-id`, and one of `x-nexus-primary-slot` /
 * `x-nexus-actor-slug`, on outgoing requests routed through the Nexus
 * gateway provider, so gateway-side `model_usage_events` /
 * `route_decision_events` can attribute usage to a session and actor.
 *
 * These headers are attribution-only. They are never used for routing or
 * auth on the gateway side (see dispatch `16973ead`, 2026-09-04, which
 * specified the gateway side of this contract).
 *
 * Scoped strictly to `provider.id === "nexus"` — never touches requests to
 * any other configured provider (Anthropic, OpenAI, GitHub Copilot, etc).
 *
 * Stateless: no caching, no config, no MCP dependency. Every call is
 * evaluated independently from `input` alone.
 *
 * Never blocks or breaks a request: any missing or malformed input simply
 * results in no headers being set, never an error.
 */
export const NexusAttributionHeaders: Plugin = async () => {
  return {
    "chat.headers": async (input, output) => {
      const provider = input.provider as unknown as RuntimeProvider
      if (!provider || provider.id !== NEXUS_PROVIDER_ID) return
      if (!input.sessionID) return

      output.headers["x-nexus-session-id"] = input.sessionID

      const attribution = computeAttributionHeaders(input.agent)
      for (const [key, value] of Object.entries(attribution)) {
        output.headers[key] = value
      }
    },
  }
}
