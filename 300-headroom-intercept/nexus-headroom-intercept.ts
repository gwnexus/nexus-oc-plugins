import { type Plugin } from "@opencode-ai/plugin"
import { writeFileSync, readFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"

/**
 * Plugin metadata — single source of truth for name/version.
 */
const PLUGIN_META = {
  name: "nexus-headroom-intercept",
  version: "0.3.0",
  description:
    "Pre-injection context compression for Nexus MCP tool outputs. " +
    "Uses the tool.execute.after hook to apply policy-based deterministic " +
    "compression before tool results enter the agent context window.",
} as const

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PolicyAction = "compress" | "passthrough" | "skip"
type CompressionProfile = "reference-data" | "structured-list" | "search-results"

/**
 * Extended output shape observed at runtime for MCP tool calls.
 * The SDK type declares only { title, output, metadata } for tool.execute.after,
 * but MCP tools in practice deliver results via a content[] array instead of output.
 * This interface documents the actual runtime shape to reduce implicit `as any` usage.
 */
interface ToolOutput {
  title?: string
  output?: string
  metadata?: unknown
  /** Present for MCP tools — SDK type does not declare this field */
  content?: Array<{ text?: string; type?: string }>
  /** Present for native tools like read/bash */
  attachments?: unknown
  /** Present for some MCP tools that return errors */
  isError?: boolean
}

interface Policy {
  action: PolicyAction
  profile?: CompressionProfile
  /** Minimum estimated tokens before compression triggers. */
  minTokens?: number
  /** Minimum items in a list-type response before compression triggers. */
  minItems?: number
  /** Reason for skip/passthrough (logged). */
  reason?: string
}

interface CompressionMetrics {
  tool: string
  originalChars: number
  originalEstimatedTokens: number
  compressedChars: number
  compressedEstimatedTokens: number
  savedEstimatedTokens: number
  compressionRatio: number
  profile: string
  contentHash: string
  timestamp: number
}

interface SessionMetrics {
  totalCompressions: number
  totalObservations: number
  totalSkips: number
  totalPassthroughs: number
  totalSavedTokens: number
  events: CompressionMetrics[]
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Plugin mode:
 * - "observe": log metrics and classify outputs — no mutation
 * - "transform": apply compression and mutate output.output — fail-open
 */
type PluginMode = "observe" | "transform"

const DEFAULT_MODE: PluginMode = "transform"
const DEFAULT_MIN_TOKENS = 2000
const CHARS_PER_TOKEN = 4

/**
 * Policy registry: maps tool identifiers to compression policies.
 *
 * Tool names match the `input.tool` value from the OpenCode
 * tool.execute.after hook — these are the exact MCP tool names
 * as registered by the Nexus MCP server.
 */
const POLICIES: Record<string, Policy> = {
  // Nexus knowledge tools — high volume, mostly reference data
  nexus_kb_memory: {
    action: "compress",
    profile: "reference-data",
    minTokens: 2000,
  },
  nexus_kb_search: {
    action: "compress",
    profile: "search-results",
    minTokens: 800,  // reduced from 3000 — search results are typically 700-2000 tokens
  },
  nexus_kb_get: {
    action: "compress",
    profile: "reference-data",
    minTokens: 3000,
  },

  // Nexus coordination tools — structured list responses
  nexus_dispatch_sweep: {
    action: "compress",
    profile: "structured-list",
    minTokens: 500,  // sweep responses rarely exceed 500 tokens; trigger on meaningful payloads
  },
  nexus_dispatch_inbox: {
    action: "compress",
    profile: "structured-list",
    minTokens: 2000,
  },
  nexus_dispatch_outbox: {
    action: "compress",
    profile: "structured-list",
    minTokens: 2000,
  },
  // session_list returns at most a handful of sessions — rarely exceeds threshold
  nexus_session_list: { action: "passthrough", reason: "small-response" },
  nexus_doc_list: {
    action: "compress",
    profile: "structured-list",
    minTokens: 2000,
  },
  nexus_task_list: {
    action: "compress",
    profile: "structured-list",
    minTokens: 2000,
  },

  // Write operations — never compress, small responses
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
  nexus_dispatch_create: { action: "passthrough", reason: "write-operation" },
  nexus_dispatch_reply: { action: "passthrough", reason: "write-operation" },
  nexus_dispatch_resolve: { action: "passthrough", reason: "write-operation" },
  nexus_dispatch_close: { action: "passthrough", reason: "write-operation" },

  // Explicit passthrough — never compress retrieval results
  nexus_headroom_retrieve: { action: "passthrough", reason: "explicit-detail-request" },
  headroom_retrieve: { action: "passthrough", reason: "explicit-detail-request" },
  headroom_headroom_retrieve: { action: "passthrough", reason: "explicit-detail-request" },

  // Skip — handled by other mechanisms
  bash: { action: "skip", reason: "handled-by-rtk" },
  shell: { action: "skip", reason: "handled-by-rtk" },
  read: { action: "skip", reason: "active-editing-context" },
  write: { action: "skip", reason: "active-editing-context" },
  edit: { action: "skip", reason: "active-editing-context" },
  glob: { action: "skip", reason: "file-search" },
  grep: { action: "skip", reason: "code-search" },
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 24)
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function fileLog(dir: string, message: string) {
  try {
    const logDir = join(dir, ".nexus")
    mkdirSync(logDir, { recursive: true })
    const logFile = join(logDir, "headroom-intercept.log")
    const ts = new Date().toISOString()
    appendFileSync(logFile, `[${ts}] ${message}\n`)
  } catch {
    // Silent — logging must never break the plugin
  }
}

// ---------------------------------------------------------------------------
// Original content store (in-memory + disk fallback)
// ---------------------------------------------------------------------------

class OriginalStore {
  private cache = new Map<string, string>()
  private cacheDir: string

  constructor(projectDir: string) {
    this.cacheDir = join(projectDir, ".nexus", "headroom-cache")
    try {
      mkdirSync(this.cacheDir, { recursive: true })
    } catch {
      // Silent — disk cache is optional
    }
  }

  set(hash: string, content: string): void {
    this.cache.set(hash, content)
    // Disk fallback for cross-session retrieval
    try {
      writeFileSync(join(this.cacheDir, `${hash}.json`), JSON.stringify({
        hash,
        length: content.length,
        estimatedTokens: estimateTokens(content),
        storedAt: new Date().toISOString(),
        content,
      }))
    } catch {
      // Silent — in-memory is sufficient for current session
    }
  }

  get(hash: string): string | null {
    const cached = this.cache.get(hash)
    if (cached) return cached
    // Disk fallback
    try {
      const raw = readFileSync(join(this.cacheDir, `${hash}.json`), "utf-8")
      const data = JSON.parse(raw)
      if (data?.content) {
        this.cache.set(hash, data.content)
        return data.content
      }
    } catch {
      // Not found
    }
    return null
  }

  /** Prune in-memory cache to prevent unbounded growth. */
  prune(maxEntries = 50): void {
    if (this.cache.size <= maxEntries) return
    const keys = Array.from(this.cache.keys())
    const toRemove = keys.slice(0, keys.length - maxEntries)
    for (const key of toRemove) {
      this.cache.delete(key)
    }
  }
}

// ---------------------------------------------------------------------------
// Compression profiles
// ---------------------------------------------------------------------------

/**
 * Compress by profile. All compression is deterministic — no LLM calls.
 * Returns a compact text representation with a retrieval handle.
 */
function compressByProfile(
  raw: string,
  profile: CompressionProfile,
  hash: string,
  tool: string,
): string {
  const parsed = tryParseJson(raw)

  switch (profile) {
    case "reference-data":
      return compressReferenceData(raw, parsed, hash, tool)
    case "structured-list":
      return compressStructuredList(raw, parsed, hash, tool)
    case "search-results":
      return compressSearchResults(raw, parsed, hash, tool)
    default:
      return compressFallback(raw, hash, tool)
  }
}

function compressReferenceData(
  raw: string,
  parsed: unknown,
  hash: string,
  tool: string,
): string {
  const originalTokens = estimateTokens(raw)
  const lines: string[] = []
  lines.push(`[HEADROOM:v1] tool=${tool} hash=${hash} original_tokens=${originalTokens}`)
  lines.push("")

  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>

    // ------------------------------------------------------------------
    // Shape A: kb_memory response — has a `memory` sub-object
    // ------------------------------------------------------------------
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
        for (const task of memory.active_tasks) {
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
        if (memory.recent_sessions.length > 5) {
          lines.push(`  ... and ${memory.recent_sessions.length - 5} more`)
        }
      }

      if (Array.isArray(memory.open_letters) && memory.open_letters.length > 0) {
        lines.push("")
        lines.push(`## Open Dispatches (${memory.open_letters.length})`)
        for (const d of memory.open_letters.slice(0, 5)) {
          lines.push(`- ${d.title ?? d.subject ?? "untitled"} [${d.status ?? "?"}]`)
        }
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

    // ------------------------------------------------------------------
    // Shape B: kb_get single-entity response — `document` wrapper
    // ------------------------------------------------------------------
    } else if (obj.entity_type && obj.document) {
      const doc = obj.document as Record<string, unknown>
      const etype = String(obj.entity_type)
      lines.push(`Entity type: ${etype}`)
      lines.push(`Entity id:   ${doc.id ?? obj.entity_id ?? "?"}`)
      if (doc.title) lines.push(`Title:  ${doc.title}`)
      if (doc.status) lines.push(`Status: ${doc.status}`)
      if (doc.adr_number) lines.push(`ADR:    ADR-${doc.adr_number}`)
      if (doc.priority) lines.push(`Priority: ${doc.priority}`)
      if (doc.project_id) lines.push(`Project: ${doc.project_id}`)
      if (doc.created_at) lines.push(`Created: ${String(doc.created_at).slice(0, 10)}`)

      // Include a brief excerpt of the main body field (context / body / description)
      const bodyField = (doc.context ?? doc.body ?? doc.description ?? doc.summary) as string | undefined
      if (typeof bodyField === "string" && bodyField.length > 0) {
        lines.push("")
        lines.push("Excerpt:")
        const excerpt = bodyField.replace(/\n+/g, " ").slice(0, 400)
        lines.push(`  ${excerpt}${bodyField.length > 400 ? "..." : ""}`)
      }

      // For ADRs: also show decision + consequences headings
      if (etype === "decision") {
        if (typeof doc.decision === "string" && doc.decision.length > 0) {
          lines.push("")
          lines.push("Decision excerpt:")
          lines.push(`  ${doc.decision.replace(/\n+/g, " ").slice(0, 300)}${doc.decision.length > 300 ? "..." : ""}`)
        }
        if (doc.supersedes) lines.push(`Supersedes: ${doc.supersedes}`)
      }

    // ------------------------------------------------------------------
    // Shape C: Generic single entity (session, task, ingest_item, etc.)
    // Fields directly on the object: id, title, status, priority, body…
    // ------------------------------------------------------------------
    } else if (obj.id || obj.entity_id) {
      if (obj.entity_type) lines.push(`Entity type: ${obj.entity_type}`)
      if (obj.id) lines.push(`id: ${obj.id}`)
      if (obj.title) lines.push(`Title:  ${obj.title}`)
      if (obj.status) lines.push(`Status: ${obj.status}`)
      if (obj.priority) lines.push(`Priority: ${obj.priority}`)
      if (obj.project_id) lines.push(`Project: ${obj.project_id}`)
      if (obj.created_at) lines.push(`Created: ${String(obj.created_at).slice(0, 10)}`)

      const bodyField = (obj.body ?? obj.description ?? obj.summary ?? obj.context) as string | undefined
      if (typeof bodyField === "string" && bodyField.length > 0) {
        lines.push("")
        lines.push("Excerpt:")
        const excerpt = bodyField.replace(/\n+/g, " ").slice(0, 400)
        lines.push(`  ${excerpt}${bodyField.length > 400 ? "..." : ""}`)
      }

    // ------------------------------------------------------------------
    // Shape D: Unknown JSON structure — show top-level keys + scalar values
    // ------------------------------------------------------------------
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
    // Non-JSON: show first 20 lines
    const textLines = raw.split("\n")
    lines.push(`Text response (${textLines.length} lines)`)
    lines.push("")
    for (const l of textLines.slice(0, 20)) lines.push(l)
    if (textLines.length > 20) lines.push(`... ${textLines.length - 20} lines omitted`)
  }

  lines.push("")
  lines.push(`---`)
  lines.push(`Full content available: use headroom_retrieve(hash="${hash}") or headroom_headroom_retrieve(hash="${hash}")`)

  return lines.join("\n")
}

function compressStructuredList(
  raw: string,
  parsed: unknown,
  hash: string,
  tool: string,
): string {
  const originalTokens = estimateTokens(raw)
  const lines: string[] = []
  lines.push(`[HEADROOM:v1] tool=${tool} hash=${hash} original_tokens=${originalTokens}`)
  lines.push("")

  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>

    // Try to find the main list in common Nexus response shapes
    const listCandidates = ["sessions", "dispatches", "tasks", "documents", "items", "results", "letters"]
    let items: any[] | null = null
    let listKey = ""

    for (const key of listCandidates) {
      if (Array.isArray(obj[key])) {
        items = obj[key] as any[]
        listKey = key
        break
      }
    }

    // Also check nested structures
    if (!items) {
      for (const [key, val] of Object.entries(obj)) {
        if (Array.isArray(val) && val.length > 0) {
          items = val
          listKey = key
          break
        }
      }
    }

    if (items && items.length > 0) {
      lines.push(`${items.length} ${listKey} returned.`)
      lines.push("")

      // Status aggregation
      const statusCounts: Record<string, number> = {}
      for (const item of items) {
        const s = item.status ?? item.state ?? "unknown"
        statusCounts[s] = (statusCounts[s] ?? 0) + 1
      }
      if (Object.keys(statusCounts).length > 1) {
        lines.push("Status summary:")
        for (const [status, count] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
          lines.push(`  ${status}: ${count}`)
        }
        lines.push("")
      }

      // Priority aggregation (if present)
      const prioCounts: Record<string, number> = {}
      for (const item of items) {
        if (item.priority) {
          prioCounts[item.priority] = (prioCounts[item.priority] ?? 0) + 1
        }
      }
      if (Object.keys(prioCounts).length > 1) {
        lines.push("Priority summary:")
        for (const [prio, count] of Object.entries(prioCounts).sort((a, b) => b[1] - a[1])) {
          lines.push(`  ${prio}: ${count}`)
        }
        lines.push("")
      }

      // Top items
      const topN = Math.min(items.length, 10)
      lines.push(`Top ${topN} entries:`)
      for (const item of items.slice(0, topN)) {
        const title = item.title ?? item.subject ?? item.name ?? "untitled"
        const status = item.status ?? ""
        const prio = item.priority ? ` [${item.priority}]` : ""
        const id = item.id ? ` (${item.id})` : ""
        lines.push(`- ${title} ${status ? `[${status}]` : ""}${prio}${id}`)
      }
      if (items.length > topN) {
        lines.push(`  ... and ${items.length - topN} more`)
      }
    } else {
      // Scalar or empty response
      const keys = Object.keys(obj)
      lines.push(`Response with ${keys.length} fields: ${keys.slice(0, 10).join(", ")}`)
      // Include small scalar fields
      for (const [key, val] of Object.entries(obj)) {
        if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
          lines.push(`  ${key}: ${val}`)
        }
      }
    }
  } else {
    lines.push(`Text response (${raw.length} chars)`)
    const textLines = raw.split("\n")
    for (const l of textLines.slice(0, 15)) {
      lines.push(l)
    }
    if (textLines.length > 15) {
      lines.push(`... ${textLines.length - 15} lines omitted`)
    }
  }

  lines.push("")
  lines.push(`---`)
  lines.push(`Full content available: use headroom_retrieve(hash="${hash}") or headroom_headroom_retrieve(hash="${hash}")`)

  return lines.join("\n")
}

function compressSearchResults(
  raw: string,
  parsed: unknown,
  hash: string,
  tool: string,
): string {
  const originalTokens = estimateTokens(raw)
  const lines: string[] = []
  lines.push(`[HEADROOM:v1] tool=${tool} hash=${hash} original_tokens=${originalTokens}`)
  lines.push("")

  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>
    const results = (obj as any).results ?? (obj as any).matches ?? (obj as any).items

    if (Array.isArray(results)) {
      lines.push(`${results.length} search results returned.`)
      lines.push("")
      for (const r of results.slice(0, 10)) {
        const title = r.title ?? r.name ?? "untitled"
        const type = r.entity_type ?? r.type ?? ""
        const score = r.score ?? r.relevance ?? ""
        const id = r.id ?? ""
        lines.push(`- ${title}${type ? ` (${type})` : ""}${score ? ` score=${score}` : ""}`)
        if (id) lines.push(`  id: ${id}`)
        // Include a brief snippet if available
        const snippet = r.snippet ?? r.excerpt ?? r.body
        if (typeof snippet === "string" && snippet.length > 0) {
          lines.push(`  ${snippet.slice(0, 150)}${snippet.length > 150 ? "..." : ""}`)
        }
      }
      if (results.length > 10) {
        lines.push(`  ... and ${results.length - 10} more`)
      }
    } else {
      // Fallback: show top-level structure
      const keys = Object.keys(obj)
      lines.push(`Search response with ${keys.length} fields: ${keys.join(", ")}`)
    }
  } else {
    lines.push(`Text response (${raw.length} chars)`)
  }

  lines.push("")
  lines.push(`---`)
  lines.push(`Full content available: use headroom_retrieve(hash="${hash}") or headroom_headroom_retrieve(hash="${hash}")`)

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
  for (const l of textLines.slice(0, 30)) {
    lines.push(l)
  }
  if (textLines.length > 30) {
    lines.push(`... ${textLines.length - 30} lines omitted`)
  }
  lines.push("")
  lines.push(`---`)
  lines.push(`Full content available: use headroom_retrieve(hash="${hash}") or headroom_headroom_retrieve(hash="${hash}")`)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Project context discovery
// ---------------------------------------------------------------------------

interface NexusConfig {
  apiUrl: string
  token: string
}

interface ProjectContext {
  projectId: string
  plugins: string[]
  headroomEnabled: boolean
}

/**
 * Read Nexus API credentials from env or ~/.config/nexus/ TOML files.
 * Same pattern used by nexus-compaction-plus and nexus-cost-control.
 */
function getNexusConfig(directory: string): NexusConfig | null {
  const apiUrl = process.env.NEXUS_API_URL
  const token = process.env.NEXUS_PRIVATE_TOKEN
  if (apiUrl && token) return { apiUrl, token }

  // Fallback: ~/.config/nexus/ TOML files
  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
    const configDir = join(home, ".config", "nexus")
    const configPath = join(configDir, "config.toml")
    const credsPath = join(configDir, "credentials.toml")

    let resolvedUrl = apiUrl
    let resolvedToken = token

    if (!resolvedUrl && existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8")
      const match = raw.match(/api_url\s*=\s*"([^"]+)"/)
      if (match) resolvedUrl = match[1]
    }
    if (!resolvedToken && existsSync(credsPath)) {
      const raw = readFileSync(credsPath, "utf-8")
      // credentials.toml uses `token = "..."` (not `private_token`)
      const match = raw.match(/^\s*token\s*=\s*"([^"]+)"/m)
      if (match) resolvedToken = match[1]
    }

    if (resolvedUrl && resolvedToken) return { apiUrl: resolvedUrl, token: resolvedToken }
  } catch {
    // Silent
  }
  return null
}

/**
 * Extract project_id from .nexus/AGENTS.md YAML frontmatter.
 */
function readProjectIdFromAgentsMd(directory: string): string | null {
  try {
    const agentsPath = join(directory, ".nexus", "AGENTS.md")
    if (!existsSync(agentsPath)) return null
    const raw = readFileSync(agentsPath, "utf-8")
    // Parse YAML frontmatter between --- markers
    const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/)
    if (!fmMatch) return null
    const pidMatch = fmMatch[1].match(/project_id:\s*([0-9a-f-]{36})/)
    return pidMatch ? pidMatch[1] : null
  } catch {
    return null
  }
}

/**
 * Query the Nexus Preflight API to check if headroom is enabled for this project.
 * Returns the full project context with plugin list.
 */
async function fetchProjectContext(
  config: NexusConfig,
  projectId: string,
): Promise<ProjectContext | null> {
  try {
    const url = `${config.apiUrl}/api/projects/${projectId}/preflight`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const data = await res.json()
    const plugins: string[] = Array.isArray(data.plugins) ? data.plugins : []
    return {
      projectId,
      plugins,
      headroomEnabled: plugins.includes("headroom"),
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const NexusHeadroomIntercept: Plugin = async (ctx) => {
  const { client, directory } = ctx

  // Resolve mode from env or default
  let mode: PluginMode =
    (process.env.HEADROOM_MODE as PluginMode) ?? DEFAULT_MODE

  // ---------------------------------------------------------------------------
  // Project context gate: check if headroom is enabled for this project
  // ---------------------------------------------------------------------------
  const projectId = readProjectIdFromAgentsMd(directory)
  let projectContext: ProjectContext | null = null

  if (projectId) {
    const nexusConfig = getNexusConfig(directory)
    if (nexusConfig) {
      projectContext = await fetchProjectContext(nexusConfig, projectId)
      if (projectContext && !projectContext.headroomEnabled) {
        // Headroom not enabled in project backend — disable transform, observe only
        await client.app.log({
          body: {
            service: PLUGIN_META.name,
            level: "warn",
            message:
              `v${PLUGIN_META.version} — headroom not enabled ` +
              `for project ${projectId}, running in observe-only mode`,
          },
        })
        fileLog(
          directory,
          `Project gate: headroom not in project plugins ` +
          `(${projectContext.plugins.join(", ")}), forcing observe-only mode`
        )
        mode = "observe"
      } else if (projectContext) {
        fileLog(directory, `Project gate: headroom enabled (project=${projectId})`)
      } else {
        fileLog(directory, `Project gate: preflight API unreachable, proceeding with configured mode=${mode}`)
      }
    } else {
      fileLog(directory, `Project gate: no Nexus API credentials, proceeding with configured mode=${mode}`)
    }
  } else {
    fileLog(directory, `Project gate: no project_id found in .nexus/AGENTS.md, proceeding with configured mode=${mode}`)
  }

  // Initialize stores
  const store = new OriginalStore(directory)
  const metrics: SessionMetrics = {
    totalCompressions: 0,
    totalObservations: 0,
    totalSkips: 0,
    totalPassthroughs: 0,
    totalSavedTokens: 0,
    events: [],
  }

  // Startup logging
  await client.app.log({
    body: {
      service: PLUGIN_META.name,
      level: "info",
      message:
        `v${PLUGIN_META.version} loaded — mode=${mode}, ` +
        `project=${projectId ?? "unknown"}, ` +
        `policies=${Object.keys(POLICIES).length}, ` +
        `minTokens=${DEFAULT_MIN_TOKENS}`,
    },
  })
  fileLog(directory, `Plugin loaded: mode=${mode}, version=${PLUGIN_META.version}, project=${projectId ?? "unknown"}`)

  return {
    // -----------------------------------------------------------------------
    // tool.execute.after — the core interception hook
    // -----------------------------------------------------------------------
    "tool.execute.after": async (input, output) => {
      const out = output as unknown as ToolOutput
      const toolName = String(input?.tool ?? "")
      if (!toolName) return

      // Look up policy — exact match, then prefix match
      let policy = POLICIES[toolName]
      if (!policy) {
        // Try prefix match for nexus_ tools without exact policy
        if (toolName.startsWith("nexus_") || toolName.startsWith("headroom_")) {
          // Default: observe unknown nexus/headroom tools but don't compress
          policy = { action: "passthrough", reason: "no-explicit-policy" }
        } else {
          // Non-nexus tools: skip entirely
          return
        }
      }

      // Skip and passthrough
      if (policy.action === "skip") {
        metrics.totalSkips++
        return
      }
      if (policy.action === "passthrough") {
        metrics.totalPassthroughs++
        return
      }

      // Compress policy — check threshold
      // MCP tools return results in output.content[].text, native tools in output.output
      const rawOutput = out.output ?? ""
      const rawContent = Array.isArray(out.content)
        ? out.content.map((c) => c?.text ?? "").join("\n")
        : ""
      const outputStr = String(rawOutput || rawContent)
      const isMcpContent = !rawOutput && !!rawContent
      if (!outputStr) return

      const estimatedTokens = estimateTokens(outputStr)
      const threshold = policy.minTokens ?? DEFAULT_MIN_TOKENS

      if (estimatedTokens < threshold) {
        metrics.totalPassthroughs++
        return
      }

      // Generate hash for the original content
      const hash = contentHash(outputStr)

      // Store original
      store.set(hash, outputStr)
      store.prune()

      // Generate compact representation
      const profile = policy.profile ?? "reference-data"
      const compact = compressByProfile(outputStr, profile, hash, toolName)
      const compressedTokens = estimateTokens(compact)
      const savedTokens = estimatedTokens - compressedTokens

      // Record metrics
      const event: CompressionMetrics = {
        tool: toolName,
        originalChars: outputStr.length,
        originalEstimatedTokens: estimatedTokens,
        compressedChars: compact.length,
        compressedEstimatedTokens: compressedTokens,
        savedEstimatedTokens: savedTokens,
        compressionRatio: compressedTokens / estimatedTokens,
        profile,
        contentHash: hash,
        timestamp: Date.now(),
      }
      metrics.events.push(event)
      metrics.totalSavedTokens += savedTokens

      if (mode === "transform") {
        // Mutate the output — this is the critical operation
        try {
          if (!isMcpContent) {
            // Native tool: mutate output.output directly
            out.output = compact
          } else if (Array.isArray(out.content) && out.content.length > 0) {
            // MCP tool: mutate first content item's text field
            out.content[0].text = compact
          } else {
            out.output = compact
          }
          metrics.totalCompressions++
          fileLog(
            directory,
            `TRANSFORM ${toolName}: ${estimatedTokens} -> ${compressedTokens} tokens ` +
            `(saved ${savedTokens}, ratio ${event.compressionRatio.toFixed(2)}, hash=${hash}, mcp=${isMcpContent})`
          )
        } catch (err) {
          // Fail-open: if mutation fails, leave original intact
          metrics.totalObservations++
          fileLog(directory, `TRANSFORM FAILED ${toolName}: ${err}`)
        }
      } else {
        // Observe mode — log but don't mutate
        metrics.totalObservations++
        fileLog(
          directory,
          `OBSERVE ${toolName}: ${estimatedTokens} tokens, ` +
          `would save ${savedTokens} (ratio ${event.compressionRatio.toFixed(2)}, hash=${hash}, mcp=${isMcpContent})`
        )
      }
    },

    // -----------------------------------------------------------------------
    // Event handler — periodic metrics logging on session idle
    // -----------------------------------------------------------------------
    event: async ({ event }) => {
      const ev = event as any
      const isIdle =
        ev.type === "session.idle" ||
        ev.name === "session.idle" ||
        ev.kind === "session.idle"

      if (isIdle && metrics.events.length > 0) {
        const summary = [
          `Headroom intercept session summary (mode=${mode}):`,
          `  Compressions: ${metrics.totalCompressions}`,
          `  Observations: ${metrics.totalObservations}`,
          `  Skips: ${metrics.totalSkips}`,
          `  Passthroughs: ${metrics.totalPassthroughs}`,
          `  Estimated tokens saved: ${metrics.totalSavedTokens}`,
        ].join("\n")
        fileLog(directory, summary)
      }
    },
  }
}
