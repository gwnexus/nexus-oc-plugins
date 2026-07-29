import { type Plugin } from "@opencode-ai/plugin"
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

/**
 * Plugin metadata — single source of truth for name/version.
 */
const PLUGIN_META = {
  name: "nexus-session-guard",
  version: "1.1.2",
  description:
    "Detects code-changing tool completions and reminds the agent to call nexus_session_append before proceeding.",
} as const

// ---------------------------------------------------------------------------
// File-based logger
// ---------------------------------------------------------------------------
let _logDir: string | null = null

function fileLog(directory: string, level: string, message: string): void {
  try {
    if (!_logDir) {
      _logDir = join(directory, ".nexus")
      mkdirSync(_logDir, { recursive: true })
    }
    const ts = new Date().toISOString()
    const line = `[${ts}] [${level.toUpperCase().padEnd(5)}] ${message}\n`
    appendFileSync(join(_logDir, "session-guard.log"), line)
  } catch {
    // Silently ignore file write errors
  }
}

// ---------------------------------------------------------------------------
// Default trigger tool sets
// ---------------------------------------------------------------------------

/** Native OpenCode tools that change code/files. */
const DEFAULT_TRIGGER_TOOLS = new Set(["Edit", "Write", "MultiEdit"])

/** MCP tools that produce knowledge artifacts worth recording. */
const DEFAULT_TRIGGER_MCP = new Set([
  "nexus_task_create",
  "nexus_adr_create",
  "nexus_adr_decide",
])

/**
 * Heuristic: does a Bash command look like a read-only operation?
 * We skip reminders for common read-only patterns to reduce noise.
 */
const READ_ONLY_BASH_PATTERNS = [
  /^\s*(cat|head|tail|less|more|wc|file|stat|du|df|ls|find|grep|rg|awk|sed\s+-n|echo|printf|which|type|command\s+-v|node\s+-e|node\s+--eval)/,
  /^\s*(git\s+(status|log|diff|show|branch|remote|tag))/,
  /^\s*(rtk\s+(gain|discover))/,
  /^\s*(npm\s+(ls|list|view|info|outdated|audit))/,
  /^\s*(npx\s+--yes\s+)/, // npx installs are typically read-ish
  /^\s*(pwd|hostname|uname|env|printenv|id|whoami)/,
]

function isBashReadOnly(input: Record<string, unknown>): boolean {
  const cmd = String(input?.command ?? input?.cmd ?? "")
  if (!cmd) return true // empty command = no-op
  return READ_ONLY_BASH_PATTERNS.some((p) => p.test(cmd))
}

// ---------------------------------------------------------------------------
// Debounce / batch configuration
// ---------------------------------------------------------------------------

/** Minimum trigger tool calls before a reminder fires in a single user turn. */
const TRIGGER_THRESHOLD = 3

// ---------------------------------------------------------------------------
// Reminder message
// ---------------------------------------------------------------------------

const REMINDER_MESSAGE =
  "<system-reminder>\n" +
  "[nexus-session-guard] You completed a code-changing operation but have not " +
  "appended a session entry since the last user instruction. Please call " +
  "nexus_session_append with a summary of what was just done before proceeding " +
  "to the next task.\n" +
  "</system-reminder>"

// ---------------------------------------------------------------------------
// Plugin implementation
// ---------------------------------------------------------------------------

/**
 * Nexus Session Guard
 *
 * Enforces session append discipline by detecting code-changing tool
 * completions and injecting a system reminder when the agent hasn't
 * called nexus_session_append since the last user instruction.
 *
 * State tracking:
 *   - lastUserTurnIndex: incremented on each user message (chat.message)
 *   - lastAppendTurnIndex: updated when nexus_session_append is detected
 *
 * When a trigger tool completes and lastUserTurnIndex > lastAppendTurnIndex,
 * a system reminder is injected into the tool output.
 */
export const NexusSessionGuard: Plugin = async (ctx) => {
  const { client, directory } = ctx

  // -- State --
  let lastUserTurnIndex = 0
  let lastAppendTurnIndex = 0
  let reminderCount = 0
  let suppressCount = 0
  let triggerCountThisTurn = 0
  let reminderFiredThisTurn = false
  let _lastSeenUserMsgId: string | null = null

  fileLog(directory, "info", "=== Plugin initializing ===")
  fileLog(directory, "info", `Directory: ${directory}`)

  await client.app.log({
    body: {
      service: PLUGIN_META.name,
      level: "info",
      message: `Plugin loaded (v${PLUGIN_META.version}) — monitoring for missing session appends`,
    },
  })

  return {
    // -----------------------------------------------------------------
    // tool.execute.after — core detection hook
    // -----------------------------------------------------------------
    "tool.execute.after": async (input, output) => {
      const toolName = String(input?.tool ?? "")
      if (!toolName) return

      // 1. If the agent just called nexus_session_append → update tracking
      if (toolName === "nexus_session_append") {
        lastAppendTurnIndex = lastUserTurnIndex
        fileLog(
          directory,
          "debug",
          `session_append detected — lastAppendTurnIndex set to ${lastAppendTurnIndex}`,
        )
        return
      }

      // 2. Check if this is a trigger tool
      let isTrigger = false

      if (DEFAULT_TRIGGER_TOOLS.has(toolName)) {
        isTrigger = true
      } else if (DEFAULT_TRIGGER_MCP.has(toolName)) {
        isTrigger = true
      } else if (toolName === "Bash" || toolName === "bash") {
        // Bash is only a trigger if the command looks mutating
        const args = (input as Record<string, unknown>) ?? {}
        if (!isBashReadOnly(args)) {
          isTrigger = true
        }
      }

      if (!isTrigger) return

      // 3. Increment trigger count for this turn
      triggerCountThisTurn++

      // 4. Check if an append is needed
      if (lastUserTurnIndex <= lastAppendTurnIndex) {
        suppressCount++
        fileLog(
          directory,
          "debug",
          `Trigger tool ${toolName} — append already recorded (user=${lastUserTurnIndex}, append=${lastAppendTurnIndex})`,
        )
        return
      }

      // 5. Suppress if below threshold or already reminded this turn
      if (triggerCountThisTurn < TRIGGER_THRESHOLD) {
        fileLog(
          directory,
          "debug",
          `Trigger tool ${toolName} — below threshold (${triggerCountThisTurn}/${TRIGGER_THRESHOLD}), suppressing`,
        )
        return
      }

      if (reminderFiredThisTurn) {
        fileLog(
          directory,
          "debug",
          `Trigger tool ${toolName} — reminder already fired this turn, suppressing`,
        )
        return
      }

      // 6. Inject reminder into tool output
      reminderFiredThisTurn = true
      reminderCount++
      fileLog(
        directory,
        "info",
        `REMINDER #${reminderCount} — tool=${toolName}, user=${lastUserTurnIndex}, append=${lastAppendTurnIndex}`,
      )

      await client.app.log({
        body: {
          service: PLUGIN_META.name,
          level: "info",
          message: `Reminder #${reminderCount}: ${toolName} completed without session_append (user turn ${lastUserTurnIndex})`,
        },
      })

      // Append reminder to the tool output string
      const raw = output as Record<string, unknown>
      if (typeof raw.output === "string") {
        raw.output = raw.output + "\n\n" + REMINDER_MESSAGE
      } else if (Array.isArray(raw.content)) {
        // MCP CallToolResult shape — append a text part
        raw.content.push({
          type: "text",
          text: "\n\n" + REMINDER_MESSAGE,
        })
      }
    },

    // -----------------------------------------------------------------
    // event — track user turns via message.updated
    // -----------------------------------------------------------------
    event: async ({ event }) => {
      const eventType = event.type as string

      // OpenCode does NOT emit message.created for user messages.
      // It emits message.updated with properties.info.role === 'user'.
      // Multiple message.updated events fire per user message (status
      // transitions, part updates), so we deduplicate by msgId.
      if (eventType === "message.updated") {
        const props = (event as unknown as { properties?: { info?: { role?: string; id?: string } } })
          .properties
        if (props?.info?.role === "user") {
          const msgId = props.info.id
          if (msgId && msgId !== _lastSeenUserMsgId) {
            _lastSeenUserMsgId = msgId
            lastUserTurnIndex++
            triggerCountThisTurn = 0
            reminderFiredThisTurn = false
            fileLog(
              directory,
              "debug",
              `User turn ${lastUserTurnIndex} detected (msgId=${msgId}) — counters reset`,
            )
          }
        }
      }
    },
  }
}
