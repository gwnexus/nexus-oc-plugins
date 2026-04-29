import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Nexus Compaction Plus
 *
 * Preserves Nexus session context across OpenCode compaction events and
 * records each compaction as an auditable entry in the active Nexus session.
 *
 * Reads NEXUS_API_URL and NEXUS_PRIVATE_TOKEN from the MCP server config
 * in opencode.json to call the Nexus API directly.
 */

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
 * Read Nexus credentials from environment variables or opencode.json MCP config.
 */
function getNexusConfig(directory: string): NexusConfig | null {
  // 1. Try environment variables
  const apiUrl = process.env.NEXUS_API_URL
  const token = process.env.NEXUS_PRIVATE_TOKEN
  if (apiUrl && token) return { apiUrl, token }

  // 2. Fall back to opencode.json MCP server environment
  try {
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      const raw = readFileSync(join(directory, name), "utf-8")
      // Strip JSONC comments for .jsonc
      const clean = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
      const config = JSON.parse(clean) as {
        mcp?: Record<string, { environment?: Record<string, string> }>
      }
      if (!config.mcp) continue
      for (const server of Object.values(config.mcp)) {
        const env = server.environment
        if (env?.NEXUS_API_URL && env?.NEXUS_PRIVATE_TOKEN) {
          return { apiUrl: env.NEXUS_API_URL, token: env.NEXUS_PRIVATE_TOKEN }
        }
      }
    }
  } catch {
    // File not found or parse error — ignore
  }

  return null
}

/**
 * Extract Nexus session/project state from OpenCode session messages.
 * Messages come from client.session.messages() and contain tool call parts.
 */
function extractNexusState(
  messages: Array<{ info: { role: string }; parts: Array<Record<string, unknown>> }>,
): NexusState {
  const state: NexusState = {}

  for (const msg of messages) {
    for (const part of msg.parts ?? []) {
      // Tool invocations have type "tool-invocation" with toolName, args, result
      if (part.type !== "tool-invocation") continue

      const toolName = (part.toolName ?? "") as string
      const args = (part.args ?? {}) as Record<string, unknown>

      if (toolName === "nexus_session_create") {
        if (args.project_id) state.projectId = String(args.project_id)
        if (args.agent_id) state.agentId = String(args.agent_id)
      }

      if (toolName === "nexus_session_append" && args.session_id) {
        state.sessionId = String(args.session_id)
      }

      // Any nexus_ tool with project_id
      if (toolName.startsWith("nexus_") && args.project_id && !state.projectId) {
        state.projectId = String(args.project_id)
      }

      // Tool results may contain session_id from creation
      const result = part.result as Record<string, unknown> | undefined
      if (result) {
        if (result.session_id) state.sessionId = String(result.session_id)
        if (result.title) state.sessionTitle = String(result.title)
      }
    }
  }

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
): Promise<void> {
  const url = `${config.apiUrl}/api/mcp/sessions`
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({
      action: "session_append",
      session_id: sessionId,
      entry_type: "compaction",
      summary,
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Nexus API ${res.status}: ${body}`)
  }
}

export const NexusCompactionPlus: Plugin = async (ctx) => {
  const { client, directory } = ctx
  const nexusConfig = getNexusConfig(directory)

  await client.app.log({
    body: {
      service: "nexus-compaction-plus",
      level: "info",
      message: nexusConfig
        ? `Plugin loaded — Nexus API: ${nexusConfig.apiUrl}`
        : "Plugin loaded — WARNING: NEXUS_API_URL/NEXUS_PRIVATE_TOKEN not set, post-compaction recording disabled",
    },
  })

  return {
    /**
     * Pre-compaction: load session messages, extract Nexus state,
     * inject context into the compaction prompt.
     */
    "experimental.session.compacting": async (input, output) => {
      try {
        // Fetch messages from the OpenCode session
        const { data } = await client.session.messages({
          path: { id: input.sessionID },
        })

        if (!data) {
          await client.app.log({
            body: {
              service: "nexus-compaction-plus",
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
        const state = extractNexusState(messages)

        if (!state.sessionId && !state.projectId) {
          await client.app.log({
            body: {
              service: "nexus-compaction-plus",
              level: "info",
              message:
                "No active Nexus session detected — skipping context injection",
            },
          })
          return
        }

        output.context.push(buildNexusContext(state))

        await client.app.log({
          body: {
            service: "nexus-compaction-plus",
            level: "info",
            message: `Injected Nexus context: session=${state.sessionId ?? "unknown"}, project=${state.projectId ?? "unknown"}`,
          },
        })
      } catch (err) {
        await client.app.log({
          body: {
            service: "nexus-compaction-plus",
            level: "error",
            message: `Failed to inject compaction context: ${err}`,
          },
        })
      }
    },

    /**
     * Post-compaction: record the compaction event in the active Nexus session
     * via direct REST API call.
     */
    event: async ({ event }) => {
      if (event.type !== "session.compacted") return
      if (!nexusConfig) return

      try {
        const sessionID = (
          event as unknown as { properties: { sessionID: string } }
        ).properties?.sessionID

        if (!sessionID) return

        // Fetch messages to find the Nexus session ID
        const { data } = await client.session.messages({
          path: { id: sessionID },
        })

        if (!data) return

        const messages = data as Array<{
          info: { role: string }
          parts: Array<Record<string, unknown>>
        }>
        const state = extractNexusState(messages)

        if (!state.sessionId) {
          await client.app.log({
            body: {
              service: "nexus-compaction-plus",
              level: "info",
              message:
                "No Nexus session ID found — skipping compaction entry",
            },
          })
          return
        }

        const now = new Date()
        const time = now.toLocaleTimeString("de-DE", {
          hour: "2-digit",
          minute: "2-digit",
        })

        const summary = `Session compacted at ${time}. Context preserved via nexus-compaction-plus plugin.`

        await appendCompactionEntry(nexusConfig, state.sessionId, summary)

        await client.app.log({
          body: {
            service: "nexus-compaction-plus",
            level: "info",
            message: `Recorded compaction entry in Nexus session ${state.sessionId}`,
          },
        })
      } catch (err) {
        await client.app.log({
          body: {
            service: "nexus-compaction-plus",
            level: "error",
            message: `Failed to record compaction entry: ${err}`,
          },
        })
      }
    },
  }
}
