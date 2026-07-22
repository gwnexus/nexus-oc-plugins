# nexus-session-guard

An [OpenCode](https://opencode.ai) plugin that enforces session append discipline
for the [Nexus](https://nexus.gatewarden.eu) platform.

**Current version:** `v1.0.0`  
**Requires:** Nexus MCP server (active session)

## What it does

Agents frequently skip `nexus_session_append` calls after completing work,
leaving gaps in the session audit trail. This plugin detects code-changing tool
completions and injects a system reminder when no session entry has been
recorded since the last user instruction.

## How it works

```
User message → lastUserTurnIndex++
Agent calls Edit/Write/Bash → plugin checks: was session_append called?
  → YES (lastAppendTurnIndex >= lastUserTurnIndex): no action
  → NO: inject system reminder into tool output
Agent calls nexus_session_append → lastAppendTurnIndex = lastUserTurnIndex
```

### Trigger tools

| Tool | Condition |
|------|-----------|
| `Edit`, `Write`, `MultiEdit` | Always triggers |
| `Bash` | Only if command is non-read-only (heuristic filter) |
| `nexus_task_create` | Always triggers |
| `nexus_adr_create` | Always triggers |
| `nexus_adr_decide` | Always triggers |

### Hooks

- **`tool.execute.after`** — detects trigger tools and injects reminders
- **`event`** (`message.created`) — tracks user turn index

## Installation

Copy into your project's OpenCode plugins directory:

```bash
cp nexus-session-guard.ts /path/to/your-project/.opencode/plugins/
```

Ensure `.opencode/package.json` includes the plugin SDK:

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "^1.14.0"
  }
}
```

## Testing

```bash
npm test -- 400-session-guard
```

17 unit tests covering trigger detection, reminder injection, state machine
transitions, Bash heuristics, MCP content shape, and user turn tracking.

## Logs

Debug logs are written to `.nexus/session-guard.log`.

## Architecture Decision

See ADR-0066: Session Guard Plugin (`d5f0735d-bc48-44c9-be2a-96753206a264`, NEXUS-APP).

## License

Apache-2.0 — see [LICENSE](../LICENSE)
