import type { Plugin } from "@opencode-ai/plugin"

/**
 * Nexus Compaction Plus
 *
 * Preserves Nexus session context across OpenCode compaction events and
 * records each compaction as an auditable entry in the active Nexus session.
 */

interface NexusState {
  sessionId?: string
  sessionTitle?: string
  projectId?: string
  agentId?: string
}

/**
 * Attempt to extract the active Nexus session/project from MCP tool history.
 * Falls back to environment-based detection.
 */
function extractNexusState(messages: Array<Record<string, unknown>>): NexusState {
  const state: NexusState = {}

  for (const msg of messages) {
    const parts = (msg.parts ?? msg.content ?? []) as Array<Record<string, unknown>>
    for (const part of Array.isArray(parts) ? parts : []) {
      if (part.type !== "tool-invocation" && part.type !== "tool-call") continue

      const toolName = (part.toolName ?? part.name ?? "") as string
      const args = (part.args ?? part.input ?? {}) as Record<string, unknown>

      // session_create returns session_id
      if (toolName === "nexus_session_create") {
        if (args.project_id) state.projectId = String(args.project_id)
        if (args.agent_id) state.agentId = String(args.agent_id)
      }

      // session_append carries session_id
      if (toolName === "nexus_session_append" && args.session_id) {
        state.sessionId = String(args.session_id)
      }

      // Any tool with project_id
      if (args.project_id && !state.projectId) {
        state.projectId = String(args.project_id)
      }

      // Check tool results for session creation
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
function buildNexusContext(state: NexusState): string[] {
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
  lines.push("- Continue using the same Nexus session ID for `nexus_session_append` calls")
  lines.push("- Do NOT create a new session — the existing one is still active")
  lines.push("- Reference the project ID when making MCP tool calls")
  lines.push("- Check the todo list and Nexus task state for pending work")

  return lines
}

export const NexusCompactionPlus: Plugin = async (ctx) => {
  const { client } = ctx

  await client.app.log({
    body: {
      service: "nexus-compaction-plus",
      level: "info",
      message: "Plugin loaded",
    },
  })

  return {
    /**
     * Pre-compaction: inject Nexus context into the continuation summary prompt.
     */
    "experimental.session.compacting": async (input, output) => {
      try {
        const messages = (input.messages ?? []) as Array<Record<string, unknown>>
        const state = extractNexusState(messages)

        if (!state.sessionId && !state.projectId) {
          await client.app.log({
            body: {
              service: "nexus-compaction-plus",
              level: "info",
              message: "No active Nexus session detected — skipping context injection",
            },
          })
          return
        }

        const contextLines = buildNexusContext(state)
        output.context.push(contextLines.join("\n"))

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
     * Post-compaction: record the compaction event in the active Nexus session.
     */
    "session.compacted": async (input) => {
      try {
        const sessionData = input as Record<string, unknown>
        const messages = (sessionData.messages ?? []) as Array<Record<string, unknown>>
        const state = extractNexusState(messages)

        if (!state.sessionId) {
          await client.app.log({
            body: {
              service: "nexus-compaction-plus",
              level: "info",
              message: "No Nexus session ID found — skipping compaction entry",
            },
          })
          return
        }

        const now = new Date()
        const time = now.toLocaleTimeString("de-DE", {
          hour: "2-digit",
          minute: "2-digit",
        })

        const messageCount = messages.length
        const summary = `Session compacted at ${time} — ${messageCount} messages compressed. Context preserved via nexus-compaction-plus plugin.`

        // Use the OpenCode SDK client to call the MCP tool
        await client.tool.execute({
          body: {
            tool: "nexus_session_append",
            args: {
              session_id: state.sessionId,
              entry_type: "compaction",
              summary,
            },
          },
        })

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
