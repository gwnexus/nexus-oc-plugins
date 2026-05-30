# Nexus OpenCode Plugins

A collection of [OpenCode](https://opencode.ai) plugins for the [Gatewarden Nexus](https://nexus.gatewarden.eu) platform.

These plugins extend OpenCode with Nexus platform integration — session tracking, context preservation across compaction events, token usage and cost visibility, and project knowledge coordination.

## Plugins

| Plugin | Directory | Version | Description |
| --- | --- | --- | --- |
| **Compaction Plus** | [`100-compaction-plus`](./100-compaction-plus) | v1.8.0 | Preserves Nexus session context across OpenCode compaction events |
| **Cost Control** | [`200-cost-control`](./200-cost-control) | v1.0.0 | Token usage and cost tracking via Helicone; records per-session cost summaries in the Nexus timeline |

## Installation

Each plugin can be installed independently. See the individual plugin README for installation instructions.

**General approach:**

1. Copy the plugin file to `.opencode/plugins/` in your project
2. Ensure `@opencode-ai/plugin` is declared in `.opencode/package.json`
3. Set the required environment variables (`NEXUS_API_URL`, `NEXUS_PRIVATE_TOKEN`)
4. Restart OpenCode

When using `nexus init` or `nexus pull`, recommended plugins are downloaded automatically based on your project wizard selection — no manual copy needed.

## Requirements

- [OpenCode](https://opencode.ai) v1.14+ with plugin support
- A Nexus platform account with MCP access configured
- `NEXUS_API_URL` and `NEXUS_PRIVATE_TOKEN` environment variables
- `HELICONE_API_KEY` for `nexus-cost-control` (optional but recommended)

## License

MIT — see [LICENSE](./LICENSE)
