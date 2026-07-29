import { type Plugin, tool } from "@opencode-ai/plugin"
import { readFileSync, appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

/**
 * Plugin metadata — single source of truth for name/version.
 */
const PLUGIN_META = {
  name: "nexus-cost-control",
  version: "1.0.1",
  description:
    "Token usage and cost tracking for Nexus sessions via Helicone. " +
    "Wraps Helicone's LLM observability API to surface per-session token " +
    "counts and estimated cost directly in the Nexus session timeline.",
} as const

/**
 * Nexus Cost Control
 *
 * This plugin is a thin Nexus-aware wrapper around Helicone
 * (https://helicone.ai), an LLM observability proxy. Helicone sits between
 * your agent and the LLM provider and records every request: token counts
 * (input / output / cache), latency, model, and estimated cost in USD.
 *
 * What this plugin adds on top of raw Helicone:
 *   1. Injects the active Nexus session ID as a Helicone session property so
 *      every LLM call in a Nexus session is grouped and queryable together.
 *   2. On `session.idle` (agent goes quiet), queries the Helicone API for the
 *      cumulative token and cost data for that Nexus session, then appends a
 *      structured cost summary to the Nexus session timeline via the MCP API.
 *   3. Exposes a `nexus_cost_summary` tool so the agent can pull a live cost
 *      snapshot on demand during any session.
 *
 * Prerequisites:
 *   - A Helicone account and API key (https://helicone.ai)
 *   - Your LLM provider requests routed through the Helicone gateway
 *     (see README for provider-specific proxy URLs)
 *   - HELICONE_API_KEY set in your environment
 *   - The Nexus MCP server configured (NEXUS_API_URL + NEXUS_PRIVATE_TOKEN)
 *
 * How Helicone session grouping works:
 *   Helicone groups requests into "sessions" via a custom request header:
 *     Helicone-Session-Id: <nexus-session-id>
 *   For OpenCode, this header injection is done at the provider level via
 *   OpenCode's `Helicone-Session-Id` custom header support. See README for
 *   opencode.json configuration examples.
 *
 * This plugin does NOT replace or require the standalone
 * `opencode-helicone-session` community plugin — it focuses exclusively on
 * the Nexus integration layer (cost recording + on-demand queries).
 */

// ── File-based logger ────────────────────────────────────────────────────────

let _logDir: string | null = null

function fileLog(directory: string, level: string, message: string): void {
  try {
    if (!_logDir) {
      _logDir = join(directory, ".nexus")
      mkdirSync(_logDir, { recursive: true })
    }
    const ts = new Date().toISOString()
    const line = `[${ts}] [${level.toUpperCase().padEnd(5)}] ${message}\n`
    appendFileSync(join(_logDir, "cost-control.log"), line)
  } catch {
    // Silently ignore file write errors
  }
}

// ── Config types ──────────────────────────────────────────────────────────────

interface NexusConfig {
  apiUrl: string
  token: string
}

interface HeliconeConfig {
  apiKey: string
}

// ── Config readers ────────────────────────────────────────────────────────────

/**
 * Read Nexus credentials from env or ~/.config/nexus/{config,credentials}.toml
 */
function getNexusConfig(directory: string): NexusConfig | null {
  const apiUrl = process.env.NEXUS_API_URL
  const token = process.env.NEXUS_PRIVATE_TOKEN
  if (apiUrl && token) return { apiUrl, token }

  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
    const nexusConfigDir = join(home, ".config", "nexus")

    let resolvedApiUrl: string | undefined
    try {
      const raw = readFileSync(join(nexusConfigDir, "config.toml"), "utf-8")
      const m = raw.match(/^\s*api_url\s*=\s*"([^"]+)"/m)
      if (m) resolvedApiUrl = m[1]
    } catch { /* not found */ }

    let resolvedToken: string | undefined
    try {
      const raw = readFileSync(join(nexusConfigDir, "credentials.toml"), "utf-8")
      const m = raw.match(/^\s*token\s*=\s*"([^"]+)"/m)
      if (m) resolvedToken = m[1]
    } catch { /* not found */ }

    if (resolvedApiUrl && resolvedToken) {
      return { apiUrl: resolvedApiUrl, token: resolvedToken }
    }
  } catch { /* ~/.config/nexus not accessible */ }

  return null
}

/**
 * Read Helicone API key from HELICONE_API_KEY env var.
 * The key can also be set in ~/.config/nexus/config.toml as:
 *   helicone_api_key = "sk-helicone-..."
 */
function getHeliconeConfig(directory: string): HeliconeConfig | null {
  const apiKey = process.env.HELICONE_API_KEY
  if (apiKey) return { apiKey }

  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
    const configPath = join(home, ".config", "nexus", "config.toml")
    const raw = readFileSync(configPath, "utf-8")
    const m = raw.match(/^\s*helicone_api_key\s*=\s*"([^"]+)"/m)
    if (m) return { apiKey: m[1] }
  } catch { /* not found */ }

  return null
}

// ── Nexus state extraction ────────────────────────────────────────────────────

interface NexusState {
  sessionId?: string
  projectId?: string
  agentId?: string
}

interface ToolPartShape {
  type: string
  tool?: string
  state?: { status?: string; input?: Record<string, unknown>; output?: string }
  toolName?: string
  args?: Record<string, unknown>
  result?: unknown
}

function tryParseJson(str: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(str)
    return typeof parsed === "object" && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

function extractNexusState(
  messages: Array<{ info: { role: string }; parts: Array<Record<string, unknown>> }>,
  directory: string,
): NexusState {
  const state: NexusState = {}

  for (const msg of messages) {
    for (const rawPart of msg.parts ?? []) {
      const part = rawPart as unknown as ToolPartShape
      if (part.type !== "tool" && part.type !== "tool-invocation") continue

      const toolName = (part.tool ?? part.toolName ?? "") as string
      if (!toolName) continue

      const args = (part.state?.input ?? part.args ?? {}) as Record<string, unknown>

      let result: Record<string, unknown> | null = null
      if (part.state?.output) {
        result = tryParseJson(part.state.output)
      } else if (part.result && typeof part.result === "object") {
        result = part.result as Record<string, unknown>
      }

      if (toolName === "nexus_session_create") {
        if (args.project_id) state.projectId = String(args.project_id)
        if (args.agent_id) state.agentId = String(args.agent_id)
        if (result?.id) state.sessionId = String(result.id)
        if (result?.session_id) state.sessionId = String(result.session_id)
      }
      if (toolName === "nexus_session_append" && args.session_id) {
        state.sessionId = String(args.session_id)
      }
      if (toolName.startsWith("nexus_") && args.project_id && !state.projectId) {
        state.projectId = String(args.project_id)
      }
      if (toolName !== "nexus_session_create" && result) {
        if (result.session_id) state.sessionId = String(result.session_id)
      }
    }
  }

  fileLog(directory, "info", `extractNexusState: ${JSON.stringify(state)}`)
  return state
}

// ── Helicone API client ───────────────────────────────────────────────────────

/**
 * Cost data aggregated from Helicone for a given Nexus session.
 */
export interface HeliconeSessionCost {
  nexusSessionId: string
  totalRequests: number
  tokensInput: number
  tokensOutput: number
  tokensCacheRead: number
  tokensCacheWrite: number
  totalTokens: number
  costUsd: number
  models: string[]
  queriedAt: string
}

/**
 * Query the Helicone API for aggregated usage data for a specific Nexus
 * session. Helicone groups requests by session via the `Helicone-Session-Id`
 * header that agents inject on each request.
 *
 * API reference: https://docs.helicone.ai/rest/request/post-v1requestquery
 */
async function queryHeliconeSession(
  heliconeConfig: HeliconeConfig,
  nexusSessionId: string,
  directory: string,
): Promise<HeliconeSessionCost | null> {
  const url = "https://api.helicone.ai/v1/request/query"

  const payload = {
    filter: {
      request: {
        properties: {
          "Helicone-Session-Id": {
            equals: nexusSessionId,
          },
        },
      },
    },
    limit: 1000,
    offset: 0,
    sort: { created_at: "desc" },
  }

  fileLog(directory, "info", `Querying Helicone for session ${nexusSessionId}`)

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${heliconeConfig.apiKey}`,
      },
      body: JSON.stringify(payload),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      fileLog(directory, "error", `Helicone API ${res.status}: ${body}`)
      return null
    }

    const data = await res.json() as {
      data?: Array<{
        request?: {
          model?: string
          prompt_tokens?: number
          completion_tokens?: number
          prompt_cache_read_tokens?: number
          prompt_cache_write_tokens?: number
          helicone_cost?: number
        }
      }>
    }

    const requests = data.data ?? []
    fileLog(directory, "info", `Helicone returned ${requests.length} requests for session`)

    if (requests.length === 0) return null

    let tokensInput = 0
    let tokensOutput = 0
    let tokensCacheRead = 0
    let tokensCacheWrite = 0
    let costUsd = 0
    const modelsSet = new Set<string>()

    for (const req of requests) {
      const r = req.request
      if (!r) continue
      tokensInput += r.prompt_tokens ?? 0
      tokensOutput += r.completion_tokens ?? 0
      tokensCacheRead += r.prompt_cache_read_tokens ?? 0
      tokensCacheWrite += r.prompt_cache_write_tokens ?? 0
      costUsd += r.helicone_cost ?? 0
      if (r.model) modelsSet.add(r.model)
    }

    return {
      nexusSessionId,
      totalRequests: requests.length,
      tokensInput,
      tokensOutput,
      tokensCacheRead,
      tokensCacheWrite,
      totalTokens: tokensInput + tokensOutput,
      costUsd: Math.round(costUsd * 1_000_000) / 1_000_000, // 6 decimal places
      models: Array.from(modelsSet),
      queriedAt: new Date().toISOString(),
    }
  } catch (err) {
    fileLog(directory, "error", `Helicone query failed: ${err}`)
    return null
  }
}

// ── Nexus session append ──────────────────────────────────────────────────────

/**
 * Format a HeliconeSessionCost as a human-readable Nexus session entry.
 */
function formatCostSummary(cost: HeliconeSessionCost): string {
  const time = new Date().toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
  })

  const lines = [
    `## Token & Cost Summary — ${time}`,
    ``,
    `Tracked via [Helicone](https://helicone.ai) · nexus-cost-control v${PLUGIN_META.version}`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Requests | ${cost.totalRequests} |`,
    `| Input tokens | ${cost.tokensInput.toLocaleString()} |`,
    `| Output tokens | ${cost.tokensOutput.toLocaleString()} |`,
    `| Cache read tokens | ${cost.tokensCacheRead.toLocaleString()} |`,
    `| Cache write tokens | ${cost.tokensCacheWrite.toLocaleString()} |`,
    `| **Total tokens** | **${cost.totalTokens.toLocaleString()}** |`,
    `| **Estimated cost** | **$${cost.costUsd.toFixed(6)}** |`,
  ]

  if (cost.models.length > 0) {
    lines.push(`| Models | ${cost.models.join(", ")} |`)
  }

  return lines.join("\n")
}

async function appendCostEntry(
  nexusConfig: NexusConfig,
  sessionId: string,
  cost: HeliconeSessionCost,
  directory: string,
): Promise<void> {
  const url = `${nexusConfig.apiUrl}/api/mcp/sessions`
  const summary = formatCostSummary(cost)

  const payload = {
    action: "session_append",
    session_id: sessionId,
    entry_type: "cost_snapshot",
    summary,
    metadata: JSON.stringify({
      plugin: PLUGIN_META.name,
      plugin_version: PLUGIN_META.version,
      tokens_input: cost.tokensInput,
      tokens_output: cost.tokensOutput,
      tokens_cache_read: cost.tokensCacheRead,
      tokens_cache_write: cost.tokensCacheWrite,
      total_tokens: cost.totalTokens,
      cost_usd: cost.costUsd,
      total_requests: cost.totalRequests,
      models: cost.models,
      helicone_session_id: cost.nexusSessionId,
    }),
  }

  fileLog(directory, "info", `Appending cost entry to Nexus session ${sessionId}`)

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${nexusConfig.token}`,
    },
    body: JSON.stringify(payload),
  })

  const body = await res.text().catch(() => "")
  fileLog(directory, "info", `Response ${res.status}: ${body.substring(0, 200)}`)

  if (!res.ok) {
    throw new Error(`Nexus API ${res.status}: ${body}`)
  }
}

// ── Plugin export ─────────────────────────────────────────────────────────────

export const NexusCostControl: Plugin = async (ctx) => {
  const { client, directory } = ctx
  const nexusConfig = getNexusConfig(directory)
  const heliconeConfig = getHeliconeConfig(directory)
  const loadedAt = new Date().toISOString()

  fileLog(directory, "info", "=== nexus-cost-control initializing ===")
  fileLog(directory, "info", `Directory: ${directory}`)
  fileLog(
    directory,
    "info",
    nexusConfig
      ? `Nexus API: ${nexusConfig.apiUrl}`
      : "WARNING: Nexus credentials not found",
  )
  fileLog(
    directory,
    "info",
    heliconeConfig
      ? "Helicone: API key configured"
      : "WARNING: HELICONE_API_KEY not set — cost tracking disabled",
  )

  await client.app.log({
    body: {
      service: PLUGIN_META.name,
      level: "info",
      message: `Plugin loaded — Nexus: ${nexusConfig ? nexusConfig.apiUrl : "NOT CONFIGURED"} | Helicone: ${heliconeConfig ? "configured" : "NOT CONFIGURED"}`,
    },
  })

  /**
   * Idle debounce: we only want to record a cost entry once per "work burst",
   * not on every idle event. We track the last append time and only write to
   * Nexus if at least IDLE_DEBOUNCE_MS have passed since the last one.
   */
const IDLE_DEBOUNCE_MS = 5 * 60 * 1000 // 5 minutes
let lastAppendAt: number | null = null
let lastAppendedTokens: number | null = null

  return {
    /**
     * On-demand cost summary tool — callable by the agent at any time.
     * Returns a formatted markdown table of token usage + cost for the
     * current Nexus session, pulled live from the Helicone API.
     */
    tool: {
      nexus_cost_summary: tool({
        description:
          "Show token usage and estimated cost for the current Nexus session, " +
          "queried live from Helicone. Returns input/output/cache token counts " +
          "and estimated cost in USD. Use this to give the user a cost overview " +
          "or before closing a session.",
        args: {},
        async execute() {
          if (!heliconeConfig) {
            return "Cost tracking is not configured. Set HELICONE_API_KEY to enable Helicone integration."
          }

          // Fetch messages to find the active Nexus session
          let nexusSessionId: string | undefined
          try {
            const sessions = await client.session.list({})
            const activeSessions = sessions.data ?? []
            // Use the most recently active session
            if (activeSessions.length > 0) {
              const latestSession = activeSessions[0]
              const msgs = await client.session.messages({ path: { id: (latestSession as { id: string }).id } })
              const state = extractNexusState(
                (msgs.data ?? []) as Array<{ info: { role: string }; parts: Array<Record<string, unknown>> }>,
                directory,
              )
              nexusSessionId = state.sessionId
            }
          } catch (err) {
            fileLog(directory, "error", `Failed to fetch session for tool: ${err}`)
          }

          if (!nexusSessionId) {
            return "No active Nexus session found. Start a session with nexus_session_create first."
          }

          const cost = await queryHeliconeSession(heliconeConfig, nexusSessionId, directory)
          if (!cost) {
            return `No Helicone data found for session \`${nexusSessionId}\`. Make sure requests are routed through the Helicone proxy and that the Helicone-Session-Id header is set to the Nexus session ID.`
          }

          return formatCostSummary(cost)
        },
      }),

      nexus_show_plugins: tool({
        description: "Show all loaded Nexus plugins, their versions, and connection status",
        args: {},
        async execute() {
          const nexusStatus = nexusConfig
            ? `connected (${nexusConfig.apiUrl})`
            : "disconnected — credentials missing"
          const heliconeStatus = heliconeConfig
            ? "connected — API key set"
            : "disconnected — HELICONE_API_KEY not set"

          return [
            `## Nexus Plugins`,
            ``,
            `| Plugin | Version | Status | Loaded |`,
            `|--------|---------|--------|--------|`,
            `| ${PLUGIN_META.name} | ${PLUGIN_META.version} | Nexus: ${nexusStatus} · Helicone: ${heliconeStatus} | ${loadedAt} |`,
            ``,
            `**Description:** ${PLUGIN_META.description}`,
            ``,
            `### Hooks registered`,
            `- \`event (session.idle)\` — queries Helicone and records cost entry in active Nexus session (debounced: 5 min)`,
            ``,
            `### Tools registered`,
            `- \`nexus_cost_summary\` — on-demand live cost snapshot from Helicone`,
            `- \`nexus_show_plugins\` — this overview`,
          ].join("\n")
        },
      }),
    },

    /**
     * On every event, watch for `session.idle` — this fires when the agent
     * has finished a work burst and is waiting for input. A good moment to
     * record a cost snapshot without spamming the timeline.
     */
    event: async ({ event }) => {
      const eventType = event.type as string

      if (eventType !== "session.idle") return
      if (!heliconeConfig || !nexusConfig) return

      // Debounce: skip if we appended recently
      if (lastAppendAt && Date.now() - lastAppendAt < IDLE_DEBOUNCE_MS) {
        fileLog(directory, "debug", `session.idle — skipping (last append ${Date.now() - lastAppendAt}ms ago)`)
        return
      }

      const sessionID = (
        event as unknown as { properties: { sessionID: string } }
      ).properties?.sessionID

      if (!sessionID) {
        fileLog(directory, "warn", "session.idle — no sessionID in event")
        return
      }

      fileLog(directory, "info", `session.idle fired — sessionID=${sessionID}`)

      try {
        const { data } = await client.session.messages({ path: { id: sessionID } })
        if (!data) return

        const messages = data as Array<{
          info: { role: string }
          parts: Array<Record<string, unknown>>
        }>

        const state = extractNexusState(messages, directory)

        if (!state.sessionId) {
          fileLog(directory, "info", "No Nexus session ID found — skipping cost recording")
          return
        }

        const cost = await queryHeliconeSession(heliconeConfig, state.sessionId, directory)
        if (!cost) {
          fileLog(directory, "info", `No Helicone data for session ${state.sessionId} — skipping`)
          return
        }

        // Delta check: skip if token count hasn't changed since last snapshot
        if (lastAppendedTokens !== null && cost.totalTokens === lastAppendedTokens) {
          fileLog(directory, "debug", `session.idle — skipping (no token delta, still ${cost.totalTokens})`)
          return
        }

        await appendCostEntry(nexusConfig, state.sessionId, cost, directory)

        lastAppendAt = Date.now()
        lastAppendedTokens = cost.totalTokens

        fileLog(directory, "info", `Cost entry recorded — $${cost.costUsd.toFixed(6)} / ${cost.totalTokens} tokens`)
        await client.app.log({
          body: {
            service: PLUGIN_META.name,
            level: "info",
            message: `Cost snapshot recorded in Nexus session ${state.sessionId}: $${cost.costUsd.toFixed(6)} / ${cost.totalTokens} tokens`,
          },
        })
      } catch (err) {
        fileLog(directory, "error", `session.idle handler failed: ${err}`)
        await client.app.log({
          body: {
            service: PLUGIN_META.name,
            level: "error",
            message: `Failed to record cost entry: ${err}`,
          },
        })
      }
    },
  }
}
