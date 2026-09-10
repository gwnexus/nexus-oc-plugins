import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs to avoid real file system writes
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    appendFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import {
  NexusRoutingGuard,
  detectRoutingWarnings,
} from "./nexus-routing-guard.ts";

function makeClient(opts: {
  providers?: Array<{ id: string; models: Record<string, unknown> }>;
  agents?: Array<{
    name: string;
    model?: { providerID: string; modelID: string };
  }>;
  providersError?: boolean;
  agentsError?: boolean;
}) {
  return {
    app: {
      log: vi.fn().mockResolvedValue(undefined),
      agents: opts.agentsError
        ? vi.fn().mockRejectedValue(new Error("agents unavailable"))
        : vi.fn().mockResolvedValue({ data: opts.agents ?? [] }),
    },
    config: {
      providers: opts.providersError
        ? vi.fn().mockRejectedValue(new Error("providers unavailable"))
        : vi
            .fn()
            .mockResolvedValue({
              data: { providers: opts.providers ?? [], default: {} },
            }),
    },
  };
}

describe("detectRoutingWarnings (pure function)", () => {
  it("returns no warnings for a healthy config", () => {
    const warnings = detectRoutingWarnings(
      {
        providers: [
          { id: "github-copilot", models: { "claude-sonnet-5": {} } },
        ],
      },
      [
        {
          name: "nexus-plan",
          model: { providerID: "github-copilot", modelID: "claude-sonnet-5" },
        },
      ],
    );
    expect(warnings).toHaveLength(0);
  });

  it("flags unknown_provider when the provider is not in the catalog", () => {
    const warnings = detectRoutingWarnings(
      { providers: [{ id: "openai", models: { "gpt-5": {} } }] },
      [
        {
          name: "nexus-plan",
          model: { providerID: "github-copilot", modelID: "claude-sonnet-5" },
        },
      ],
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("unknown_provider");
    expect(warnings[0].agent).toBe("nexus-plan");
  });

  it("flags unknown_model when the provider exists but the model id does not", () => {
    const warnings = detectRoutingWarnings(
      {
        providers: [
          { id: "github-copilot", models: { "claude-sonnet-5": {} } },
        ],
      },
      [
        {
          name: "nexus-plan",
          model: { providerID: "github-copilot", modelID: "claude-sonnet-4-6" },
        },
      ],
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("unknown_model");
    expect(warnings[0].provider).toBe("github-copilot");
    expect(warnings[0].message).toContain("github-copilot");
  });

  it("does NOT check agents without an explicit model", () => {
    const warnings = detectRoutingWarnings(
      { providers: [{ id: "openai", models: { "gpt-5": {} } }] },
      [{ name: "build" }],
    );
    expect(warnings).toHaveLength(0);
  });

  it("reports multiple divergent agents independently", () => {
    const warnings = detectRoutingWarnings(
      { providers: [{ id: "opencode", models: { "big-pickle": {} } }] },
      [
        {
          name: "nexus-plan",
          model: { providerID: "github-copilot", modelID: "claude-sonnet-4-6" },
        },
        {
          name: "nexus-review",
          model: { providerID: "github-copilot", modelID: "claude-sonnet-4-6" },
        },
        {
          name: "nexus-act",
          model: { providerID: "opencode", modelID: "big-pickle" },
        },
      ],
    );
    expect(warnings).toHaveLength(2);
    expect(warnings.map((w) => w.agent)).toEqual([
      "nexus-plan",
      "nexus-review",
    ]);
  });
});

describe("NexusRoutingGuard plugin", () => {
  const originalEnv = process.env.NEXUS_ROUTING_GUARD_ENABLED;

  beforeEach(() => {
    delete process.env.NEXUS_ROUTING_GUARD_ENABLED;
  });

  afterEach(() => {
    if (originalEnv === undefined)
      delete process.env.NEXUS_ROUTING_GUARD_ENABLED;
    else process.env.NEXUS_ROUTING_GUARD_ENABLED = originalEnv;
  });

  it("returns the expected hooks", async () => {
    const client = makeClient({});
    const hooks = await NexusRoutingGuard({
      client,
      directory: "/tmp/test-project",
    } as any);
    expect(hooks["tool.execute.after"]).toBeTypeOf("function");
    expect(hooks["experimental.chat.system.transform"]).toBeTypeOf("function");
  });

  it("stays silent on the tool-output banner when the config is clean", async () => {
    const client = makeClient({
      providers: [{ id: "github-copilot", models: { "claude-sonnet-5": {} } }],
      agents: [
        {
          name: "nexus-plan",
          model: { providerID: "github-copilot", modelID: "claude-sonnet-5" },
        },
      ],
    });
    const hooks = await NexusRoutingGuard({
      client,
      directory: "/tmp/test-project",
    } as any);

    const output = { output: "some tool result" };
    await hooks["tool.execute.after"]({ tool: "Read" }, output);

    expect(output.output).toBe("some tool result");
  });

  it("never emits a confirmation banner, even when checked repeatedly and clean", async () => {
    const client = makeClient({
      providers: [{ id: "opencode", models: { "big-pickle": {} } }],
      agents: [
        {
          name: "nexus-act",
          model: { providerID: "opencode", modelID: "big-pickle" },
        },
      ],
    });
    const hooks = await NexusRoutingGuard({
      client,
      directory: "/tmp/test-project",
    } as any);

    for (let i = 0; i < 3; i++) {
      const output = { output: `result ${i}` };
      await hooks["tool.execute.after"]({ tool: "Read" }, output);
      expect(output.output).toBe(`result ${i}`);
    }
  });

  it("injects a one-shot banner on the first tool call when divergence is detected", async () => {
    const client = makeClient({
      providers: [{ id: "github-copilot", models: { "claude-sonnet-5": {} } }],
      agents: [
        {
          name: "nexus-plan",
          model: { providerID: "github-copilot", modelID: "claude-sonnet-4-6" },
        },
      ],
    });
    const hooks = await NexusRoutingGuard({
      client,
      directory: "/tmp/test-project",
    } as any);

    const output1 = { output: "first tool result" };
    await hooks["tool.execute.after"]({ tool: "Read" }, output1);
    expect(output1.output).toContain("[nexus-routing-guard]");
    expect(output1.output).toContain("unknown_model");
    expect(output1.output).toContain("nexus-plan");
  });

  it("fires the banner only once per session, even across many tool calls", async () => {
    const client = makeClient({
      providers: [{ id: "github-copilot", models: { "claude-sonnet-5": {} } }],
      agents: [
        {
          name: "nexus-plan",
          model: { providerID: "github-copilot", modelID: "claude-sonnet-4-6" },
        },
      ],
    });
    const hooks = await NexusRoutingGuard({
      client,
      directory: "/tmp/test-project",
    } as any);

    const output1 = { output: "first" };
    await hooks["tool.execute.after"]({ tool: "Read" }, output1);
    expect(output1.output).toContain("[nexus-routing-guard]");

    const output2 = { output: "second" };
    await hooks["tool.execute.after"]({ tool: "Edit" }, output2);
    expect(output2.output).toBe("second");

    const output3 = { output: "third" };
    await hooks["tool.execute.after"]({ tool: "Bash" }, output3);
    expect(output3.output).toBe("third");
  });

  it("handles the MCP content-array output shape", async () => {
    const client = makeClient({
      providers: [{ id: "openai", models: { "gpt-5": {} } }],
      agents: [
        {
          name: "nexus-review",
          model: { providerID: "github-copilot", modelID: "claude-sonnet-4-6" },
        },
      ],
    });
    const hooks = await NexusRoutingGuard({
      client,
      directory: "/tmp/test-project",
    } as any);

    const output = { content: [{ type: "text", text: "ok" }] };
    await hooks["tool.execute.after"]({ tool: "nexus_task_create" }, output);

    expect(output.content).toHaveLength(2);
    expect(output.content[1].text).toContain("[nexus-routing-guard]");
  });

  it("degrades silently when client.config.providers() fails, never blocking the tool call", async () => {
    const client = makeClient({ providersError: true });
    const hooks = await NexusRoutingGuard({
      client,
      directory: "/tmp/test-project",
    } as any);

    const output = { output: "unaffected" };
    await expect(
      hooks["tool.execute.after"]({ tool: "Read" }, output),
    ).resolves.toBeUndefined();
    expect(output.output).toBe("unaffected");
  });

  it("degrades silently when client.app.agents() fails, never blocking the tool call", async () => {
    const client = makeClient({ agentsError: true });
    const hooks = await NexusRoutingGuard({
      client,
      directory: "/tmp/test-project",
    } as any);

    const output = { output: "unaffected" };
    await expect(
      hooks["tool.execute.after"]({ tool: "Read" }, output),
    ).resolves.toBeUndefined();
    expect(output.output).toBe("unaffected");
  });

  it("does nothing at all when disabled via env var", async () => {
    process.env.NEXUS_ROUTING_GUARD_ENABLED = "false";
    const client = makeClient({
      providers: [{ id: "github-copilot", models: { "claude-sonnet-5": {} } }],
      agents: [
        {
          name: "nexus-plan",
          model: { providerID: "github-copilot", modelID: "claude-sonnet-4-6" },
        },
      ],
    });
    const hooks = await NexusRoutingGuard({
      client,
      directory: "/tmp/test-project",
    } as any);

    const output = { output: "untouched" };
    await hooks["tool.execute.after"]({ tool: "Read" }, output);
    expect(output.output).toBe("untouched");
    expect(client.config.providers).not.toHaveBeenCalled();
  });

  it("pushes divergence context into the system prompt transform", async () => {
    const client = makeClient({
      providers: [{ id: "github-copilot", models: { "claude-sonnet-5": {} } }],
      agents: [
        {
          name: "nexus-plan",
          model: { providerID: "github-copilot", modelID: "claude-sonnet-4-6" },
        },
      ],
    });
    const hooks = await NexusRoutingGuard({
      client,
      directory: "/tmp/test-project",
    } as any);

    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({} as any, output);

    expect(output.system).toHaveLength(1);
    expect(output.system[0]).toContain("nexus-plan");
  });

  it("does not push into the system prompt when clean", async () => {
    const client = makeClient({
      providers: [{ id: "opencode", models: { "big-pickle": {} } }],
      agents: [
        {
          name: "nexus-act",
          model: { providerID: "opencode", modelID: "big-pickle" },
        },
      ],
    });
    const hooks = await NexusRoutingGuard({
      client,
      directory: "/tmp/test-project",
    } as any);

    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({} as any, output);

    expect(output.system).toHaveLength(0);
  });
});
