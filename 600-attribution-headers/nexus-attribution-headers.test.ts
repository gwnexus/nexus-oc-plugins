import { describe, it, expect } from "vitest"

import { NexusAttributionHeaders, computeAttributionHeaders } from "./nexus-attribution-headers.ts"

function makeInput(overrides: Partial<{ sessionID: string; agent: string; providerId: string }>) {
  return {
    sessionID: overrides.sessionID ?? "ses_abc123",
    agent: overrides.agent ?? "nexus-plan",
    model: {} as any,
    provider: overrides.providerId === undefined ? { id: "nexus" } : { id: overrides.providerId },
    message: {} as any,
  }
}

describe("computeAttributionHeaders (pure function)", () => {
  it("maps nexus-plan to primary_slot=plan", () => {
    expect(computeAttributionHeaders("nexus-plan")).toEqual({ "x-nexus-primary-slot": "plan" })
  })

  it("maps nexus-act to primary_slot=act", () => {
    expect(computeAttributionHeaders("nexus-act")).toEqual({ "x-nexus-primary-slot": "act" })
  })

  it("maps nexus-review to primary_slot=review", () => {
    expect(computeAttributionHeaders("nexus-review")).toEqual({ "x-nexus-primary-slot": "review" })
  })

  it("maps any other agent name to actor_slug verbatim", () => {
    expect(computeAttributionHeaders("senior-backend-engineer")).toEqual({
      "x-nexus-actor-slug": "senior-backend-engineer",
    })
  })

  it("maps OpenCode's internal 'title' call to actor_slug", () => {
    expect(computeAttributionHeaders("title")).toEqual({ "x-nexus-actor-slug": "title" })
  })

  it("maps the built-in 'build' agent to actor_slug (not a nexus-* primary)", () => {
    expect(computeAttributionHeaders("build")).toEqual({ "x-nexus-actor-slug": "build" })
  })

  it("does NOT map an agent with the nexus- prefix but an unknown slot to primary_slot", () => {
    // e.g. a future nexus-* agent that isn't plan/act/review yet
    expect(computeAttributionHeaders("nexus-experimental")).toEqual({
      "x-nexus-actor-slug": "nexus-experimental",
    })
  })

  it("returns no headers for an empty or missing agent name", () => {
    expect(computeAttributionHeaders("")).toEqual({})
    expect(computeAttributionHeaders(undefined)).toEqual({})
    expect(computeAttributionHeaders(null)).toEqual({})
  })
})

describe("NexusAttributionHeaders plugin", () => {
  it("returns the chat.headers hook", async () => {
    const hooks = await NexusAttributionHeaders({} as any)
    expect(hooks["chat.headers"]).toBeTypeOf("function")
  })

  it("sets x-nexus-session-id and x-nexus-primary-slot for a nexus-plan call on the nexus provider", async () => {
    const hooks = await NexusAttributionHeaders({} as any)
    const output = { headers: {} as Record<string, string> }

    await hooks["chat.headers"]!(makeInput({ agent: "nexus-plan" }) as any, output)

    expect(output.headers["x-nexus-session-id"]).toBe("ses_abc123")
    expect(output.headers["x-nexus-primary-slot"]).toBe("plan")
    expect(output.headers["x-nexus-actor-slug"]).toBeUndefined()
  })

  it("sets x-nexus-session-id and x-nexus-actor-slug for a sub-actor call on the nexus provider", async () => {
    const hooks = await NexusAttributionHeaders({} as any)
    const output = { headers: {} as Record<string, string> }

    await hooks["chat.headers"]!(makeInput({ agent: "senior-backend-engineer" }) as any, output)

    expect(output.headers["x-nexus-session-id"]).toBe("ses_abc123")
    expect(output.headers["x-nexus-actor-slug"]).toBe("senior-backend-engineer")
    expect(output.headers["x-nexus-primary-slot"]).toBeUndefined()
  })

  it("attributes OpenCode's internal title-generation call rather than dropping it", async () => {
    const hooks = await NexusAttributionHeaders({} as any)
    const output = { headers: {} as Record<string, string> }

    await hooks["chat.headers"]!(makeInput({ agent: "title" }) as any, output)

    expect(output.headers["x-nexus-session-id"]).toBe("ses_abc123")
    expect(output.headers["x-nexus-actor-slug"]).toBe("title")
  })

  it("does NOT set any header when the provider is not nexus", async () => {
    const hooks = await NexusAttributionHeaders({} as any)
    const output = { headers: {} as Record<string, string> }

    await hooks["chat.headers"]!(makeInput({ providerId: "github-copilot" }) as any, output)

    expect(output.headers).toEqual({})
  })

  it("does NOT set any header when provider.id is absent", async () => {
    const hooks = await NexusAttributionHeaders({} as any)
    const output = { headers: {} as Record<string, string> }

    const input = makeInput({})
    ;(input as any).provider = {}

    await hooks["chat.headers"]!(input as any, output)

    expect(output.headers).toEqual({})
  })

  it("does NOT set any header when provider is missing entirely", async () => {
    const hooks = await NexusAttributionHeaders({} as any)
    const output = { headers: {} as Record<string, string> }

    const input = makeInput({})
    ;(input as any).provider = undefined

    await hooks["chat.headers"]!(input as any, output)

    expect(output.headers).toEqual({})
  })

  it("does NOT set any header when sessionID is missing, even on the nexus provider", async () => {
    const hooks = await NexusAttributionHeaders({} as any)
    const output = { headers: {} as Record<string, string> }

    const input = makeInput({})
    ;(input as any).sessionID = ""

    await hooks["chat.headers"]!(input as any, output)

    expect(output.headers).toEqual({})
  })

  it("preserves any pre-existing headers already set on output", async () => {
    const hooks = await NexusAttributionHeaders({} as any)
    const output = { headers: { "x-existing": "kept" } as Record<string, string> }

    await hooks["chat.headers"]!(makeInput({ agent: "nexus-act" }) as any, output)

    expect(output.headers["x-existing"]).toBe("kept")
    expect(output.headers["x-nexus-primary-slot"]).toBe("act")
  })

  it("never throws when called with a completely empty input object", async () => {
    const hooks = await NexusAttributionHeaders({} as any)
    const output = { headers: {} as Record<string, string> }

    await expect(hooks["chat.headers"]!({} as any, output)).resolves.toBeUndefined()
    expect(output.headers).toEqual({})
  })
})
