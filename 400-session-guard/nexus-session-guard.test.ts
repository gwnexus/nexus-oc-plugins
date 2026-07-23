import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock @opencode-ai/plugin before importing the plugin
vi.mock("@opencode-ai/plugin", () => ({
  tool: (def: any) => def,
}))

// Mock fs to avoid real file system writes
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  return {
    ...actual,
    appendFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  }
})

import { NexusSessionGuard } from "./nexus-session-guard.ts"

function makeClient() {
  return {
    app: { log: vi.fn().mockResolvedValue(undefined) },
    session: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
    },
  }
}

/** Helper to create a user message.updated event with a unique msgId. */
let _msgCounter = 0
function userMessageEvent(msgId?: string) {
  _msgCounter++
  return {
    event: {
      type: "message.updated",
      properties: { info: { role: "user", id: msgId ?? `msg-${_msgCounter}` } },
    },
  }
}

describe("NexusSessionGuard", () => {
  let hooks: any
  let client: ReturnType<typeof makeClient>

  beforeEach(async () => {
    _msgCounter = 0
    client = makeClient()
    hooks = await NexusSessionGuard({ client, directory: "/tmp/test-project" } as any)
  })

  it("should return tool.execute.after and event hooks", () => {
    expect(hooks["tool.execute.after"]).toBeTypeOf("function")
    expect(hooks.event).toBeTypeOf("function")
  })

  describe("tool.execute.after", () => {
    it("should update tracking when nexus_session_append is called", async () => {
      await hooks.event(userMessageEvent())

      const output = { output: "ok" }
      await hooks["tool.execute.after"]({ tool: "nexus_session_append" }, output)

      // Edit should NOT trigger a reminder (append already recorded)
      const editOutput = { output: "file edited" }
      await hooks["tool.execute.after"]({ tool: "Edit" }, editOutput)
      expect(editOutput.output).toBe("file edited")
    })

    it("should NOT inject reminder below trigger threshold", async () => {
      await hooks.event(userMessageEvent())

      // First two Edits should NOT fire reminder (threshold = 3)
      const output1 = { output: "edit 1" }
      await hooks["tool.execute.after"]({ tool: "Edit" }, output1)
      expect(output1.output).toBe("edit 1")

      const output2 = { output: "edit 2" }
      await hooks["tool.execute.after"]({ tool: "Write" }, output2)
      expect(output2.output).toBe("edit 2")
    })

    it("should inject reminder on reaching trigger threshold", async () => {
      await hooks.event(userMessageEvent())

      await hooks["tool.execute.after"]({ tool: "Edit" }, { output: "e1" })
      await hooks["tool.execute.after"]({ tool: "Write" }, { output: "e2" })

      const output3 = { output: "e3" }
      await hooks["tool.execute.after"]({ tool: "MultiEdit" }, output3)
      expect(output3.output).toContain("[nexus-session-guard]")
      expect(output3.output).toContain("system-reminder")
    })

    it("should inject reminder for MCP trigger tools at threshold", async () => {
      await hooks.event(userMessageEvent())

      await hooks["tool.execute.after"]({ tool: "nexus_task_create" }, { content: [{ type: "text", text: "ok" }] })
      await hooks["tool.execute.after"]({ tool: "nexus_adr_create" }, { content: [{ type: "text", text: "ok" }] })

      const output = { content: [{ type: "text", text: "ok" }] }
      await hooks["tool.execute.after"]({ tool: "nexus_adr_decide" }, output)
      expect(output.content.length).toBeGreaterThan(1)
      expect(output.content.at(-1)!.text).toContain("[nexus-session-guard]")
    })

    it("should inject reminder for mutating Bash at threshold", async () => {
      await hooks.event(userMessageEvent())

      await hooks["tool.execute.after"]({ tool: "Edit" }, { output: "e1" })
      await hooks["tool.execute.after"]({ tool: "Edit" }, { output: "e2" })

      const output = { output: "done" }
      await hooks["tool.execute.after"]({ tool: "Bash", command: "rm -rf /tmp/foo" }, output)
      expect(output.output).toContain("[nexus-session-guard]")
    })

    it("should only fire ONE reminder per user turn", async () => {
      await hooks.event(userMessageEvent())

      await hooks["tool.execute.after"]({ tool: "Edit" }, { output: "e1" })
      await hooks["tool.execute.after"]({ tool: "Edit" }, { output: "e2" })
      const output3 = { output: "e3" }
      await hooks["tool.execute.after"]({ tool: "Edit" }, output3)
      expect(output3.output).toContain("[nexus-session-guard]")

      // 4th should NOT get another reminder
      const output4 = { output: "e4" }
      await hooks["tool.execute.after"]({ tool: "Edit" }, output4)
      expect(output4.output).toBe("e4")
    })

    it("should NOT trigger for read-only Bash commands", async () => {
      await hooks.event(userMessageEvent())

      const readOnlyCommands = [
        "cat file.txt",
        "grep -r pattern .",
        "git status",
        "ls -la",
        "find . -name '*.ts'",
        "npm ls",
        "rtk gain",
        "pwd",
      ]

      for (const cmd of readOnlyCommands) {
        const output = { output: "result" }
        await hooks["tool.execute.after"]({ tool: "Bash", command: cmd }, output)
        expect(output.output).toBe("result")
      }
    })

    it("should NOT trigger for non-trigger tools", async () => {
      await hooks.event(userMessageEvent())

      const output = { output: "result" }
      await hooks["tool.execute.after"]({ tool: "Read" }, output)
      expect(output.output).toBe("result")
    })

    it("should NOT trigger before any user turn", async () => {
      const output = { output: "file edited" }
      await hooks["tool.execute.after"]({ tool: "Edit" }, output)
      expect(output.output).toBe("file edited")
    })

    it("should suppress after append even above threshold", async () => {
      await hooks.event(userMessageEvent())

      await hooks["tool.execute.after"]({ tool: "nexus_session_append" }, {})

      for (let i = 0; i < 5; i++) {
        const output = { output: `edit ${i}` }
        await hooks["tool.execute.after"]({ tool: "Edit" }, output)
        expect(output.output).toBe(`edit ${i}`)
      }
    })

    it("should trigger again after a new user turn", async () => {
      await hooks.event(userMessageEvent())
      await hooks["tool.execute.after"]({ tool: "nexus_session_append" }, {})

      // New user turn — counters reset
      await hooks.event(userMessageEvent())

      await hooks["tool.execute.after"]({ tool: "Edit" }, { output: "e1" })
      await hooks["tool.execute.after"]({ tool: "Edit" }, { output: "e2" })

      const output = { output: "e3" }
      await hooks["tool.execute.after"]({ tool: "Edit" }, output)
      expect(output.output).toContain("[nexus-session-guard]")
    })

    it("should handle empty tool name gracefully", async () => {
      const output = { output: "ok" }
      await hooks["tool.execute.after"]({ tool: "" }, output)
      expect(output.output).toBe("ok")
    })

    it("should handle MCP content array output shape", async () => {
      await hooks.event(userMessageEvent())

      await hooks["tool.execute.after"]({ tool: "Edit" }, { output: "e1" })
      await hooks["tool.execute.after"]({ tool: "Edit" }, { output: "e2" })

      const output = { content: [{ type: "text", text: "result" }] }
      await hooks["tool.execute.after"]({ tool: "nexus_task_create" }, output)

      expect(output.content).toHaveLength(2)
      expect(output.content[1].text).toContain("[nexus-session-guard]")
    })
  })

  describe("event handler", () => {
    it("should increment turn counter on user messages", async () => {
      await hooks.event(userMessageEvent())
      await hooks.event(userMessageEvent())

      await hooks["tool.execute.after"]({ tool: "Edit" }, { output: "e1" })
      await hooks["tool.execute.after"]({ tool: "Edit" }, { output: "e2" })
      const output = { output: "e3" }
      await hooks["tool.execute.after"]({ tool: "Edit" }, output)
      expect(output.output).toContain("[nexus-session-guard]")
    })

    it("should NOT increment on assistant messages", async () => {
      await hooks.event({
        event: {
          type: "message.updated",
          properties: { info: { role: "assistant", id: "asst-1" } },
        },
      })

      const output = { output: "edit" }
      await hooks["tool.execute.after"]({ tool: "Edit" }, output)
      expect(output.output).toBe("edit")
    })

    it("should deduplicate repeated message.updated events with same msgId", async () => {
      // Same msgId fired multiple times — should only count as one turn
      await hooks.event(userMessageEvent("dup-msg-1"))
      await hooks.event(userMessageEvent("dup-msg-1"))
      await hooks.event(userMessageEvent("dup-msg-1"))

      // Should behave as 1 user turn — reach threshold
      await hooks["tool.execute.after"]({ tool: "Edit" }, { output: "e1" })
      await hooks["tool.execute.after"]({ tool: "Edit" }, { output: "e2" })
      const output = { output: "e3" }
      await hooks["tool.execute.after"]({ tool: "Edit" }, output)
      expect(output.output).toContain("[nexus-session-guard]")
    })

    it("should ignore non-message.updated events", async () => {
      await hooks.event({ event: { type: "session.idle" } })
      await hooks.event({ event: { type: "message.created" } })

      const output = { output: "edit" }
      await hooks["tool.execute.after"]({ tool: "Edit" }, output)
      expect(output.output).toBe("edit")
    })
  })
})
