import { type Plugin, tool } from "@opencode-ai/plugin"
import { readFileSync, appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

/**
 * Plugin metadata — single source of truth for name/version.
 */
const PLUGIN_META = {
  name: "nexus-compaction-plus",
  version: "1.8.1",
  description:
    "Preserves Nexus session context across compaction and records compaction events in the active session.",
} as const

/**
 * Nexus Compaction Plus
 *
 * Preserves Nexus session context across OpenCode compaction events and
 * records each compaction as an auditable entry in the active Nexus session.
 *
 * Reads NEXUS_API_URL and NEXUS_PRIVATE_TOKEN from the MCP server config
 * in opencode.json to call the Nexus API directly.
 */

/**
 * File-based logger for debugging plugin behavior.
 * Writes to .nexus/compaction-plus.log in the project directory.
 */
let _logDir: string | null = null

function fileLog(directory: string, level: string, message: string): void {
  try {
    if (!_logDir) {
      _logDir = join(directory, ".nexus")
      mkdirSync(_logDir, { recursive: true })
    }
    const ts = new Date().toISOString()
    const line = `[${ts}] [${level.toUpperCase().padEnd(5)}] ${message}\n`
    appendFileSync(join(_logDir, "compaction-plus.log"), line)
  } catch {
    // Silently ignore file write errors
  }
}

interface NexusState {
  sessionId?: string
  sessionTitle?: string
  projectId?: string
  agentId?: string
}

interface NexusConfig {
  apiUrl: string
  token: string
}

/**
 * Read Nexus credentials from:
 *   1. Environment variables (NEXUS_API_URL + NEXUS_PRIVATE_TOKEN)
 *   2. Nexus CLI config (~/.config/nexus/config.toml + credentials.toml)
 *   3. Project-local .nexus/config.toml + ~/.config/nexus/credentials.toml
 */
function getNexusConfig(directory: string): NexusConfig | null {
  // 1. Try environment variables
  const apiUrl = process.env.NEXUS_API_URL
  const token = process.env.NEXUS_PRIVATE_TOKEN
  if (apiUrl && token) return { apiUrl, token }

  // 2. Read from Nexus CLI config (~/.config/nexus/)
  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
    const nexusConfigDir = join(home, ".config", "nexus")

    // Read api_url from config.toml
    let resolvedApiUrl: string | undefined
    try {
      const configRaw = readFileSync(join(nexusConfigDir, "config.toml"), "utf-8")
      const apiMatch = configRaw.match(/^\s*api_url\s*=\s*"([^"]+)"/m)
      if (apiMatch) resolvedApiUrl = apiMatch[1]
    } catch {
      // config.toml not found
    }

    // Read token from credentials.toml
    let resolvedToken: string | undefined
    try {
      const credsRaw = readFileSync(join(nexusConfigDir, "credentials.toml"), "utf-8")
      const tokenMatch = credsRaw.match(/^\s*token\s*=\s*"([^"]+)"/m)
      if (tokenMatch) resolvedToken = tokenMatch[1]
    } catch {
      // credentials.toml not found
    }

    if (resolvedApiUrl && resolvedToken) {
      return { apiUrl: resolvedApiUrl, token: resolvedToken }
    }
  } catch {
    // ~/.config/nexus not accessible
  }

  return null
}

/**
 * Safely parse a JSON string, returning null on failure.
 */
function tryParseJson(str: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(str)
    return typeof parsed === "object" && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

/**
 * OpenCode SDK message/part types (from @opencode-ai/sdk types.gen.d.ts):
 *
 *   ToolPart = { type: "tool", tool: string, state: ToolState, ... }
 *   ToolState = { status: string, input: Record<string,unknown>, output?: string, ... }
 *
 * - `part.tool`       = tool name (e.g. "nexus_session_create")
 * - `part.state.input` = tool arguments
 * - `part.state.output` = JSON string of the tool result (only when status=completed)
 */
interface ToolPartShape {
  type: string
  tool?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
    output?: string
  }
  // Legacy/fallback fields (Vercel AI SDK shape)
  toolName?: string
  args?: Record<string, unknown>
  result?: unknown
}

/**
 * Extract Nexus session/project state from OpenCode session messages.
 * Messages come from client.session.messages() and contain tool call parts.
 */
function extractNexusState(
  messages: Array<{ info: { role: string }; parts: Array<Record<string, unknown>> }>,
  directory?: string,
): NexusState {
  const state: NexusState = {}
  const dir = directory ?? ""

  for (const msg of messages) {
    for (const rawPart of msg.parts ?? []) {
      const part = rawPart as unknown as ToolPartShape

      // Support both OpenCode SDK shape (type="tool") and legacy shape (type="tool-invocation")
      if (part.type !== "tool" && part.type !== "tool-invocation") continue

      const toolName = (part.tool ?? part.toolName ?? "") as string
      if (!toolName) continue

      // Extract input args: OpenCode SDK uses state.input, legacy uses args
      const args = (part.state?.input ?? part.args ?? {}) as Record<string, unknown>

      // Extract output: OpenCode SDK uses state.output (JSON string), legacy uses result (object)
      let result: Record<string, unknown> | null = null
      if (part.state?.output) {
        result = tryParseJson(part.state.output)
      } else if (part.result && typeof part.result === "object") {
        result = part.result as Record<string, unknown>
      }

      if (toolName === "nexus_session_create") {
        if (args.project_id) state.projectId = String(args.project_id)
        if (args.agent_id) state.agentId = String(args.agent_id)

        if (result) {
          fileLog(dir, "debug", `nexus_session_create result keys: ${JSON.stringify(Object.keys(result))}`)
          if (result.id) {
            state.sessionId = String(result.id)
            fileLog(dir, "info", `Captured session ID from session_create result.id: ${state.sessionId}`)
          }
          if (result.session_id) {
            state.sessionId = String(result.session_id)
            fileLog(dir, "info", `Captured session ID from session_create result.session_id: ${state.sessionId}`)
          }
          if (result.title) state.sessionTitle = String(result.title)
        }
      }

      if (toolName === "nexus_session_append" && args.session_id) {
        state.sessionId = String(args.session_id)
        fileLog(dir, "debug", `Captured session ID from session_append args: ${state.sessionId}`)
      }

      // Any nexus_ tool with project_id
      if (toolName.startsWith("nexus_") && args.project_id && !state.projectId) {
        state.projectId = String(args.project_id)
      }

      // Tool results may contain session_id from other calls
      if (toolName !== "nexus_session_create" && result) {
        if (result.session_id) state.sessionId = String(result.session_id)
        if (result.title) state.sessionTitle = String(result.title)
      }
    }
  }

  fileLog(dir, "info", `extractNexusState result: ${JSON.stringify(state)}`)
  return state
}

/**
 * Build context lines for the compaction prompt.
 */
function buildNexusContext(state: NexusState): string {
  const lines: string[] = [
    "## Nexus Platform Session Context",
    "",
    "This conversation is tracked in the Nexus platform. Preserve the following state:",
    "",
  ]

  if (state.sessionId) {
    lines.push(`- **Active Nexus Session**: \`${state.sessionId}\``)
  }
  if (state.sessionTitle) {
    lines.push(`- **Session Title**: ${state.sessionTitle}`)
  }
  if (state.projectId) {
    lines.push(`- **Project ID**: \`${state.projectId}\``)
  }
  if (state.agentId) {
    lines.push(`- **Agent ID**: ${state.agentId}`)
  }

  lines.push("")
  lines.push("When resuming after compaction:")
  lines.push(
    "- Continue using the same Nexus session ID for `nexus_session_append` calls",
  )
  lines.push(
    "- Do NOT create a new session — the existing one is still active",
  )
  lines.push("- Reference the project ID when making MCP tool calls")
  lines.push("- Check the todo list and Nexus task state for pending work")

  return lines.join("\n")
}

/**
 * Append a compaction entry to the Nexus session via REST API.
 */
async function appendCompactionEntry(
  config: NexusConfig,
  sessionId: string,
  summary: string,
  directory: string,
): Promise<void> {
  const url = `${config.apiUrl}/api/mcp/sessions`
  const payload = {
    action: "session_append",
    session_id: sessionId,
    entry_type: "compaction",
    summary,
  }

  fileLog(directory, "info", `POST ${url} — payload: ${JSON.stringify(payload)}`)

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(payload),
  })

  const body = await res.text().catch(() => "")
  fileLog(directory, "info", `Response ${res.status}: ${body}`)

  if (!res.ok) {
    throw new Error(`Nexus API ${res.status}: ${body}`)
  }
}

/**
 * Pending compaction state — set by session.compacted, consumed by message.updated.
 */
interface PendingCompaction {
  openCodeSessionId: string
  timestamp: Date
}

export const NexusCompactionPlus: Plugin = async (ctx) => {
  const { client, directory } = ctx
  const nexusConfig = getNexusConfig(directory)
  const loadedAt = new Date().toISOString()
  let pendingCompaction: PendingCompaction | null = null

  fileLog(directory, "info", "=== Plugin initializing ===")
  fileLog(directory, "info", `Directory: ${directory}`)
  fileLog(directory, "info", nexusConfig
    ? `Nexus API configured: ${nexusConfig.apiUrl}`
    : "WARNING: Nexus credentials not found — post-compaction recording disabled")

  await client.app.log({
    body: {
      service: PLUGIN_META.name,
      level: "info",
      message: nexusConfig
        ? `Plugin loaded — Nexus API: ${nexusConfig.apiUrl}`
        : "Plugin loaded — WARNING: NEXUS_API_URL/NEXUS_PRIVATE_TOKEN not set, post-compaction recording disabled",
    },
  })

  return {
    /**
     * Custom tool: show loaded Nexus plugins and their status.
     */
    tool: {
      nexus_show_plugins: tool({
        description:
          "Show all loaded Nexus plugins, their versions, and connection status",
        args: {},
        async execute() {
          const apiStatus = nexusConfig
            ? `connected (${nexusConfig.apiUrl})`
            : "disconnected — credentials missing"

          return [
            `## Nexus Plugins`,
            ``,
            `| Plugin | Version | API Status | Loaded |`,
            `|--------|---------|------------|--------|`,
            `| ${PLUGIN_META.name} | ${PLUGIN_META.version} | ${apiStatus} | ${loadedAt} |`,
            ``,
            `**Description:** ${PLUGIN_META.description}`,
            ``,
            `### Hooks registered`,
            `- \`experimental.session.compacting\` — injects Nexus session context into compaction prompt`,
            `- \`event (session.compacted)\` — records compaction event in active Nexus session`,
          ].join("\n")
        },
      }),
    },
    /**
     * Pre-compaction: load session messages, extract Nexus state,
     * inject context into the compaction prompt.
     */
    "experimental.session.compacting": async (input, output) => {
      fileLog(directory, "info", `=== session.compacting fired === sessionID=${input.sessionID}`)
      try {
        // Fetch messages from the OpenCode session
        const { data } = await client.session.messages({
          path: { id: input.sessionID },
        })

        if (!data) {
          fileLog(directory, "warn", "Could not fetch session messages — data is null/undefined")
          await client.app.log({
            body: {
              service: PLUGIN_META.name,
              level: "warn",
              message: "Could not fetch session messages",
            },
          })
          return
        }

        const messages = data as Array<{
          info: { role: string }
          parts: Array<Record<string, unknown>>
        }>
        fileLog(directory, "debug", `Fetched ${messages.length} messages from session`)
        const state = extractNexusState(messages, directory)

        if (!state.sessionId && !state.projectId) {
          fileLog(directory, "info", "No Nexus session/project detected — skipping context injection")
          await client.app.log({
            body: {
              service: PLUGIN_META.name,
              level: "info",
              message:
                "No active Nexus session detected — skipping context injection",
            },
          })
          return
        }

        output.context.push(buildNexusContext(state))

        fileLog(directory, "info", `Context injected: session=${state.sessionId ?? "unknown"}, project=${state.projectId ?? "unknown"}`)
        await client.app.log({
          body: {
            service: PLUGIN_META.name,
            level: "info",
            message: `Injected Nexus context: session=${state.sessionId ?? "unknown"}, project=${state.projectId ?? "unknown"}`,
          },
        })
      } catch (err) {
        fileLog(directory, "error", `session.compacting failed: ${err}`)
        await client.app.log({
          body: {
            service: PLUGIN_META.name,
            level: "error",
            message: `Failed to inject compaction context: ${err}`,
          },
        })
      }
    },

    /**
     * Post-compaction: two-phase approach.
     *
     * Phase 1 (session.compacted): The summary message doesn't exist yet at this
     * point, so we just record the OpenCode session ID and timestamp.
     *
     * Phase 2 (message.updated): Fires once the compacted summary is saved as a
     * message. We detect this by checking if a compaction is pending, then fetch
     * the messages, extract the summary text, and post it to Nexus.
     */
    event: async ({ event }) => {
      const eventType = event.type as string
      // Only log non-delta events to keep log readable
      if (eventType !== "message.part.delta") {
        fileLog(directory, "info", `=== event fired === type=${eventType}`)
      }

      // Phase 1: session.compacted — record pending state
      if (eventType === "session.compacted") {
        const sessionID = (
          event as unknown as { properties: { sessionID: string } }
        ).properties?.sessionID

        fileLog(directory, "info", `session.compacted — OpenCode sessionID=${sessionID}`)
        fileLog(directory, "debug", `Full event: ${JSON.stringify(event)}`)

        if (!sessionID || !nexusConfig) {
          if (!nexusConfig) fileLog(directory, "warn", "No Nexus config — skipping")
          if (!sessionID) fileLog(directory, "warn", "No sessionID in event — skipping")
          return
        }

        pendingCompaction = {
          openCodeSessionId: sessionID,
          timestamp: new Date(),
        }
        fileLog(directory, "info", `Pending compaction set — waiting for message.updated`)
        return
      }

      // Phase 2: message.updated — extract summary and post to Nexus
      if (eventType === "message.updated" && pendingCompaction) {
        // Safety: expire pending compaction after 30s to avoid stale state
        const elapsed = Date.now() - pendingCompaction.timestamp.getTime()
        if (elapsed > 30_000) {
          fileLog(directory, "warn", `Pending compaction expired (${elapsed}ms) — discarding`)
          pendingCompaction = null
          return
        }

        const pending = pendingCompaction
        pendingCompaction = null // consume immediately to avoid double-fire

        fileLog(directory, "info", `message.updated after compaction — extracting summary (${elapsed}ms after compaction)`)

        try {
          const { data } = await client.session.messages({
            path: { id: pending.openCodeSessionId },
          })

          if (!data) {
            fileLog(directory, "warn", "Could not fetch session messages — data is null/undefined")
            return
          }

          const messages = data as Array<{
            info: { role: string }
            parts: Array<Record<string, unknown>>
          }>
          fileLog(directory, "debug", `Post-compaction: fetched ${messages.length} messages`)
          const state = extractNexusState(messages, directory)

          if (!state.sessionId) {
            fileLog(directory, "warn", "No Nexus session ID found — skipping compaction entry")
            return
          }

          const time = pending.timestamp.toLocaleTimeString("de-DE", {
            hour: "2-digit",
            minute: "2-digit",
          })

          // Extract the compacted summary — after compaction the LAST assistant
          // message contains the compressed context (the summary is appended as
          // the final message, not the first).
          let compactedText = ""
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i]
            if (msg.info?.role !== "assistant") continue
            for (const rawPart of msg.parts ?? []) {
              const part = rawPart as { type?: string; text?: string }
              if (part.type === "text" && part.text) {
                compactedText = part.text
                break
              }
            }
            if (compactedText) break
          }

          // Strip leading markdown separators (---) and whitespace from
          // the compacted text — Claude often starts with "---\n## Goal"
          // which creates ugly double separators in the DB entry.
          compactedText = compactedText.replace(/^(\s*---\s*\n?)+/, "").trimStart()

          // Shift all markdown headings down by 2 levels so they nest
          // hierarchically under "### Agent Summary" (H3).
          // e.g. ## Goal → #### Goal, ### Done → ##### Done
          compactedText = compactedText.replace(/^(#{2,6})\s/gm, (match, hashes: string) => {
            const newLevel = Math.min(hashes.length + 2, 6)
            return "#".repeat(newLevel) + " "
          })

          fileLog(directory, "debug", `Compacted text length: ${compactedText.length}`)
          if (compactedText) {
            fileLog(directory, "debug", `Compacted text preview: ${compactedText.substring(0, 200)}...`)
          }

          const summary = compactedText
            ? `## Compaction at ${time}\n\nContext preserved via nexus-compaction-plus v${PLUGIN_META.version}.\n\n### Agent Summary\n\n${compactedText}`
            : `## Compaction at ${time}\n\nContext preserved via nexus-compaction-plus v${PLUGIN_META.version}.`

          await appendCompactionEntry(nexusConfig!, state.sessionId, summary, directory)

          fileLog(directory, "info", `Compaction entry recorded in Nexus session ${state.sessionId}`)
          await client.app.log({
            body: {
              service: PLUGIN_META.name,
              level: "info",
              message: `Recorded compaction entry in Nexus session ${state.sessionId} (summary: ${compactedText.length} chars)`,
            },
          })
        } catch (err) {
          fileLog(directory, "error", `Post-compaction message.updated handler failed: ${err}`)
          await client.app.log({
            body: {
              service: PLUGIN_META.name,
              level: "error",
              message: `Failed to record compaction entry: ${err}`,
            },
          })
        }
        return
      }
    },
  }
}
