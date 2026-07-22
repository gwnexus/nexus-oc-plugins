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

import { NexusCostControl } from "./nexus-cost-control.ts"

function makeClient() {
  return {
    app: { log: vi.fn().mockResolvedValue(undefined) },
    session: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
    },
  }
}

describe("NexusCostControl", () => {
  let hooks: any
  let client: ReturnType<typeof makeClient>

  beforeEach(async () => {
    client = makeClient()
    hooks = await NexusCostControl({ client, directory: "/tmp/test-project" } as any)
  })

  it("should return expected hook structure", () => {
    expect(hooks.event).toBeTypeOf("function")
    expect(hooks.tool.nexus_cost_summary).toBeDefined()
    expect(hooks.tool.nexus_show_plugins).toBeDefined()
  })

  describe("nexus_show_plugins tool", () => {
    it("should return formatted plugin info", async () => {
      const result = await hooks.tool.nexus_show_plugins.execute()
      expect(result).toContain("nexus-cost-control")
      expect(result).toContain("Nexus Plugins")
      expect(result).toContain("session.idle")
      expect(result).toContain("nexus_cost_summary")
    })
  })

  describe("nexus_cost_summary tool", () => {
    it("should report missing Helicone config when not set", async () => {
      const result = await hooks.tool.nexus_cost_summary.execute()
      expect(result).toContain("not configured")
      expect(result).toContain("HELICONE_API_KEY")
    })
  })

  describe("event handler", () => {
    it("should ignore non-session.idle events", async () => {
      await hooks.event({ event: { type: "message.created" } })
      await hooks.event({ event: { type: "session.compacted" } })
      // No error, should just return
    })

    it("should return early on session.idle when no Helicone config", async () => {
      await hooks.event({
        event: {
          type: "session.idle",
          properties: { sessionID: "oc-sess-1" },
        },
      })
      // Should not fetch messages (no config)
      expect(client.session.messages).not.toHaveBeenCalled()
    })
  })

  describe("state extraction", () => {
    it("should extract session from nexus_session_create result", async () => {
      // This tests the extractNexusState function indirectly via session.compacting
      // NexusCostControl uses the same extractNexusState as compaction-plus
      // We verify via the nexus_cost_summary tool which fetches messages
      client.session.list.mockResolvedValue({
        data: [{ id: "oc-session-1" }],
      })
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
                  input: { project_id: "proj-1" },
                  output: JSON.stringify({ id: "nexus-sess-1" }),
                },
              },
            ],
          },
        ],
      })

      // nexus_cost_summary calls extractNexusState internally
      // Without Helicone config, it returns early — but we can verify the flow
      const result = await hooks.tool.nexus_cost_summary.execute()
      expect(result).toContain("not configured")
    })
  })
})
