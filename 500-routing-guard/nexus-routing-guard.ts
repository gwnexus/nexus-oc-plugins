import { type Plugin } from "@opencode-ai/plugin";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Plugin metadata — single source of truth for name/version.
 */
const PLUGIN_META = {
  name: "nexus-routing-guard",
  version: "1.0.0",
  description:
    "Detects model routing divergence between Nexus-configured agents and the effective merged OpenCode provider/model catalog, and surfaces a one-shot warning.",
} as const;

/** Opt-out env var. Set to "false" to disable the check entirely. */
const ENV_ENABLED = "NEXUS_ROUTING_GUARD_ENABLED";

// ---------------------------------------------------------------------------
// File-based logger
// ---------------------------------------------------------------------------
let _logDir: string | null = null;

function fileLog(directory: string, level: string, message: string): void {
  try {
    if (!_logDir) {
      _logDir = join(directory, ".nexus");
      mkdirSync(_logDir, { recursive: true });
    }
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level.toUpperCase().padEnd(5)}] ${message}\n`;
    appendFileSync(join(_logDir, "routing-guard.log"), line);
  } catch {
    // Silently ignore file write errors
  }
}

// ---------------------------------------------------------------------------
// Divergence types
// ---------------------------------------------------------------------------

type RoutingWarning = {
  code: "unknown_provider" | "unknown_model";
  agent: string;
  provider: string;
  model: string;
  message: string;
};

type ProviderCatalog = {
  providers: Array<{
    id: string;
    models: Record<string, unknown>;
  }>;
};

type AgentInfo = {
  name: string;
  model?: { providerID: string; modelID: string };
};

/**
 * Compare the resolved agent model routing against the merged provider
 * catalog the running OpenCode instance can actually serve.
 *
 * - `unknown_provider`: the agent's providerID is not in the catalog at all.
 * - `unknown_model`: the provider exists and is serviceable, but the
 *   modelID is not in that provider's model set. This is the bug class
 *   that motivated this plugin — provider-level checks are blind to it.
 *
 * Agents without an explicit `model` inherit the instance default and are
 * valid by construction; they are never checked.
 */
export function detectRoutingWarnings(
  catalog: ProviderCatalog,
  agents: AgentInfo[],
): RoutingWarning[] {
  const byId = new Map(catalog.providers.map((p) => [p.id, p]));
  const warnings: RoutingWarning[] = [];

  for (const agent of agents) {
    if (!agent.model) continue;

    const { providerID, modelID } = agent.model;
    const provider = byId.get(providerID);

    if (!provider) {
      warnings.push({
        code: "unknown_provider",
        agent: agent.name,
        provider: providerID,
        model: modelID,
        message: `Agent "${agent.name}" is routed to provider "${providerID}", which this OpenCode instance does not have configured.`,
      });
      continue;
    }

    if (!(modelID in provider.models)) {
      warnings.push({
        code: "unknown_model",
        agent: agent.name,
        provider: providerID,
        model: modelID,
        message: `Agent "${agent.name}" is routed to "${providerID}/${modelID}", but provider "${providerID}" does not serve a model with that id.`,
      });
    }
  }

  return warnings;
}

function formatBanner(warnings: RoutingWarning[]): string {
  const lines = warnings.map((w) => `  - [${w.code}] ${w.message}`);
  return (
    "<system-reminder>\n" +
    "[nexus-routing-guard] Model routing divergence detected between the " +
    "Nexus-configured agents and what this OpenCode instance can actually " +
    "serve. Report this to the user verbatim before proceeding:\n" +
    lines.join("\n") +
    "\n" +
    "Remediation: check the affected agent's model in opencode.json against " +
    "the provider catalog (`nexus pull` may need a re-run if this was fixed " +
    "on the Nexus side), or ensure the provider is configured in this " +
    "OpenCode instance.\n" +
    "</system-reminder>"
  );
}

function formatSystemPromptContext(warnings: RoutingWarning[]): string {
  const lines = warnings.map((w) => `- [${w.code}] ${w.message}`);
  return (
    "Nexus routing guard detected model routing divergence. Report this to " +
    "the user verbatim before proceeding with other work:\n" +
    lines.join("\n")
  );
}

// ---------------------------------------------------------------------------
// Plugin implementation
// ---------------------------------------------------------------------------

/**
 * Nexus Routing Guard
 *
 * Detects a mismatch between what Nexus wrote into a project's
 * `opencode.json` (agent -> provider/model routing) and what the running
 * OpenCode instance's merged provider catalog (global + project config)
 * can actually serve.
 *
 * The check reads the effective, post-resolution state directly from the
 * running server (`client.config.providers()`, `client.app.agents()`) — it
 * never parses or re-merges config files itself.
 *
 * Surfacing (no operator-visible warning primitive exists in the plugin
 * Hooks interface, so this is approximated):
 *   1. `client.app.log()` — always, for the audit trail.
 *   2. `experimental.chat.system.transform` — reliable delivery to the
 *      agent; the agent decides whether/how to relay it, so this alone is
 *      not deterministic from the operator's point of view.
 *   3. One-shot tool-output banner on the first tool call of the session —
 *      deterministic text the model cannot rephrase away. Fires once per
 *      session and never again, and only when there is something to report.
 *
 * The provider/agent query runs once per session (on the first tool call),
 * not cached for the lifetime of the instance, so a provider added or
 * fixed mid-instance is picked up by the next session without a restart.
 *
 * Never blocks or slows session start: any failure to reach the API is
 * swallowed and logged, never surfaced, never fatal.
 */
export const NexusRoutingGuard: Plugin = async (ctx) => {
  const { client, directory } = ctx;

  const enabled = process.env[ENV_ENABLED] !== "false";

  let checked = false;
  let bannerFiredThisSession = false;
  let cachedWarnings: RoutingWarning[] | null = null;

  fileLog(directory, "info", "=== Plugin initializing ===");
  fileLog(directory, "info", `Enabled: ${enabled}`);

  if (!enabled) {
    fileLog(directory, "info", `Disabled via ${ENV_ENABLED}=false`);
  }

  async function runCheck(): Promise<RoutingWarning[]> {
    if (checked && cachedWarnings) return cachedWarnings;
    checked = true;

    try {
      const providersRes = await client.config.providers();
      const agentsRes = await client.app.agents();

      const providers =
        (providersRes as { data?: ProviderCatalog }).data ??
        (providersRes as ProviderCatalog);
      const agents =
        (agentsRes as { data?: AgentInfo[] }).data ??
        (agentsRes as unknown as AgentInfo[]);

      const warnings = detectRoutingWarnings(providers, agents ?? []);
      cachedWarnings = warnings;

      if (warnings.length > 0) {
        fileLog(
          directory,
          "warn",
          `${warnings.length} routing warning(s): ${warnings.map((w) => `${w.agent}:${w.code}`).join(", ")}`,
        );
        await client.app.log({
          body: {
            service: PLUGIN_META.name,
            level: "warn",
            message: `Routing divergence: ${warnings.map((w) => w.message).join(" | ")}`,
          },
        });
      } else {
        fileLog(directory, "debug", "No routing divergence detected");
      }

      return warnings;
    } catch (err) {
      // Never let a check failure affect the session. Log and move on.
      fileLog(
        directory,
        "error",
        `Check failed, degrading silently: ${String(err)}`,
      );
      cachedWarnings = [];
      return [];
    }
  }

  return {
    // -----------------------------------------------------------------
    // experimental.chat.system.transform — reliable (best-effort) delivery
    // -----------------------------------------------------------------
    "experimental.chat.system.transform": async (_input, output) => {
      if (!enabled) return;
      const warnings = await runCheck();
      if (warnings.length === 0) return;
      output.system.push(formatSystemPromptContext(warnings));
    },

    // -----------------------------------------------------------------
    // tool.execute.after — one-shot deterministic banner
    // -----------------------------------------------------------------
    "tool.execute.after": async (_input, output) => {
      if (!enabled) return;
      if (bannerFiredThisSession) return;

      const warnings = await runCheck();
      if (warnings.length === 0) {
        // Silent when clean — no confirmation banner, ever.
        bannerFiredThisSession = true;
        return;
      }

      bannerFiredThisSession = true;
      fileLog(
        directory,
        "info",
        `Injecting one-shot routing banner (${warnings.length} warning(s))`,
      );

      const raw = output as Record<string, unknown>;
      const banner = formatBanner(warnings);
      if (typeof raw.output === "string") {
        raw.output = raw.output + "\n\n" + banner;
      } else if (Array.isArray(raw.content)) {
        raw.content.push({ type: "text", text: "\n\n" + banner });
      }
    },
  };
};
