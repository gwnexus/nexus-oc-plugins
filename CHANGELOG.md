# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-07-07

### Changed
- **`nexus-headroom-intercept` v0.3.0** — bug fixes and policy improvements
  - **Fix:** `getNexusConfig` read `private_token` from `credentials.toml` but
    the actual key is `token`; project-gate preflight was always bypassed
  - **Fix:** `compressReferenceData` had no handling for single-entity `kb_get`
    responses (ADR, Task, Session, ingest_item) — produced near-empty output
    (ratio ~0.01). Added four shape branches: memory-dump (A), document-wrapper
    with excerpt (B), generic entity (C), unknown-structure fallback (D)
  - **Threshold:** `nexus_kb_search` `minTokens` 3000 → 800 (search results
    typically 700–900 tokens; threshold was never triggered)
  - **Threshold:** `nexus_dispatch_sweep` `minTokens` 2000 → 500 (sweep
    responses are rarely large; meaningful payloads should still compress)
  - **Policies:** Added explicit `passthrough` for all Nexus write operations
    (`session_create/append/close`, `task_create/update/note`, `adr_create/
    submit/decide`, `doc_ingest/classify`, `dispatch_create/reply/resolve/close`)
  - **Logging:** Removed per-call debug traces (`HOOK_CALLED`, `EXTRACT`,
    full EVENT dumps) that generated 100 KB+ log files per session; kept only
    TRANSFORM/OBSERVE/FAIL entries and the session-idle summary

## [1.2.1] - 2026-07-07

### Changed
- **`nexus-headroom-intercept` v0.2.0** — project-context gate via Nexus preflight API
  - Plugin now reads `project_id` from `.nexus/AGENTS.md` YAML frontmatter
  - Queries `/api/projects/{id}/preflight` to check if `headroom` is in the
    project's plugin list before activating transform mode
  - If `headroom` is not enabled for the project: forces observe-only mode
  - Falls back to configured mode when preflight API is unreachable or credentials
    are unavailable — no silent failures

## [1.2.0] - 2026-07-07

### Added
- **`nexus-headroom-intercept` v0.1.0** (`300-headroom-intercept/`) — pre-injection
  context compression for Nexus MCP tool outputs
  - Uses `tool.execute.after` hook to intercept large MCP tool responses before
    they enter the agent context window
  - Policy-based deterministic compression (no LLM summarization)
  - Three compression profiles: reference-data, structured-list, search-results
  - In-memory + disk cache for original content storage and retrieval
  - Observe and transform modes with fail-open behavior
  - File-based activity log at `.nexus/headroom-intercept.log`
  - Ref: ADR-0060

### Changed
- Root README updated to include `nexus-headroom-intercept` in the plugin table

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
