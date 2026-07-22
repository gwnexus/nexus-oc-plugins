import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock @opencode-ai/plugin
vi.mock("@opencode-ai/plugin", () => ({
  tool: (def: any) => def,
}))

// Mock fs
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  return {
    ...actual,
    appendFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn().mockImplementation(() => {
      throw new Error("not found")
    }),
  }
})

import { NexusCompactionPlus } from "./nexus-compaction-plus.ts"

function makeClient() {
  return {
    app: { log: vi.fn().mockResolvedValue(undefined) },
    session: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
    },
  }
}

describe("NexusCompactionPlus", () => {
  let hooks: any
  let client: ReturnType<typeof makeClient>

  beforeEach(async () => {
    client = makeClient()
    hooks = await NexusCompactionPlus({ client, directory: "/tmp/test-project" } as any)
  })

  it("should return expected hook structure", () => {
    expect(hooks["experimental.session.compacting"]).toBeTypeOf("function")
    expect(hooks.event).toBeTypeOf("function")
    expect(hooks.tool.nexus_show_plugins).toBeDefined()
  })

  describe("nexus_show_plugins tool", () => {
    it("should return formatted plugin info", async () => {
      const result = await hooks.tool.nexus_show_plugins.execute()
      expect(result).toContain("nexus-compaction-plus")
      expect(result).toContain("Nexus Plugins")
      expect(result).toContain("experimental.session.compacting")
    })
  })

  describe("experimental.session.compacting", () => {
    it("should skip context injection when no Nexus state found", async () => {
      client.session.messages.mockResolvedValue({ data: [] })

      const output = { context: [] as string[] }
      await hooks["experimental.session.compacting"]({ sessionID: "test-session" }, output)

      expect(output.context).toHaveLength(0)
    })

    it("should inject context when Nexus session is found in messages", async () => {
      client.session.messages.mockResolvedValue({
        data: [
          {
            info: { role: "assistant" },
            parts: [
              {
                type: "tool",
                tool: "nexus_session_create",
                state: {
                  status: "completed",
                  input: { project_id: "proj-123", agent_id: "opencode" },
                  output: JSON.stringify({ id: "session-abc", title: "Test Session" }),
                },
              },
            ],
          },
        ],
      })

      const output = { context: [] as string[] }
      await hooks["experimental.session.compacting"]({ sessionID: "test-session" }, output)

      expect(output.context).toHaveLength(1)
      expect(output.context[0]).toContain("session-abc")
      expect(output.context[0]).toContain("proj-123")
      expect(output.context[0]).toContain("Nexus Platform Session Context")
    })

    it("should handle null data gracefully", async () => {
      client.session.messages.mockResolvedValue({ data: null })

      const output = { context: [] as string[] }
      await hooks["experimental.session.compacting"]({ sessionID: "test-session" }, output)

      expect(output.context).toHaveLength(0)
    })
  })

  describe("event handler", () => {
    it("should set pending compaction on session.compacted event", async () => {
      // Fire session.compacted
      await hooks.event({
        event: {
          type: "session.compacted",
          properties: { sessionID: "oc-session-1" },
        },
      })

      // Now fire message.updated — should attempt to process pending compaction
      client.session.messages.mockResolvedValue({
        data: [
          {
            info: { role: "assistant" },
            parts: [
              {
                type: "tool",
                tool: "nexus_session_create",
                state: {
                  status: "completed",
                  input: { project_id: "proj-123" },
                  output: JSON.stringify({ id: "session-abc" }),
                },
              },
            ],
          },
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "## Summary\n\nWork was done." }],
          },
        ],
      })

      // message.updated should consume the pending compaction
      // Without Nexus config, the plugin skips the API call but still
      // consumes the pending state (pendingCompaction set to null).
      await hooks.event({ event: { type: "message.updated" } })

      // A second message.updated should NOT trigger again (pending consumed)
      client.session.messages.mockClear()
      await hooks.event({ event: { type: "message.updated" } })
      expect(client.session.messages).not.toHaveBeenCalled()
    })

    it("should ignore non-compaction events", async () => {
      await hooks.event({ event: { type: "session.idle" } })
      await hooks.event({ event: { type: "message.part.delta" } })
      // No error — should just return
    })

    it("should expire pending compaction after 30s", async () => {
      // Fire session.compacted
      await hooks.event({
        event: {
          type: "session.compacted",
          properties: { sessionID: "oc-session-1" },
        },
      })

      // Simulate 31s passing by mocking Date.now
      const original = Date.now
      Date.now = () => original() + 31_000

      await hooks.event({ event: { type: "message.updated" } })

      // Should NOT fetch messages (expired)
      expect(client.session.messages).not.toHaveBeenCalled()

      Date.now = original
    })
  })

  describe("state extraction", () => {
    it("should extract session ID from session_append args", async () => {
      client.session.messages.mockResolvedValue({
        data: [
          {
            info: { role: "assistant" },
            parts: [
              {
                type: "tool",
                tool: "nexus_session_append",
                state: {
                  status: "completed",
                  input: { session_id: "sess-from-append" },
                },
              },
            ],
          },
        ],
      })

      const output = { context: [] as string[] }
      await hooks["experimental.session.compacting"]({ sessionID: "test" }, output)

      expect(output.context).toHaveLength(1)
      expect(output.context[0]).toContain("sess-from-append")
    })

    it("should extract project ID from any nexus_ tool", async () => {
      client.session.messages.mockResolvedValue({
        data: [
          {
            info: { role: "assistant" },
            parts: [
              {
                type: "tool",
                tool: "nexus_task_list",
                state: {
                  status: "completed",
                  input: { project_id: "proj-from-task" },
                },
              },
            ],
          },
        ],
      })

      const output = { context: [] as string[] }
      await hooks["experimental.session.compacting"]({ sessionID: "test" }, output)

      expect(output.context).toHaveLength(1)
      expect(output.context[0]).toContain("proj-from-task")
    })

    it("should support legacy tool-invocation shape", async () => {
      client.session.messages.mockResolvedValue({
        data: [
          {
            info: { role: "assistant" },
            parts: [
              {
                type: "tool-invocation",
                toolName: "nexus_session_create",
                args: { project_id: "legacy-proj" },
                result: { id: "legacy-sess", title: "Legacy" },
              },
            ],
          },
        ],
      })

      const output = { context: [] as string[] }
      await hooks["experimental.session.compacting"]({ sessionID: "test" }, output)

      expect(output.context).toHaveLength(1)
      expect(output.context[0]).toContain("legacy-sess")
      expect(output.context[0]).toContain("legacy-proj")
    })
  })
})
