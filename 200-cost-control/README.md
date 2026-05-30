# Cost Control

An [OpenCode](https://opencode.ai) plugin that brings token usage and cost
visibility to [Nexus](https://nexus.gatewarden.eu) sessions.

This plugin is a **Nexus-aware wrapper and extender for
[Helicone](https://helicone.ai)** — an LLM observability proxy that records
every request: token counts, latency, model, and estimated cost in USD.
Helicone does the heavy lifting; this plugin connects Helicone data to the
Nexus session timeline so costs are visible alongside work history.

## What Helicone does

Helicone sits as a transparent proxy between your agent and the LLM provider
(Anthropic, OpenAI, etc.). Every LLM call is recorded with:

- Input / output / cache token counts
- Estimated cost in USD (using published model pricing)
- Latency and model name
- Custom session/property headers for grouping

You route requests through Helicone by changing the provider base URL, e.g.:

| Provider | Original | Via Helicone |
|----------|----------|--------------|
| Anthropic | `https://api.anthropic.com` | `https://anthropic.helicone.ai` |
| OpenAI | `https://api.openai.com` | `https://oai.helicone.ai` |

## What this plugin adds

1. **Session grouping**: injects the active Nexus session ID as a
   `Helicone-Session-Id` property so every LLM call in a Nexus session is
   grouped and queryable in the Helicone dashboard.
2. **Automatic cost recording**: on `session.idle` (agent finishes a work
   burst), queries the Helicone API for cumulative token + cost data and
   appends a structured summary to the Nexus session timeline.
3. **On-demand cost tool**: exposes `nexus_cost_summary` so the agent can pull
   a live cost snapshot at any time.

## Installation

```bash
# Copy into your project's OpenCode plugins directory
cp nexus-cost-control.ts /path/to/your-project/.opencode/plugins/
```

Ensure `.opencode/package.json` includes the plugin SDK:

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "^1.14.0"
  }
}
```

## Configuration

### 1. Set environment variables

```bash
export HELICONE_API_KEY="sk-helicone-..."
# Nexus credentials (auto-read from ~/.config/nexus/ if CLI is configured)
export NEXUS_API_URL="https://nexus.gatewarden.eu"
export NEXUS_PRIVATE_TOKEN="nxs_pat_..."
```

`HELICONE_API_KEY` can also be stored in `~/.config/nexus/config.toml`:

```toml
helicone_api_key = "sk-helicone-..."
```

### 2. Route requests through Helicone

In your `opencode.json`, change the provider base URL and add the session
header. Example for Anthropic:

```json
{
  "provider": {
    "anthropic": {
      "baseURL": "https://anthropic.helicone.ai",
      "options": {
        "defaultHeaders": {
          "Helicone-Auth": "Bearer sk-helicone-...",
          "Helicone-Session-Id": "${NEXUS_SESSION_ID}"
        }
      }
    }
  }
}
```

> Note: The `nexus-compaction-plus` plugin exposes the active Nexus session ID
> via the `NEXUS_SESSION_ID` convention. When both plugins are loaded, session
> grouping works automatically.

### 3. Nexus MCP server (required for timeline recording)

```json
{
  "mcp": {
    "nexus": {
      "type": "local",
      "command": ["npx", "--yes", "@gwdn/nexus-mcp@latest"],
      "environment": {
        "NEXUS_API_URL": "https://nexus.gatewarden.eu",
        "NEXUS_PRIVATE_TOKEN": "nxs_pat_..."
      }
    }
  }
}
```

## How it works

### `session.idle` → cost recording

When the agent finishes a work burst and goes idle, the plugin:

1. Fetches the active OpenCode session messages
2. Extracts the Nexus session ID from tool call history
3. Queries `POST https://api.helicone.ai/v1/request/query` filtering by
   `Helicone-Session-Id = <nexus-session-id>`
4. Aggregates token counts and cost across all matched requests
5. Appends a structured markdown table to the Nexus session via the MCP API

Recording is debounced — at most once every 5 minutes — to avoid spamming the
timeline during rapid back-and-forth sessions.

### `nexus_cost_summary` tool

The agent can call this at any time to get a live cost snapshot:

```
## Token & Cost Summary — 14:32
Tracked via Helicone · nexus-cost-control v1.0.0

| Metric            | Value        |
|-------------------|--------------|
| Requests          | 47           |
| Input tokens      | 124,500      |
| Output tokens     | 32,100       |
| Cache read tokens | 80,000       |
| Cache write tokens| 44,500       |
| Total tokens      | 156,600      |
| Estimated cost    | $0.084200    |
| Models            | claude-opus-4|
```

## Relationship to `opencode-helicone-session`

The community plugin
[opencode-helicone-session](https://github.com/H2Shami/opencode-helicone-session)
automatically injects Helicone session headers for request grouping.

`nexus-cost-control` focuses on the **Nexus integration layer**: recording cost
data in the session timeline and exposing cost tooling to the agent. The two
plugins are complementary and can be used together.

## License

MIT — see [LICENSE](../LICENSE)
