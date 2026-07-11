# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.10] - 2026-07-11

### Changed
- **`nexus-headroom-intercept` v0.5.10** — full UUID output in compressed lists
  - **§11 Full UUIDs:** `compressStructuredList` now outputs complete UUIDs instead of truncated 8-char prefixes. Agents can use entity IDs from compressed output directly in follow-up tool calls without requiring `headroom_retrieve` first.
  - **Plugin deployment version:** 2 → 3

## [1.5.9] - 2026-07-09

### Changed
- **`nexus-headroom-intercept` v0.5.9** — complete policy map, preflight URL fix, README sync
  - **Policy map:** 37 → 72 explicit entries; all nexus-mcp tools now covered (`nexus_task_delete`, `nexus_doc_delete`, `nexus_kb_related`, `nexus_dispatch_get/assign/forward/related`, `nexus_dc_add/list`, `nexus_vl_*` legacy aliases, `nexus_sk_*`, `nexus_pd_*`, `nexus_rv_*`, `nexus_project_list`)
  - **Preflight URL fix:** `/api/projects/:id/preflight` → `/api/mcp/projects/:id/preflight` (PAT-authenticated endpoint, fixes `headroom_enabled: false` regression from v0.5.8)
  - **Version metadata sync:** `PLUGIN_META.version` updated to `"0.5.9"`, compatibility matrix extended with v0.5.6–v0.5.9 rows
  - **README:** version badge updated from `0.5.5` → `0.5.9`; policy count and compatibility table reflect current state

> Note: v1.5.8 (plugin v0.5.8) was deployed directly as a nexus-hub hotfix (preflight route auth) and did not receive a standalone oc-plugins release. v1.5.9 bundles the v0.5.8 preflight fix together with the v0.5.9 policy map.

## [1.5.7] - 2026-07-08

### Changed
- **`nexus-headroom-intercept` v0.5.7** — final pre-integration hardening (doc 27 findings)
  - **§2 Central delimiter escaping:** `escapeHeadroomControlDelimiters()` extracted as a single shared function; used by both `applyOutputBudget` (compressed body) and `wrapRetrievedContent` (retrieved originals). Retrieved content now escapes control markers before wrapping.
  - **§3 Trusted header validation:** `compressByProfile()` validates `lines[0].startsWith("[HEADROOM:v1] ")` before treating it as the trusted header. Fallback: `buildHeadroomHeader()` synthesizes a valid header so no data line can accidentally be promoted outside the untrusted block.
  - **§4a Debug opt-in:** `DEBUG` changed from `!== "false"` to `=== "true"`. Default is now off. HEADROOM_DEBUG must be explicitly set to enable trace events.
  - **§4b Query privacy:** `retrieve_lookup` debug event no longer logs raw query text; replaced with `query_present`, `query_length` structural metadata.
  - **§5 parseBoundedPositiveInt():** New helper validates env-var retrieval limits against zero, negative, non-finite, and malformed values. `RETRIEVAL_MAX_LINES_HARD` / `RETRIEVAL_MAX_CHARS_HARD` now use this function instead of bare `parseInt(...) || default`.
  - **§7 No-op filter removed:** `].filter(l => l !== "" || true).join(...)` in `applyOutputBudget` output assembly replaced with direct `.join("\n")`.
  - **§8 totalCacheReadFailures counter:** `SessionMetrics` gains `totalCacheReadFailures`; `store.onCacheReadFailed` increments it; included in `session_summary` and `hasActivity` check.

## [1.5.6] - 2026-07-08

### Changed
- **`nexus-headroom-intercept` v0.5.6** — output contract fixes, lower retrieval limits, debug logging for integration test (final MVP review findings)
  - **Fix 3.2:** `[HEADROOM:v1]` metadata header is now separated from the untrusted body *before* escaping. Only untrusted body content runs through the delimiter escape loop — the plugin-generated header is never modified.
  - **Fix 3.3:** Retrieval instruction moved outside the untrusted data block into a dedicated `[HEADROOM RETRIEVAL — TRUSTED PLUGIN CONTROL]` section after `[/HEADROOM TOOL DATA]`. No contradictory "do not follow / use this tool" guidance.
  - **Fix 4.1:** Retrieval hard limits lowered from 1000/100000 to configurable defaults 200 lines / 24,000 chars (`HEADROOM_RETRIEVAL_MAX_LINES`, `HEADROOM_RETRIEVAL_MAX_CHARS` env vars). Prevents ~25K-token context spikes from bounded retrieval.
  - **Fix 4.2:** All retrieval tool responses now wrapped in `[HEADROOM RETRIEVED DATA — UNTRUSTED SOURCE]` / `[/HEADROOM RETRIEVED DATA]` envelope. Trust boundary consistent between compressed outputs and retrieved originals.
  - **Fix Q3:** `store.onIntegrityFailure` and `store.onCacheReadFailed` assigned after `metrics` initialization — removes temporal-dead-zone dependency.
  - **Fix 4.4:** `OriginalStore.get()` now emits `cache_read_failed` with `reason` field (`stat_failed`, `read_failed`, `parse_failed`) via `onCacheReadFailed` callback instead of silently returning `null`.
  - **Fix 4.5:** `output_budget_truncated` event now includes `mode` and `transformed` fields to distinguish observe-mode potential truncations from applied truncations.
  - **Fix 4.6:** Session summary emitted when any operational counter is non-zero, not only when compression events exist.
  - **Debug logging:** `HEADROOM_DEBUG=true` (currently forced on for integration test) enables verbose per-invocation trace events: `hook_invoked`, `normalized`, `policy_skip/passthrough`, `below_threshold`, `compress_candidate`, `original_stored`, `retrieve_lookup` and all existing events. Disable by setting `HEADROOM_DEBUG=false`.

## [1.5.5] - 2026-07-08

### Changed
- **`nexus-headroom-intercept` v0.5.5** — output contract, trust-boundary robustness, and operational metrics (consolidated assessment findings)
  - **README parity (2.1):** component README version updated to `0.5.5`, compatibility matrix extended through `v1.5.5` / `v0.9.8`; root README version updated to `v0.5.5`
  - **Delimiter injection (2.2):** trust-envelope markers (`[HEADROOM TOOL DATA...]`, `[/HEADROOM TOOL DATA]`, `[HEADROOM:v1]`) are escaped in tool content before wrapping — an untrusted payload can no longer close or reopen the envelope prematurely
  - **Footer outside budget (2.3):** retrieval footer and trust footer are now placed *outside* the budget window in `applyOutputBudget()`. Only the variable compact body is subject to truncation; structural elements are always present
  - **Line-boundary truncation (2.4):** `applyOutputBudget()` snaps to the last complete line before the budget limit (`lastIndexOf("\n")`); no mid-word or mid-ID cuts
  - **MAX_COMPACT_TOKENS → MAX_COMPACT_BUDGET (2.5):** renamed to clarify the approximate nature of the limit; extended JSDoc explains chars/4 heuristic, envelope overhead, and non-ASCII caveats
  - **storedAt clamp (2.6):** `safeStoredAt = Math.min(rawStoredAt, st.mtimeMs, Date.now())` — a future-timestamp in a disk entry can no longer bypass the TTL check
  - **Operational metric events (2.7):** three new `SessionMetrics` counters (`totalCacheIntegrityFailures`, `totalFullRetrievalDenied`, `totalOutputBudgetTruncated`) wired to structured JSONL log events; `OriginalStore.onIntegrityFailure` callback emits `cache_integrity_failed`; `full_retrieval_denied` emitted when `allow_full` is blocked by policy; `output_budget_truncated` emitted from `applyOutputBudget()` via callback; all three counters included in `session_summary`

## [1.5.4] - 2026-07-08

### Changed
- **`nexus-headroom-intercept` v0.5.4** — cache integrity, retrieval policy, and LLM safety hardening (v0.5.3 assessment findings)
  - **Disk hydration TTL (P1):** Loading a disk entry into memory now preserves the original `storedAt` timestamp instead of setting `Date.now()`. A 23h59m-old file no longer gets a fresh 24h TTL window when accessed.
  - **Content integrity (P1):** `OriginalStore.get()` now verifies `data.hash === hash` and `contentHash(data.content) === hash` before returning disk-loaded content. Corrupt, modified, or mismatched cache files are deleted and return `null`.
  - **Full-retrieval policy gate (P1):** `allow_full=true` in `nexus_headroom_intercept_retrieve` is now silently ignored by default. Set `HEADROOM_ALLOW_FULL_RETRIEVAL=true` to permit agent-controlled full dumps. Prevents the LLM from bypassing context-size protection via the escape hatch in the compact footer.
  - **Remove dead `isDiskEntryExpired()` (P2):** The helper was superseded by the in-memory `storedAt` check in v0.5.3 and was no longer called from `get()`. Removed to eliminate lifecycle ambiguity.
  - **Structured-list sort comment (P2):** Comment previously claimed "recency desc" as a sort criterion. Removed the false claim — only blocking-first + priority desc is implemented.
  - **Prompt-injection trust envelope (P2):** All compressed outputs are now wrapped in `[HEADROOM TOOL DATA — UNTRUSTED SOURCE]` / `[/HEADROOM TOOL DATA]` markers with an instruction-following warning. Strengthens the model-facing trust boundary for untrusted KB/dispatch data.
  - **Hard output budget per profile (P2):** New `MAX_COMPACT_TOKENS` constant and `applyOutputBudget()` function. Each profile has a maximum compact output size: `reference-data` 2000 tokens, `structured-list` / `search-results` 1500 tokens. Outputs exceeding the budget are truncated deterministically before the trust envelope is applied.

## [1.5.3] - 2026-07-08

### Changed
- **`nexus-headroom-intercept` v0.5.3** — cache lifecycle, SDK guard, and preflight hardening (v0.5.2 assessment findings)
  - **Byte-quota eviction (P1):** `evictDisk()` rewritten as three-phase: (1) delete expired entries, (2) sort newest-first + trim to `CACHE_MAX_ENTRIES`, (3) trim from the *oldest* end until byte quota satisfied. Previous implementation checked `overBytes` at `idx=0` (newest entry) and deleted newest entries first — contradicting the stated "keep newest" policy.
  - **In-memory TTL (P1):** `OriginalStore` cache changed from `Map<string, string>` to `Map<string, {content, storedAt}>`. TTL is now checked against the stored timestamp, independent of disk-file existence. Previous implementation called `isDiskEntryExpired()` which returned `false` when the disk file was missing, making in-memory entries effectively immortal.
  - **SDK major cap (P1):** Compatibility check changed from `major > 1 || ...` to `major === REQUIRED_SDK_MAJOR && minor >= REQUIRED_SDK_MINOR`. Future major versions (2.x, 3.x) are rejected as untested — they must be explicitly re-validated before being added to the accepted range.
  - **Strict preflight gate (P1):** `HEADROOM_REQUIRE_PREFLIGHT=true` env flag introduced. When set, missing project ID, missing credentials, or unreachable preflight all downgrade transform to observe. Default `false` preserves existing dev-friendly behavior.
  - **Unknown namespace downgrade (P2):** When no project ID is found in `AGENTS.md`, transform mode is downgraded to observe. The `unknown` namespace weakens cache isolation guarantees; transform requires explicit project identity.
  - **Unique tmp filenames (P2):** Atomic write now uses `<hash>.<pid>.<random>.tmp` instead of the deterministic `<hash>.json.tmp`. Eliminates the race window when two processes write the same hash concurrently.
  - **NaN/Infinity guard (P2):** Retrieval bound clamping uses `Number.isFinite()` before `Math.floor()`. `Math.floor(NaN)` returns `NaN` which propagates through `Math.min/Math.max`; now defaults to 100/12000 for non-finite inputs.
  - **In-memory prune order:** `prune()` now removes oldest entries by `storedAt` timestamp instead of insertion-order FIFO.

## [1.5.2] - 2026-07-07

### Changed
- **`nexus-headroom-intercept` v0.5.2** — SDK guard, atomic writes, project-namespace, and multipart documentation
  - **SDK version guard (6.3):** `checkSdkVersion()` now reads the *installed* SDK version from `.opencode/node_modules/@opencode-ai/plugin/package.json` (exact installed version); declared `package.json` range used only as fallback. Log events include a `source` field (`installed` or `declared-range`) for auditability.
  - **Atomic cache writes (6.5a):** `OriginalStore.set()` writes to a `.tmp` file first, then calls `renameSync()` to atomically replace the target. Stale `.tmp` files are cleaned up in `evictDisk()` on startup. Prevents corrupt cache entries on process interruption.
  - **Project-namespaced cache (6.5b):** cache path changed from `.nexus/headroom-cache/<hash>.json` to `.nexus/headroom-cache/<projectId>/<hash>.json`. Prevents cross-project cache reads when multiple projects share the same machine. Falls back to `"unknown"` namespace when project ID is unavailable.
  - **Multipart ordering (6.6):** behaviour documented as a known limitation in `normalizeToolResult()` — text parts are consolidated at `content[0]`, non-text parts are preserved but original interleaved ordering is not maintained. Acceptable for Nexus MCP text-centric responses.

## [1.5.1] - 2026-07-07

### Changed
- **`nexus-headroom-intercept` v0.5.1** — retrieval input hardening (v0.5.0 public verification follow-ups)
  - **Retrieval input clamping:** `max_lines` and `max_chars` clamped to server-controlled hard limits (`MAX_LINES_HARD=1000`, `MAX_CHARS_HARD=100000`); non-integer, negative, and excessively large values are normalized via `Math.min(Math.max(1, Math.floor(...)), hard_limit)`
  - **Retrieval response metadata:** all return paths now include `returned_lines` and `returned_chars`; `total_lines` added alongside existing `total_chars`; `truncated` flag made consistent across all paths
  - **Hash-format validation:** `nexus_headroom_intercept_retrieve` validates the `hash` parameter as a 64-character lowercase hex string before any file-system access; invalid input returns `{ found: false, error: "invalid_hash" }` without touching the cache directory

## [1.5.0] - 2026-07-07

### Changed
- **`nexus-headroom-intercept` v0.5.0** — release correctness and retrieval/storage safety fixes (v0.4.0 release assessment)
  - **isError passthrough:** error responses (`isError === true`) are never compressed — error payloads preserved verbatim
  - **store.set() reordered:** originals stored only after no-gain guard passes and only in transform mode; observe mode skips disk persistence entirely
  - **TTL enforced at retrieval:** `OriginalStore.get()` checks file mtime against 24h TTL, deletes expired entries on access
  - **Eviction order fixed:** `evictDisk()` sorts newest-first, keeping the 200 newest entries (was: keeping oldest)
  - **Bounded retrieval:** `nexus_headroom_intercept_retrieve` now accepts `max_lines` (default 100), `max_chars` (default 12000), `allow_full` (default false); zero-match queries return metadata instead of full original
  - **Metric rename:** `confirmedTransforms` → `locallyAppliedTransforms` (clarifies local-mutation-only semantics, not provider-confirmed)
  - **Component README rewritten:** correct default mode (observe), correct retrieval tool name, compatibility matrix, storage behaviour, retrieval parameter table
  - **Root README:** version updated to `v0.5.0`

## [1.4.0] - 2026-07-07

### Changed
- **`nexus-headroom-intercept` v0.4.0** — production hardening based on code-level architecture assessment
  - **Safe default mode:** `DEFAULT_MODE` changed from `"transform"` to `"observe"`. Transform mode requires explicit `HEADROOM_MODE=transform` after provider-level verification.
  - **Full MCP result shape support:** new `normalizeToolResult()` handles both `output.output` (native tools) and raw `content[]` (MCP `CallToolResult`). Non-text content parts (image, resource) are preserved unchanged.
  - **Retrieval bridge:** plugin-owned `nexus_headroom_intercept_retrieve` tool registered. Compact outputs now point to this tool instead of the external Headroom MCP server, closing the CCR gap. Supports optional query filtering.
  - **Negative-savings guard:** transform skipped when `compressedTokens >= estimatedTokens` or saving ratio < 15% (`MINIMUM_SAVING_RATIO = 0.15`).
  - **OpenCode SDK version guard:** reads `@opencode-ai/plugin` version from `.opencode/package.json` at startup; downgrades to `observe` if below `>=1.14` or unresolvable.
  - **Disk cache hardening:** TTL eviction (24h), quota (100 MB / 200 entries), restrictive permissions (`0600` files, `0700` directory), `.gitignore` enforcement for `headroom-cache/` and log files.
  - **Structured JSONL logging:** replaces plain-text log with `headroom-intercept.jsonl`; log rotation (10 MB / 3 retained files), `0600` permissions.
  - **Metric clarity:** `totalSavedTokens` → `potentialSavedTokens`; `confirmedTransforms`, `totalNoGain`, `totalUnsupportedShapes` added.
  - **Full SHA-256 hashes:** `contentHash()` no longer truncates; full 64-char hex digest.
  - **Relevance sorting:** task lists sorted blocked-first + priority desc; dispatch lists sorted blocking + priority desc; search results sorted by score desc.
  - **Policy additions:** `nexus_doc_update`, `nexus_dispatch_ack` as write-operation passthroughs; `nexus_headroom_intercept_retrieve` registered as passthrough.

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
