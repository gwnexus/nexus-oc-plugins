# Nexus OpenCode Plugins

A collection of [OpenCode](https://opencode.ai) plugins for the [Gatewarden Nexus](https://nexus.gatewarden.eu) platform.

These plugins extend OpenCode with Nexus platform integration — session tracking, context preservation across compaction events, and project knowledge coordination.

## Plugins

| Plugin | Directory | Description |
| --- | --- | --- |
| **Compaction Plus** | [`100-compaction-plus`](./100-compaction-plus) | Preserves Nexus session context across OpenCode compaction events |

## Installation

Each plugin can be installed independently. See the individual plugin README for installation instructions.

**General approach:**

1. Copy the plugin file to `.opencode/plugins/` in your project
2. Ensure `@opencode-ai/plugin` is declared in `.opencode/package.json`
3. Set the required environment variables (`NEXUS_API_URL`, `NEXUS_PRIVATE_TOKEN`)
4. Restart OpenCode

## Requirements

- [OpenCode](https://opencode.ai) v1.14+ with plugin support
- A Nexus platform account with MCP access configured
- `NEXUS_API_URL` and `NEXUS_PRIVATE_TOKEN` environment variables

## License

MIT — see [LICENSE](./LICENSE)
