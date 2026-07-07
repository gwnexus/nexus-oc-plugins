import { type Plugin } from "@opencode-ai/plugin"
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  appendFileSync,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
  chmodSync,
} from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"

/**
 * Plugin metadata — single source of truth for name/version.
 *
 * Version: 0.5.1
 * Changes from 0.5.0:
 *   - Fix 6.4a: max_lines/max_chars clamped to server-controlled hard limits (1-1000 / 1-100000)
 *   - Fix 6.4b: all retrieval responses include returned_lines and returned_chars metadata
 *   - Fix 6.5: hash input validated as 64-char hex before any file-system access
 */
const PLUGIN_META = {
  name: "nexus-headroom-intercept",
  version: "0.5.1",
  description:
    "Pre-injection context compression for Nexus MCP tool outputs. " +
    "Uses the tool.execute.after hook to apply policy-based deterministic " +
    "compression before tool results enter the agent context window.",
} as const

// Minimum SDK version required for reliable tool.execute.after MCP output mutation.
const REQUIRED_SDK_MAJOR = 1
const REQUIRED_SDK_MINOR = 14

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PolicyAction = "compress" | "passthrough" | "skip"
type CompressionProfile = "reference-data" | "structured-list" | "search-results"

/**
 * Normalised representation of a tool result, regardless of whether it came
 * from a native tool (output.output: string) or an MCP tool (content[]).
 */
interface NormalizedToolResult {
  /** Concatenated text content — used for compression. */
  text: string
  /** Apply a replacement string back to the original output object. */
  apply: (replacement: string) => void
  /** Whether this shape is supported for mutation. */
  supported: boolean
  /** Identifies which branch handled this result. */
  sourceShape: "normalized-output" | "mcp-content" | "unknown"
}

interface ToolOutput {
  title?: string
  output?: string
  metadata?: unknown
  content?: Array<{ text?: string; type?: string; [key: string]: unknown }>
  attachments?: unknown
  isError?: boolean
}

interface Policy {
  action: PolicyAction
  profile?: CompressionProfile
  minTokens?: number
  minItems?: number
  reason?: string
}

interface CompressionEvent {
  tool: string
  originalChars: number
  originalEstimatedTokens: number
  compressedChars: number
  compressedEstimatedTokens: number
  potentialSavedTokens: number
  compressionRatio: number
  profile: string
  contentHash: string
  sourceShape: string
  transformed: boolean
  timestamp: number
}

interface SessionMetrics {
  totalCompressions: number
  totalObservations: number
  totalSkips: number
  totalPassthroughs: number
  totalNoGain: number
  totalUnsupportedShapes: number
  potentialSavedTokens: number
  /** Local object mutations that completed without error — NOT provider-confirmed. */
  locallyAppliedTransforms: number
  events: CompressionEvent[]
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Plugin mode:
 * - "observe": log metrics and classify outputs — no mutation (default, safe)
 * - "transform": apply compression and mutate output — requires verified OpenCode version
 *
 * Enable transform mode explicitly: HEADROOM_MODE=transform
 */
type PluginMode = "observe" | "transform"

const DEFAULT_MODE: PluginMode = "observe"
const DEFAULT_MIN_TOKENS = 2000
const CHARS_PER_TOKEN = 4
const MINIMUM_SAVING_RATIO = 0.15  // Skip transform if saving < 15%

// Disk cache controls
const CACHE_TTL_MS = 24 * 60 * 60 * 1000   // 24 hours
const CACHE_MAX_BYTES = 100 * 1024 * 1024   // 100 MB
const CACHE_MAX_ENTRIES = 200
const LOG_MAX_BYTES = 10 * 1024 * 1024      // 10 MB per log file
const LOG_RETAINED_FILES = 3

const POLICIES: Record<string, Policy> = {
  // Nexus knowledge tools — high volume, mostly reference data
  nexus_kb_memory: { action: "compress", profile: "reference-data", minTokens: 2000 },
  nexus_kb_search: { action: "compress", profile: "search-results", minTokens: 800 },
  nexus_kb_get: { action: "compress", profile: "reference-data", minTokens: 3000 },

  // Nexus coordination tools — structured list responses
  nexus_dispatch_sweep: { action: "compress", profile: "structured-list", minTokens: 500 },
  nexus_dispatch_inbox: { action: "compress", profile: "structured-list", minTokens: 2000 },
  nexus_dispatch_outbox: { action: "compress", profile: "structured-list", minTokens: 2000 },
  nexus_doc_list: { action: "compress", profile: "structured-list", minTokens: 2000 },
  nexus_task_list: { action: "compress", profile: "structured-list", minTokens: 2000 },

  // session_list rarely exceeds threshold
  nexus_session_list: { action: "passthrough", reason: "small-response" },

  // Write operations — never compress
  nexus_session_create: { action: "passthrough", reason: "write-operation" },
  nexus_session_append: { action: "passthrough", reason: "write-operation" },
  nexus_session_close: { action: "passthrough", reason: "write-operation" },
  nexus_task_create: { action: "passthrough", reason: "write-operation" },
  nexus_task_update: { action: "passthrough", reason: "write-operation" },
  nexus_task_note: { action: "passthrough", reason: "write-operation" },
  nexus_adr_create: { action: "passthrough", reason: "write-operation" },
  nexus_adr_submit: { action: "passthrough", reason: "write-operation" },
  nexus_adr_decide: { action: "passthrough", reason: "write-operation" },
  nexus_doc_ingest: { action: "passthrough", reason: "write-operation" },
  nexus_doc_classify: { action: "passthrough", reason: "write-operation" },
  nexus_doc_update: { action: "passthrough", reason: "write-operation" },
  nexus_dispatch_create: { action: "passthrough", reason: "write-operation" },
  nexus_dispatch_reply: { action: "passthrough", reason: "write-operation" },
  nexus_dispatch_resolve: { action: "passthrough", reason: "write-operation" },
  nexus_dispatch_close: { action: "passthrough", reason: "write-operation" },
  nexus_dispatch_ack: { action: "passthrough", reason: "write-operation" },

  // Retrieval — never compress, must be passed through verbatim
  nexus_headroom_retrieve: { action: "passthrough", reason: "explicit-detail-request" },
  headroom_retrieve: { action: "passthrough", reason: "explicit-detail-request" },
  headroom_headroom_retrieve: { action: "passthrough", reason: "explicit-detail-request" },
  // Plugin-owned retrieval tool must also passthrough (handled separately below)
  nexus_headroom_intercept_retrieve: { action: "passthrough", reason: "plugin-retrieval-tool" },

  // Shell — handled by RTK
  bash: { action: "skip", reason: "handled-by-rtk" },
  shell: { action: "skip", reason: "handled-by-rtk" },

  // Active editing context — never compress
  read: { action: "skip", reason: "active-editing-context" },
  write: { action: "skip", reason: "active-editing-context" },
  edit: { action: "skip", reason: "active-editing-context" },
  glob: { action: "skip", reason: "file-search" },
  grep: { action: "skip", reason: "code-search" },
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function contentHash(text: string): string {
  // Full SHA-256 — no truncation (per assessment finding 18)
  return createHash("sha256").update(text).digest("hex")
}

function tryParseJson(text: string): unknown | null {
  try { return JSON.parse(text) } catch { return null }
}

// ---------------------------------------------------------------------------
// NormalizedToolResult — Fix 3: full content[] shape + non-text preservation
// ---------------------------------------------------------------------------

function normalizeToolResult(output: unknown): NormalizedToolResult {
  // Shape A: normalized OpenCode result — { output: string }
  if (
    output &&
    typeof output === "object" &&
    typeof (output as any).output === "string" &&
    (output as any).output.length > 0
  ) {
    return {
      text: (output as any).output,
      apply(replacement: string) {
        (output as any).output = replacement
      },
      supported: true,
      sourceShape: "normalized-output",
    }
  }

  // Shape B: raw MCP CallToolResult — { content: Array<{ type, text, ... }> }
  if (
    output &&
    typeof output === "object" &&
    Array.isArray((output as any).content)
  ) {
    const result = output as any
    const textParts: any[] = result.content.filter(
      (part: any) => part?.type === "text" && typeof part.text === "string"
    )
    const nonTextParts: any[] = result.content.filter(
      (part: any) => !(part?.type === "text" && typeof part.text === "string")
    )

    return {
      text: textParts.map((p: any) => p.text).join("\n"),
      apply(replacement: string) {
        // Replace all text parts with the compact result, preserve non-text parts
        result.content = [
          { type: "text", text: replacement },
          ...nonTextParts,
        ]
      },
      supported: textParts.length > 0,
      sourceShape: "mcp-content",
    }
  }

  return {
    text: "",
    apply() {},
    supported: false,
    sourceShape: "unknown",
  }
}

// ---------------------------------------------------------------------------
// Structured JSONL logger — Fix 7
// ---------------------------------------------------------------------------

class StructuredLogger {
  private logFile: string
  private logDir: string

  constructor(projectDir: string) {
    this.logDir = join(projectDir, ".nexus")
    this.logFile = join(this.logDir, "headroom-intercept.jsonl")
  }

  log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
    try {
      mkdirSync(this.logDir, { recursive: true })
      this.rotateIfNeeded()
      const entry = JSON.stringify({
        ts: new Date().toISOString(),
        service: PLUGIN_META.name,
        v: PLUGIN_META.version,
        level,
        event,
        ...fields,
      })
      appendFileSync(this.logFile, entry + "\n")
      try { chmodSync(this.logFile, 0o600) } catch {}
    } catch {
      // Silent — logging must never break the plugin
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.logFile)) return
      const size = statSync(this.logFile).size
      if (size < LOG_MAX_BYTES) return

      // Rotate: shift existing rotated files
      for (let i = LOG_RETAINED_FILES - 1; i >= 1; i--) {
        const older = `${this.logFile}.${i}`
        const newer = i === 1 ? this.logFile : `${this.logFile}.${i - 1}`
        try {
          if (existsSync(newer)) writeFileSync(older, readFileSync(newer))
        } catch {}
      }
      // Truncate current log
      writeFileSync(this.logFile, "")
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// OriginalStore — Fix 6: TTL eviction, quota, permissions, .gitignore
// ---------------------------------------------------------------------------

class OriginalStore {
  private cache = new Map<string, string>()
  private cacheDir: string
  private projectDir: string

  constructor(projectDir: string) {
    this.projectDir = projectDir
    this.cacheDir = join(projectDir, ".nexus", "headroom-cache")
    try {
      mkdirSync(this.cacheDir, { recursive: true })
      chmodSync(this.cacheDir, 0o700)
      this.ensureGitignore()
    } catch {}
  }

  private ensureGitignore(): void {
    try {
      const gi = join(this.projectDir, ".nexus", ".gitignore")
      if (!existsSync(gi)) {
        writeFileSync(gi, "headroom-cache/\nheadroom-intercept.jsonl*\n")
        chmodSync(gi, 0o644)
      } else {
        const content = readFileSync(gi, "utf-8")
        const lines: string[] = []
        if (!content.includes("headroom-cache/")) lines.push("headroom-cache/")
        if (!content.includes("headroom-intercept.jsonl")) lines.push("headroom-intercept.jsonl*")
        if (lines.length > 0) appendFileSync(gi, "\n" + lines.join("\n") + "\n")
      }
    } catch {}
  }

  set(hash: string, content: string): void {
    this.cache.set(hash, content)
    try {
      const filePath = join(this.cacheDir, `${hash}.json`)
      writeFileSync(filePath, JSON.stringify({
        hash,
        length: content.length,
        estimatedTokens: estimateTokens(content),
        storedAt: new Date().toISOString(),
        content,
      }))
      chmodSync(filePath, 0o600)
    } catch {}
  }

  get(hash: string): string | null {
    // Check in-memory first, but still validate TTL
    const cached = this.cache.get(hash)
    if (cached !== undefined) {
      // Validate against disk entry's storedAt for TTL
      const expired = this.isDiskEntryExpired(hash)
      if (expired) {
        this.cache.delete(hash)
        this.deleteDiskEntry(hash)
        return null
      }
      return cached
    }
    // Disk fallback with TTL check
    try {
      const filePath = join(this.cacheDir, `${hash}.json`)
      if (!existsSync(filePath)) return null
      const st = statSync(filePath)
      if ((Date.now() - st.mtimeMs) > CACHE_TTL_MS) {
        this.deleteDiskEntry(hash)
        return null
      }
      const raw = readFileSync(filePath, "utf-8")
      const data = JSON.parse(raw)
      if (data?.content) {
        this.cache.set(hash, data.content)
        return data.content
      }
    } catch {}
    return null
  }

  private isDiskEntryExpired(hash: string): boolean {
    try {
      const filePath = join(this.cacheDir, `${hash}.json`)
      if (!existsSync(filePath)) return false
      return (Date.now() - statSync(filePath).mtimeMs) > CACHE_TTL_MS
    } catch { return false }
  }

  private deleteDiskEntry(hash: string): void {
    try { unlinkSync(join(this.cacheDir, `${hash}.json`)) } catch {}
  }

  /** Prune in-memory cache (FIFO, max 50 entries). */
  prune(maxEntries = 50): void {
    if (this.cache.size <= maxEntries) return
    const keys = Array.from(this.cache.keys())
    for (const key of keys.slice(0, keys.length - maxEntries)) {
      this.cache.delete(key)
    }
  }

  /** Evict disk entries older than TTL or exceeding quota. Keeps newest entries. */
  evictDisk(): void {
    try {
      const files = readdirSync(this.cacheDir).filter(f => f.endsWith(".json"))
      const now = Date.now()
      let totalBytes = 0
      const entries: { file: string; mtime: number; size: number }[] = []

      for (const f of files) {
        try {
          const fp = join(this.cacheDir, f)
          const st = statSync(fp)
          totalBytes += st.size
          entries.push({ file: fp, mtime: st.mtimeMs, size: st.size })
        } catch {}
      }

      // Sort newest-first — we want to keep the newest CACHE_MAX_ENTRIES
      entries.sort((a, b) => b.mtime - a.mtime)

      entries.forEach((entry, idx) => {
        const expired = (now - entry.mtime) > CACHE_TTL_MS
        // After keeping the first CACHE_MAX_ENTRIES newest entries,
        // delete the rest; also delete if quota is exceeded.
        const overCount = idx >= CACHE_MAX_ENTRIES
        const overBytes = totalBytes > CACHE_MAX_BYTES
        if (expired || overCount || overBytes) {
          try {
            unlinkSync(entry.file)
            totalBytes -= entry.size
          } catch {}
        }
      })
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Compression profiles
// ---------------------------------------------------------------------------

function compressByProfile(
  raw: string,
  profile: CompressionProfile,
  hash: string,
  tool: string,
): string {
  const parsed = tryParseJson(raw)
  switch (profile) {
    case "reference-data":  return compressReferenceData(raw, parsed, hash, tool)
    case "structured-list": return compressStructuredList(raw, parsed, hash, tool)
    case "search-results":  return compressSearchResults(raw, parsed, hash, tool)
    default:                return compressFallback(raw, hash, tool)
  }
}

function retrievalFooter(hash: string): string {
  return [
    `---`,
    `Full content available via plugin retrieval tool:`,
    `  nexus_headroom_intercept_retrieve(hash="${hash}")`,
    ``,
    `Or re-fetch from the source using the appropriate nexus_kb_* / nexus_dispatch_* tool.`,
  ].join("\n")
}

function compressReferenceData(raw: string, parsed: unknown, hash: string, tool: string): string {
  const originalTokens = estimateTokens(raw)
  const lines: string[] = []
  lines.push(`[HEADROOM:v1] tool=${tool} hash=${hash} original_tokens=${originalTokens}`)
  lines.push("")

  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>
    const memory = (obj as any).memory

    if (memory && typeof memory === "object") {
      if (obj.project_id) lines.push(`Project: ${obj.project_id}`)
      if (memory.project?.name) lines.push(`Project name: ${memory.project.name}`)
      if (Array.isArray((obj as any).categories_included)) {
        lines.push(`Categories: ${(obj as any).categories_included.join(", ")}`)
      }
      if ((obj as any).depth) lines.push(`Depth: ${(obj as any).depth}`)
      lines.push("")

      if (Array.isArray(memory.adrs)) {
        lines.push(`## ADRs (${memory.adrs.length})`)
        for (const adr of memory.adrs.slice(0, 10)) {
          lines.push(`- ADR-${adr.adr_number ?? "?"}: ${adr.title} [${adr.status ?? "?"}]`)
        }
        if (memory.adrs.length > 10) lines.push(`  ... and ${memory.adrs.length - 10} more`)
      }

      if (Array.isArray(memory.active_tasks)) {
        lines.push("")
        lines.push(`## Active Tasks (${memory.active_tasks.length})`)
        // Sort: blocked first, then by priority desc
        const sorted = [...memory.active_tasks].sort((a, b) => {
          if (a.status === "blocked" && b.status !== "blocked") return -1
          if (b.status === "blocked" && a.status !== "blocked") return 1
          const pOrder: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 }
          return (pOrder[a.priority] ?? 9) - (pOrder[b.priority] ?? 9)
        })
        for (const task of sorted) {
          lines.push(`- [${task.priority ?? "?"}/${task.status ?? "?"}] ${task.title}`)
          if (task.id) lines.push(`  id: ${task.id}`)
        }
      }

      if (Array.isArray(memory.recent_sessions)) {
        lines.push("")
        lines.push(`## Recent Sessions (${memory.recent_sessions.length})`)
        for (const s of memory.recent_sessions.slice(0, 5)) {
          lines.push(`- [${s.status ?? "?"}] ${s.title} (${s.created_at?.slice(0, 10) ?? "?"})`)
          if (s.id) lines.push(`  id: ${s.id}`)
        }
        if (memory.recent_sessions.length > 5)
          lines.push(`  ... and ${memory.recent_sessions.length - 5} more`)
      }

      if (Array.isArray(memory.open_letters) && memory.open_letters.length > 0) {
        lines.push("")
        lines.push(`## Open Dispatches (${memory.open_letters.length})`)
        for (const d of memory.open_letters.slice(0, 5))
          lines.push(`- ${d.title ?? d.subject ?? "untitled"} [${d.status ?? "?"}]`)
      }

      if (Array.isArray(memory.planning) && memory.planning.length > 0) {
        lines.push("")
        lines.push(`## Planning Items (${memory.planning.length})`)
        for (const p of memory.planning.slice(0, 5)) lines.push(`- ${p.title ?? "untitled"}`)
      }

      if (Array.isArray(memory.research) && memory.research.length > 0) {
        lines.push("")
        lines.push(`## Research Notes (${memory.research.length})`)
        for (const r of memory.research.slice(0, 5)) lines.push(`- ${r.title ?? "untitled"}`)
      }

    } else if (obj.entity_type && obj.document) {
      const doc = obj.document as Record<string, unknown>
      const etype = String(obj.entity_type)
      lines.push(`Entity type: ${etype}`)
      lines.push(`Entity id:   ${doc.id ?? obj.entity_id ?? "?"}`)
      if (doc.title)    lines.push(`Title:  ${doc.title}`)
      if (doc.status)   lines.push(`Status: ${doc.status}`)
      if (doc.adr_number) lines.push(`ADR:    ADR-${doc.adr_number}`)
      if (doc.priority) lines.push(`Priority: ${doc.priority}`)
      if (doc.project_id) lines.push(`Project: ${doc.project_id}`)
      if (doc.created_at) lines.push(`Created: ${String(doc.created_at).slice(0, 10)}`)

      const bodyField = (doc.context ?? doc.body ?? doc.description ?? doc.summary) as string | undefined
      if (typeof bodyField === "string" && bodyField.length > 0) {
        lines.push("")
        lines.push("Excerpt:")
        lines.push(`  ${bodyField.replace(/\n+/g, " ").slice(0, 400)}${bodyField.length > 400 ? "..." : ""}`)
      }

      if (etype === "decision") {
        if (typeof doc.decision === "string" && doc.decision.length > 0) {
          lines.push("")
          lines.push("Decision excerpt:")
          lines.push(`  ${doc.decision.replace(/\n+/g, " ").slice(0, 300)}${doc.decision.length > 300 ? "..." : ""}`)
        }
        if (doc.supersedes) lines.push(`Supersedes: ${doc.supersedes}`)
      }

    } else if (obj.id || obj.entity_id) {
      if (obj.entity_type) lines.push(`Entity type: ${obj.entity_type}`)
      if (obj.id)         lines.push(`id: ${obj.id}`)
      if (obj.title)      lines.push(`Title:  ${obj.title}`)
      if (obj.status)     lines.push(`Status: ${obj.status}`)
      if (obj.priority)   lines.push(`Priority: ${obj.priority}`)
      if (obj.project_id) lines.push(`Project: ${obj.project_id}`)
      if (obj.created_at) lines.push(`Created: ${String(obj.created_at).slice(0, 10)}`)

      const bodyField = (obj.body ?? obj.description ?? obj.summary ?? obj.context) as string | undefined
      if (typeof bodyField === "string" && bodyField.length > 0) {
        lines.push("")
        lines.push("Excerpt:")
        lines.push(`  ${bodyField.replace(/\n+/g, " ").slice(0, 400)}${bodyField.length > 400 ? "..." : ""}`)
      }

    } else {
      const keys = Object.keys(obj)
      lines.push(`JSON response with ${keys.length} fields: ${keys.slice(0, 15).join(", ")}`)
      lines.push("")
      for (const [key, val] of Object.entries(obj)) {
        if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
          lines.push(`  ${key}: ${val}`)
        }
      }
    }
  } else {
    const textLines = raw.split("\n")
    lines.push(`Text response (${textLines.length} lines)`)
    lines.push("")
    for (const l of textLines.slice(0, 20)) lines.push(l)
    if (textLines.length > 20) lines.push(`... ${textLines.length - 20} lines omitted`)
  }

  lines.push("")
  lines.push(retrievalFooter(hash))
  return lines.join("\n")
}

function compressStructuredList(raw: string, parsed: unknown, hash: string, tool: string): string {
  const originalTokens = estimateTokens(raw)
  const lines: string[] = []
  lines.push(`[HEADROOM:v1] tool=${tool} hash=${hash} original_tokens=${originalTokens}`)
  lines.push("")

  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>
    const listCandidates = ["sessions", "dispatches", "tasks", "documents", "items", "results", "letters"]
    let items: any[] | null = null
    let listKey = ""

    for (const key of listCandidates) {
      if (Array.isArray(obj[key])) { items = obj[key] as any[]; listKey = key; break }
    }
    if (!items) {
      for (const [key, val] of Object.entries(obj)) {
        if (Array.isArray(val) && val.length > 0) { items = val; listKey = key; break }
      }
    }

    if (items && items.length > 0) {
      lines.push(`${items.length} ${listKey} returned.`)
      lines.push("")

      const statusCounts: Record<string, number> = {}
      for (const item of items) {
        const s = item.status ?? item.state ?? "unknown"
        statusCounts[s] = (statusCounts[s] ?? 0) + 1
      }
      if (Object.keys(statusCounts).length > 1) {
        lines.push("Status summary:")
        for (const [status, count] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1]))
          lines.push(`  ${status}: ${count}`)
        lines.push("")
      }

      const prioCounts: Record<string, number> = {}
      for (const item of items) {
        if (item.priority) prioCounts[item.priority] = (prioCounts[item.priority] ?? 0) + 1
      }
      if (Object.keys(prioCounts).length > 1) {
        lines.push("Priority summary:")
        for (const [prio, count] of Object.entries(prioCounts).sort((a, b) => b[1] - a[1]))
          lines.push(`  ${prio}: ${count}`)
        lines.push("")
      }

      // Sort: blocked/open first, priority desc, recency desc
      const sortedItems = [...items].sort((a, b) => {
        const aBlocked = a.status === "blocked" || a.blocking ? -1 : 0
        const bBlocked = b.status === "blocked" || b.blocking ? -1 : 0
        if (aBlocked !== bBlocked) return aBlocked - bBlocked
        const pOrder: Record<string, number> = { urgent: 0, high: 1, normal: 2, medium: 2, low: 3 }
        return (pOrder[a.priority] ?? 9) - (pOrder[b.priority] ?? 9)
      })

      const topN = Math.min(sortedItems.length, 10)
      lines.push(`Top ${topN} entries:`)
      for (const item of sortedItems.slice(0, topN)) {
        const title = item.title ?? item.subject ?? item.name ?? "untitled"
        const status = item.status ? `[${item.status}]` : ""
        const prio = item.priority ? ` [${item.priority}]` : ""
        const id = item.id ? ` (${String(item.id).slice(0, 8)})` : ""
        lines.push(`- ${title} ${status}${prio}${id}`)
      }
      if (sortedItems.length > topN)
        lines.push(`  ... and ${sortedItems.length - topN} more`)

    } else {
      const keys = Object.keys(obj)
      lines.push(`Response with ${keys.length} fields: ${keys.slice(0, 10).join(", ")}`)
      for (const [key, val] of Object.entries(obj)) {
        if (typeof val === "string" || typeof val === "number" || typeof val === "boolean")
          lines.push(`  ${key}: ${val}`)
      }
    }
  } else {
    lines.push(`Text response (${raw.length} chars)`)
    const textLines = raw.split("\n")
    for (const l of textLines.slice(0, 15)) lines.push(l)
    if (textLines.length > 15) lines.push(`... ${textLines.length - 15} lines omitted`)
  }

  lines.push("")
  lines.push(retrievalFooter(hash))
  return lines.join("\n")
}

function compressSearchResults(raw: string, parsed: unknown, hash: string, tool: string): string {
  const originalTokens = estimateTokens(raw)
  const lines: string[] = []
  lines.push(`[HEADROOM:v1] tool=${tool} hash=${hash} original_tokens=${originalTokens}`)
  lines.push("")

  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>
    const results = (obj as any).results ?? (obj as any).matches ?? (obj as any).items

    if (Array.isArray(results)) {
      // Sort by score desc
      const sorted = [...results].sort((a, b) => (b.score ?? b.relevance ?? 0) - (a.score ?? a.relevance ?? 0))
      lines.push(`${sorted.length} search results returned.`)
      lines.push("")
      for (const r of sorted.slice(0, 10)) {
        const title = r.title ?? r.name ?? "untitled"
        const type  = r.entity_type ?? r.type ?? ""
        const score = r.score ?? r.relevance ?? ""
        const id    = r.id ?? ""
        lines.push(`- ${title}${type ? ` (${type})` : ""}${score ? ` score=${score}` : ""}`)
        if (id) lines.push(`  id: ${id}`)
        const snippet = r.snippet ?? r.excerpt ?? r.body
        if (typeof snippet === "string" && snippet.length > 0)
          lines.push(`  ${snippet.slice(0, 150)}${snippet.length > 150 ? "..." : ""}`)
      }
      if (sorted.length > 10) lines.push(`  ... and ${sorted.length - 10} more`)
    } else {
      lines.push(`Search response with ${Object.keys(obj).length} fields: ${Object.keys(obj).join(", ")}`)
    }
  } else {
    lines.push(`Text response (${raw.length} chars)`)
  }

  lines.push("")
  lines.push(retrievalFooter(hash))
  return lines.join("\n")
}

function compressFallback(raw: string, hash: string, tool: string): string {
  const originalTokens = estimateTokens(raw)
  const textLines = raw.split("\n")
  const lines: string[] = []
  lines.push(`[HEADROOM:v1] tool=${tool} hash=${hash} original_tokens=${originalTokens}`)
  lines.push("")
  lines.push(`Response: ${textLines.length} lines, ${raw.length} chars`)
  lines.push("")
  for (const l of textLines.slice(0, 30)) lines.push(l)
  if (textLines.length > 30) lines.push(`... ${textLines.length - 30} lines omitted`)
  lines.push("")
  lines.push(retrievalFooter(hash))
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Project context discovery
// ---------------------------------------------------------------------------

interface NexusConfig { apiUrl: string; token: string }
interface ProjectContext { projectId: string; plugins: string[]; headroomEnabled: boolean }

function getNexusConfig(directory: string): NexusConfig | null {
  const apiUrl = process.env.NEXUS_API_URL
  const token  = process.env.NEXUS_PRIVATE_TOKEN
  if (apiUrl && token) return { apiUrl, token }
  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
    const configDir = join(home, ".config", "nexus")
    let resolvedUrl   = apiUrl
    let resolvedToken = token
    const configPath = join(configDir, "config.toml")
    const credsPath  = join(configDir, "credentials.toml")
    if (!resolvedUrl && existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8")
      const m = raw.match(/api_url\s*=\s*"([^"]+)"/)
      if (m) resolvedUrl = m[1]
    }
    if (!resolvedToken && existsSync(credsPath)) {
      const raw = readFileSync(credsPath, "utf-8")
      const m = raw.match(/^\s*token\s*=\s*"([^"]+)"/m)
      if (m) resolvedToken = m[1]
    }
    if (resolvedUrl && resolvedToken) return { apiUrl: resolvedUrl, token: resolvedToken }
  } catch {}
  return null
}

function readProjectIdFromAgentsMd(directory: string): string | null {
  try {
    const agentsPath = join(directory, ".nexus", "AGENTS.md")
    if (!existsSync(agentsPath)) return null
    const raw = readFileSync(agentsPath, "utf-8")
    const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/)
    if (!fmMatch) return null
    const pidMatch = fmMatch[1].match(/project_id:\s*([0-9a-f-]{36})/)
    return pidMatch ? pidMatch[1] : null
  } catch { return null }
}

async function fetchProjectContext(config: NexusConfig, projectId: string): Promise<ProjectContext | null> {
  try {
    const res = await fetch(`${config.apiUrl}/api/projects/${projectId}/preflight`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const data = await res.json()
    const plugins: string[] = Array.isArray(data.plugins) ? data.plugins : []
    return { projectId, plugins, headroomEnabled: plugins.includes("headroom") }
  } catch { return null }
}

// ---------------------------------------------------------------------------
// OpenCode SDK version guard — Fix 5
// ---------------------------------------------------------------------------

function checkSdkVersion(ctx: any, logger: StructuredLogger): boolean {
  try {
    // Try to read SDK version from package.json in .opencode/
    const pkgPath = join(ctx.directory, ".opencode", "package.json")
    if (!existsSync(pkgPath)) {
      logger.log("warn", "sdk_version_unknown", {
        reason: ".opencode/package.json not found",
        fallback: "observe",
      })
      return false
    }
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    const sdkVersion: string = deps["@opencode-ai/plugin"] ?? ""
    if (!sdkVersion) {
      logger.log("warn", "sdk_version_unknown", { reason: "@opencode-ai/plugin not in package.json", fallback: "observe" })
      return false
    }
    // Parse semver (handles ^1.14.31, ~1.14.0, 1.14.31, etc.)
    const match = sdkVersion.replace(/^[\^~>=<]+/, "").match(/^(\d+)\.(\d+)/)
    if (!match) {
      logger.log("warn", "sdk_version_parse_failed", { sdkVersion, fallback: "observe" })
      return false
    }
    const major = parseInt(match[1], 10)
    const minor = parseInt(match[2], 10)
    const compatible =
      major > REQUIRED_SDK_MAJOR ||
      (major === REQUIRED_SDK_MAJOR && minor >= REQUIRED_SDK_MINOR)

    if (!compatible) {
      logger.log("warn", "sdk_version_incompatible", {
        sdkVersion,
        required: `>=${REQUIRED_SDK_MAJOR}.${REQUIRED_SDK_MINOR}`,
        fallback: "observe",
      })
    } else {
      logger.log("info", "sdk_version_ok", { sdkVersion })
    }
    return compatible
  } catch {
    logger.log("warn", "sdk_version_check_error", { fallback: "observe" })
    return false
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const NexusHeadroomIntercept: Plugin = async (ctx) => {
  const { client, directory } = ctx
  const logger = new StructuredLogger(directory)

  // Resolve mode: env override > default (observe)
  let mode: PluginMode = (process.env.HEADROOM_MODE as PluginMode) ?? DEFAULT_MODE

  // Fix 5: SDK version guard — downgrade to observe if incompatible
  if (mode === "transform") {
    const sdkOk = checkSdkVersion(ctx, logger)
    if (!sdkOk) {
      mode = "observe"
      logger.log("warn", "mode_downgraded", { reason: "sdk_version_incompatible_or_unknown", mode })
    }
  }

  // Project context gate
  const projectId = readProjectIdFromAgentsMd(directory)
  let projectContext: ProjectContext | null = null

  if (projectId) {
    const nexusConfig = getNexusConfig(directory)
    if (nexusConfig) {
      projectContext = await fetchProjectContext(nexusConfig, projectId)
      if (projectContext && !projectContext.headroomEnabled) {
        mode = "observe"
        logger.log("warn", "project_gate_headroom_disabled", { projectId, mode })
      } else if (projectContext) {
        logger.log("info", "project_gate_ok", { projectId })
      } else {
        logger.log("warn", "project_gate_preflight_unreachable", { projectId, mode })
      }
    } else {
      logger.log("warn", "project_gate_no_credentials", { mode })
    }
  } else {
    logger.log("warn", "project_gate_no_project_id", { mode })
  }

  const store = new OriginalStore(directory)

  // Periodic disk eviction (fire and forget)
  try { store.evictDisk() } catch {}

  const metrics: SessionMetrics = {
    totalCompressions: 0,
    totalObservations: 0,
    totalSkips: 0,
    totalPassthroughs: 0,
    totalNoGain: 0,
    totalUnsupportedShapes: 0,
    potentialSavedTokens: 0,
    locallyAppliedTransforms: 0,
    events: [],
  }

  await client.app.log({
    body: {
      service: PLUGIN_META.name,
      level: "info",
      message: `v${PLUGIN_META.version} loaded — mode=${mode}, project=${projectId ?? "unknown"}, policies=${Object.keys(POLICIES).length}`,
    },
  })
  logger.log("info", "plugin_loaded", {
    mode,
    version: PLUGIN_META.version,
    project: projectId ?? "unknown",
    policies: Object.keys(POLICIES).length,
  })

  return {
    // -----------------------------------------------------------------------
    // nexus_headroom_intercept_retrieve — Fix 4: plugin-owned retrieval tool
    // Resolves the CCR gap: compact outputs now point here, not to headroom MCP.
    // -----------------------------------------------------------------------
    tools: [
      {
        name: "nexus_headroom_intercept_retrieve",
        description:
          "Retrieve the original uncompressed content stored by the nexus-headroom-intercept plugin. " +
          "Use this when you need the full content behind a [HEADROOM:v1] compressed result. " +
          "Pass the hash from the compressed output.",
        parameters: {
          type: "object" as const,
          properties: {
            hash: {
              type: "string",
              description: "The SHA-256 content hash from the [HEADROOM:v1] header.",
            },
            query: {
              type: "string",
              description: "Optional: a search query to return only relevant lines from the original.",
            },
          },
          required: ["hash"],
        },
        execute: async ({ hash, query, max_lines, max_chars, allow_full }: {
          hash: string
          query?: string
          max_lines?: number
          max_chars?: number
          allow_full?: boolean
        }) => {
          // Fix 6.5: validate hash format — must be exactly 64 hex chars (full SHA-256)
          // Guards against path traversal, malformed input, and accidental misuse.
          if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
            return {
              found: false,
              hash: hash ?? "",
              error: "invalid_hash",
              message: "Hash must be a 64-character lowercase hexadecimal string (full SHA-256).",
            }
          }

          const content = store.get(hash)
          if (!content) {
            return {
              found: false,
              hash,
              message:
                "Content not found in plugin cache. It may have expired (TTL: 24h) or " +
                "this hash was generated in a previous session. Re-fetch using the original tool.",
            }
          }

          // Fix 6.4a: clamp user-supplied bounds to server-controlled hard limits
          const MAX_LINES_HARD = 1000
          const MAX_CHARS_HARD = 100_000
          const effectiveMaxLines = Math.min(Math.max(1, Math.floor(max_lines ?? 100)), MAX_LINES_HARD)
          const effectiveMaxChars = Math.min(Math.max(1, Math.floor(max_chars ?? 12_000)), MAX_CHARS_HARD)

          if (query && query.trim()) {
            const qLower = query.toLowerCase()
            const lines = content.split("\n")
            const matched = lines.filter(l => l.toLowerCase().includes(qLower))

            if (matched.length === 0) {
              return {
                found: true,
                hash,
                query,
                matched_lines: 0,
                returned_lines: 0,
                returned_chars: 0,
                content: null,
                message: "No lines matched the query. Refine the query or omit it to retrieve a bounded excerpt.",
              }
            }

            // Fix 6.4b: bounded slice + explicit returned_lines / returned_chars metadata
            const bounded = matched.slice(0, effectiveMaxLines).join("\n").slice(0, effectiveMaxChars)
            return {
              found: true,
              hash,
              query,
              matched_lines: matched.length,
              returned_lines: Math.min(matched.length, effectiveMaxLines),
              returned_chars: bounded.length,
              truncated: matched.length > effectiveMaxLines || bounded.length < matched.slice(0, effectiveMaxLines).join("\n").length,
              content: bounded,
            }
          }

          // No query — bounded excerpt unless allow_full=true
          if (!allow_full) {
            const lines = content.split("\n")
            const sliced = lines.slice(0, effectiveMaxLines).join("\n")
            const excerpt = sliced.slice(0, effectiveMaxChars)
            const truncated = lines.length > effectiveMaxLines || excerpt.length < sliced.length
            return {
              found: true,
              hash,
              returned_lines: excerpt.split("\n").length,
              returned_chars: excerpt.length,
              total_lines: lines.length,
              total_chars: content.length,
              truncated,
              content: excerpt,
              message: truncated
                ? `Showing first ${effectiveMaxLines} lines / ${effectiveMaxChars} chars. Pass allow_full=true for the complete original.`
                : undefined,
            }
          }

          // allow_full=true — return complete original with metadata
          const lines = content.split("\n")
          return {
            found: true,
            hash,
            returned_lines: lines.length,
            returned_chars: content.length,
            total_lines: lines.length,
            total_chars: content.length,
            truncated: false,
            content,
          }
        },
      },
    ],

    // -----------------------------------------------------------------------
    // tool.execute.after — core interception hook
    // -----------------------------------------------------------------------
    "tool.execute.after": async (input, output) => {
      const toolName = String(input?.tool ?? "")
      if (!toolName) return

      // Policy lookup — exact match, then prefix fallback
      let policy = POLICIES[toolName]
      if (!policy) {
        if (toolName.startsWith("nexus_") || toolName.startsWith("headroom_")) {
          policy = { action: "passthrough", reason: "no-explicit-policy" }
        } else {
          metrics.totalSkips++
          return
        }
      }

      if (policy.action === "skip") { metrics.totalSkips++; return }
      if (policy.action === "passthrough") { metrics.totalPassthroughs++; return }

      // Fix: never compress error responses — error payloads must be preserved verbatim
      const rawOut = output as unknown as ToolOutput
      if (rawOut.isError === true) {
        metrics.totalPassthroughs++
        return
      }

      // Normalize tool result — handles both output.output and content[]
      const normalized = normalizeToolResult(output)

      if (!normalized.supported || !normalized.text) {
        metrics.totalUnsupportedShapes++
        logger.log("warn", "unsupported_shape", { tool: toolName, sourceShape: normalized.sourceShape })
        return
      }

      const estimatedTokens = estimateTokens(normalized.text)
      const threshold = policy.minTokens ?? DEFAULT_MIN_TOKENS

      if (estimatedTokens < threshold) {
        metrics.totalPassthroughs++
        return
      }

      const hash = contentHash(normalized.text)
      const profile = policy.profile ?? "reference-data"
      const compact = compressByProfile(normalized.text, profile, hash, toolName)
      const compressedTokens = estimateTokens(compact)
      const savedTokens = estimatedTokens - compressedTokens

      // Negative-savings guard — evaluate before storing to avoid unnecessary disk writes
      const savingRatio = savedTokens / estimatedTokens
      if (compressedTokens >= estimatedTokens || savingRatio < MINIMUM_SAVING_RATIO) {
        metrics.totalNoGain++
        logger.log("info", "no_gain", {
          tool: toolName,
          estimatedTokens,
          compressedTokens,
          savingRatio: savingRatio.toFixed(3),
        })
        return
      }

      // Store original only after confirming transform is worthwhile.
      // In observe mode: skip disk persistence (metrics only).
      if (mode === "transform") {
        store.set(hash, normalized.text)
        store.prune()
      }

      const event: CompressionEvent = {
        tool: toolName,
        originalChars: normalized.text.length,
        originalEstimatedTokens: estimatedTokens,
        compressedChars: compact.length,
        compressedEstimatedTokens: compressedTokens,
        potentialSavedTokens: savedTokens,
        compressionRatio: compressedTokens / estimatedTokens,
        profile,
        contentHash: hash,
        sourceShape: normalized.sourceShape,
        transformed: false,
        timestamp: Date.now(),
      }

      metrics.potentialSavedTokens += savedTokens

      if (mode === "transform") {
        try {
          normalized.apply(compact)
          event.transformed = true
          metrics.totalCompressions++
          metrics.locallyAppliedTransforms++
          logger.log("info", "transform", {
            tool: toolName,
            originalTokens: estimatedTokens,
            compressedTokens,
            potentialSavedTokens: savedTokens,
            ratio: event.compressionRatio.toFixed(3),
            hash,
            sourceShape: normalized.sourceShape,
          })
        } catch (err) {
          // Fail-open: leave original intact
          metrics.totalObservations++
          logger.log("error", "transform_failed", { tool: toolName, error: String(err) })
        }
      } else {
        metrics.totalObservations++
        logger.log("info", "observe", {
          tool: toolName,
          estimatedTokens,
          potentialSavedTokens: savedTokens,
          ratio: event.compressionRatio.toFixed(3),
          hash,
          sourceShape: normalized.sourceShape,
        })
      }

      metrics.events.push(event)
    },

    // -----------------------------------------------------------------------
    // Event handler — session-idle summary
    // -----------------------------------------------------------------------
    event: async ({ event }) => {
      const ev = event as any
      const isIdle =
        ev.type === "session.idle" ||
        ev.name === "session.idle" ||
        ev.kind === "session.idle"

      if (isIdle && metrics.events.length > 0) {
        logger.log("info", "session_summary", {
          mode,
          compressions: metrics.totalCompressions,
          locallyAppliedTransforms: metrics.locallyAppliedTransforms,
          observations: metrics.totalObservations,
          skips: metrics.totalSkips,
          passthroughs: metrics.totalPassthroughs,
          noGain: metrics.totalNoGain,
          unsupportedShapes: metrics.totalUnsupportedShapes,
          potentialSavedTokens: metrics.potentialSavedTokens,
        })
      }
    },
  }
}
