import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock @opencode-ai/plugin
vi.mock("@opencode-ai/plugin", () => {
  const mockSchema = {
    string: () => ({ optional: () => ({ describe: () => ({}) }), describe: () => ({}) }),
  }
  const toolFn: any = (def: any) => def
  toolFn.schema = mockSchema
  return { tool: toolFn }
})

// Mock fs — headroom needs many fs functions
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  return {
    ...actual,
    appendFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    chmodSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    readdirSync: vi.fn().mockReturnValue([]),
    statSync: vi.fn().mockReturnValue({ size: 0, mtimeMs: Date.now() }),
    readFileSync: vi.fn().mockImplementation(() => {
      throw new Error("not found")
    }),
  }
})

import { NexusHeadroomIntercept } from "./nexus-headroom-intercept.ts"

function makeClient() {
  return {
    app: { log: vi.fn().mockResolvedValue(undefined) },
    session: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
    },
  }
}

describe("NexusHeadroomIntercept", () => {
  let hooks: any
  let client: ReturnType<typeof makeClient>

  beforeEach(async () => {
    client = makeClient()
    hooks = await NexusHeadroomIntercept({ client, directory: "/tmp/test-project" } as any)
  })

  it("should return expected hook structure", () => {
    expect(hooks["tool.execute.after"]).toBeTypeOf("function")
    expect(hooks.event).toBeTypeOf("function")
    expect(hooks.tool).toBeDefined()
    expect(hooks.tool.nexus_headroom_intercept_retrieve).toBeDefined()
  })

  describe("retrieval tool", () => {
    it("should be registered as nexus_headroom_intercept_retrieve", () => {
      const retrieveTool = hooks.tool.nexus_headroom_intercept_retrieve
      expect(retrieveTool).toBeDefined()
      expect(retrieveTool.args.hash).toBeDefined()
    })

    it("should reject invalid hash format", async () => {
      const retrieveTool = hooks.tool.nexus_headroom_intercept_retrieve
      const result = JSON.parse(await retrieveTool.execute({ hash: "not-a-hash" }))
      expect(result.found).toBe(false)
      expect(result.error).toBe("invalid_hash")
    })

    it("should reject short hash", async () => {
      const retrieveTool = hooks.tool.nexus_headroom_intercept_retrieve
      const result = JSON.parse(await retrieveTool.execute({ hash: "abcdef12" }))
      expect(result.found).toBe(false)
      expect(result.error).toBe("invalid_hash")
    })

    it("should return not found for valid but missing hash", async () => {
      const retrieveTool = hooks.tool.nexus_headroom_intercept_retrieve
      const validHash = "a".repeat(64)
      const result = JSON.parse(await retrieveTool.execute({ hash: validHash }))
      expect(result.found).toBe(false)
      expect(result.hash).toBe(validHash)
    })
  })

  describe("tool.execute.after — policy routing", () => {
    it("should skip non-nexus tools", async () => {
      const output = { output: "original content" }
      await hooks["tool.execute.after"]({ tool: "Read" }, output)
      expect(output.output).toBe("original content")
    })

    it("should passthrough write operations", async () => {
      const output = { content: [{ type: "text", text: '{"action":"session_create"}' }] }
      const contentBefore = JSON.parse(JSON.stringify(output.content))
      await hooks["tool.execute.after"]({ tool: "nexus_session_create" }, output)
      expect(output.content).toEqual(contentBefore)
    })

    it("should passthrough small responses below threshold", async () => {
      const smallResponse = JSON.stringify({ data: { count: 1, items: [] } })
      const output = { content: [{ type: "text", text: smallResponse }] }
      await hooks["tool.execute.after"]({ tool: "nexus_kb_memory" }, output)
      // Small response should pass through (below 2000 token threshold)
      expect(output.content[0].text).toBe(smallResponse)
    })

    it("should passthrough error responses", async () => {
      const output = { output: "error details", isError: true }
      await hooks["tool.execute.after"]({ tool: "nexus_kb_memory" }, output)
      expect(output.output).toBe("error details")
    })

    it("should passthrough retrieval tools", async () => {
      const output = { output: "retrieved content" }
      await hooks["tool.execute.after"](
        { tool: "nexus_headroom_intercept_retrieve" },
        output
      )
      expect(output.output).toBe("retrieved content")
    })

    it("should fallback to passthrough for unknown nexus_ tools", async () => {
      const output = { output: "result" }
      await hooks["tool.execute.after"]({ tool: "nexus_unknown_future_tool" }, output)
      expect(output.output).toBe("result")
    })

    it("should skip bash/shell tools", async () => {
      const output = { output: "bash result" }
      await hooks["tool.execute.after"]({ tool: "bash" }, output)
      expect(output.output).toBe("bash result")
    })

    it("should handle empty tool name", async () => {
      const output = { output: "ok" }
      await hooks["tool.execute.after"]({ tool: "" }, output)
      expect(output.output).toBe("ok")
    })
  })

  describe("tool.execute.after — compression (observe mode)", () => {
    it("should observe large kb_memory responses without mutating", async () => {
      // Generate a response larger than 2000 tokens (~8000 chars)
      const largeData = {
        schema: "nexus.kb-memory.v1",
        data: {
          project_id: "test-project-uuid",
          depth: "standard",
          categories_included: ["adrs", "active_tasks"],
          memory: {
            project: { name: "Test", id: "test-uuid" },
            adrs: Array.from({ length: 20 }, (_, i) => ({
              id: `adr-${i}`,
              adr_number: i + 1,
              title: `ADR ${i + 1}: ${"Some decision about architecture ".repeat(3)}`,
              status: "accepted",
              context: "Context ".repeat(50),
            })),
            active_tasks: Array.from({ length: 10 }, (_, i) => ({
              id: `task-${i}`,
              title: `Task ${i}: ${"Implement feature ".repeat(5)}`,
              status: i % 3 === 0 ? "blocked" : "open",
              priority: ["urgent", "high", "medium", "low"][i % 4],
            })),
            recent_sessions: [],
          },
        },
      }
      const text = JSON.stringify(largeData)
      const output = { content: [{ type: "text", text }] }

      await hooks["tool.execute.after"]({ tool: "nexus_kb_memory" }, output)

      // In default observe mode, output should NOT be mutated
      expect(output.content[0].text).toBe(text)
    })
  })

  describe("event handler — session.idle summary", () => {
    it("should not emit summary when no activity", async () => {
      await hooks.event({
        event: { type: "session.idle" },
      })
      // Should run without error
    })

    it("should ignore non-idle events", async () => {
      await hooks.event({ event: { type: "message.created" } })
      // No error
    })
  })

  describe("policy coverage", () => {
    const EXPECTED_COMPRESS_TOOLS = [
      "nexus_kb_memory",
      "nexus_kb_search",
      "nexus_kb_get",
      "nexus_kb_related",
      "nexus_dispatch_sweep",
      "nexus_dispatch_inbox",
      "nexus_dispatch_outbox",
      "nexus_dispatch_get",
      "nexus_dispatch_related",
      "nexus_doc_list",
      "nexus_task_list",
      "nexus_dc_list",
      "nexus_vl_inbox",
      "nexus_vl_outbox",
      "nexus_sk_list",
      "nexus_sk_get",
      "nexus_sk_export",
      "nexus_pd_list",
      "nexus_pd_get",
      "nexus_directive_export",
      "nexus_rv_list",
      "nexus_rv_get",
      "nexus_project_list",
    ]

    const EXPECTED_PASSTHROUGH_TOOLS = [
      "nexus_session_create",
      "nexus_session_append",
      "nexus_session_close",
      "nexus_task_create",
      "nexus_task_update",
      "nexus_task_note",
      "nexus_task_delete",
      "nexus_doc_ingest",
      "nexus_doc_classify",
      "nexus_doc_update",
      "nexus_doc_delete",
      "nexus_dispatch_create",
      "nexus_dispatch_reply",
      "nexus_dispatch_resolve",
      "nexus_dispatch_close",
      "nexus_dispatch_ack",
      "nexus_dispatch_assign",
      "nexus_dispatch_forward",
      "nexus_adr_create",
      "nexus_adr_submit",
      "nexus_adr_decide",
    ]

    it("should not modify output for any passthrough tool", async () => {
      for (const tool of EXPECTED_PASSTHROUGH_TOOLS) {
        const output = { content: [{ type: "text", text: "response" }] }
        await hooks["tool.execute.after"]({ tool }, output)
        expect(output.content[0].text).toBe("response")
      }
    })

    it("should not modify small output for any compress tool", async () => {
      for (const tool of EXPECTED_COMPRESS_TOOLS) {
        const output = { content: [{ type: "text", text: '{"small": true}' }] }
        await hooks["tool.execute.after"]({ tool }, output)
        // Small responses should pass through regardless of compress policy
        expect(output.content[0].text).toBe('{"small": true}')
      }
    })
  })
})
