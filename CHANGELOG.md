# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-05-30

### Added
- **`nexus-cost-control` v1.0.0** (`200-cost-control/`) — Nexus-aware wrapper and
  extender for [Helicone](https://helicone.ai)
  - Tracks token usage (input / output / cache) and estimated cost in USD per session
  - On `session.idle`: queries Helicone API and appends a structured cost summary
    to the Nexus session timeline (debounced: 5 min)
  - `nexus_cost_summary` tool for on-demand live cost snapshots
  - `nexus_show_plugins` tool showing Nexus + Helicone connection status
  - Reads `HELICONE_API_KEY` from env or `~/.config/nexus/config.toml`
  - Graceful no-op when `HELICONE_API_KEY` is absent
  - Full README with Helicone proxy setup and `opencode.json` config examples

### Changed
- Root README updated to include `nexus-cost-control` in the plugin table
- `nexus-cost-control` and `nexus-compaction-plus` are now pre-selected as
  recommended plugins in the Nexus project wizard

## [1.0.0] - 2026-05-27

### Added
- **`nexus-compaction-plus` v1.8.0** (`100-compaction-plus/`) — initial public release
  - Preserves Nexus session context across OpenCode compaction events
  - Pre-compaction hook (`experimental.session.compacting`): injects active session
    ID, project ID, open tasks, ADRs, and directives into the compaction prompt
  - Post-compaction hook (`session.compacted` + `message.updated`): appends a
    compaction entry with the LLM-generated summary to the Nexus session timeline
  - `nexus_show_plugins` tool showing plugin version and API connection status
  - Auto-discovers Nexus credentials from env or `~/.config/nexus/`
  - File-based debug log at `.nexus/compaction-plus.log`
