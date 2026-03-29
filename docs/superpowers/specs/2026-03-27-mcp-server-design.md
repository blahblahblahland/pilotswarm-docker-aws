# PilotSwarm MCP Server — Design Spec

**Date:** 2026-03-27
**Branch:** `feat/mcp-support`
**Status:** Implemented

## Overview

A standalone MCP (Model Context Protocol) server that exposes PilotSwarm's full control surface — sessions, agents, facts, and models — to any MCP-compatible client (Claude Desktop, Cursor, custom agents, etc.).

The server lives in `packages/mcp-server` as a new monorepo workspace, importing from `@pilotswarm/sdk` the same way the CLI does. It connects to PilotSwarm's PostgreSQL backend and acts as another client of the durable execution engine.

## Architecture

```
MCP Client (Claude Desktop / Cursor / etc.)
    |  stdio or HTTP/SSE
    v
packages/mcp-server
    |  imports
    v
packages/sdk (PilotSwarmClient, ManagementClient, FactStore, ModelProviders)
    |  PostgreSQL
    v
PilotSwarm DB (duroxide + CMS + facts)
```

The MCP server does not embed a worker. It is a pure client that reads/writes through the SDK's existing APIs. PilotSwarm workers must be running separately (locally via `run.sh`, on EC2 via systemd, or on AKS) for sessions to execute.

## Transports

### stdio (default)

- Standard for local MCP servers
- No authentication — inherently sandboxed by the OS process model
- MCP clients launch it as a subprocess
- Logs go to stderr (stdout reserved for MCP protocol)

### Streamable HTTP

- Enabled via `--transport http`
- Default port: 3100, single `/mcp` endpoint
- Bearer token auth via `PILOTSWARM_MCP_KEY` environment variable
- Uses `NodeStreamableHTTPServerTransport` (SSE transport is deprecated since MCP spec 2025-03-26)
- Supports streaming responses via SSE when needed, JSON for simple request/response
- Binds to `127.0.0.1` by default (prevents DNS rebinding attacks)

## MCP Tools (17)

### Session Management (7 tools)

#### `create_session`
Create a new PilotSwarm session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `model` | string | no | Qualified model name (e.g., `github-copilot:claude-sonnet-4.6`) |
| `agent` | string | no | Agent name to bind the session to |
| `system_message` | string | no | Custom system prompt |
| `title` | string | no | Display title |

Returns: `{ session_id, status, model, title }`

#### `send_message`
Fire-and-forget: send a message to a session. Returns immediately.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | yes | Target session |
| `message` | string | yes | User message |

Returns: `{ sent: true }`

#### `send_and_wait`
Send a message and block until the session responds.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | yes | Target session |
| `message` | string | yes | User message |
| `timeout_ms` | number | no | Timeout in ms (default: 120000) |

Returns: `{ response: string, status: string }` or `{ error: "timeout" }`

#### `send_answer`
Answer a pending `input_required` question.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | yes | Target session |
| `answer` | string | yes | The answer |

Returns: `{ sent: true }`

#### `abort_session`
Cancel a running session's current orchestration.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | yes | Target session |
| `reason` | string | no | Cancellation reason |

Returns: `{ aborted: true }`

#### `rename_session`
Rename a session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | yes | Target session |
| `title` | string | yes | New title |

Returns: `{ renamed: true }`

#### `delete_session`
Delete a session and its data.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | yes | Target session |

Returns: `{ deleted: true }`

### Agent Operations (3 tools)

#### `spawn_agent`
Spawn a sub-agent within a session via orchestration command.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | yes | Parent session |
| `task` | string | yes | Task description for the agent |
| `agent_name` | string | no | Named agent definition to use |
| `model` | string | no | Model override |

Returns: `{ agent_id, session_id: child_session_id }`

#### `message_agent`
Send a message to a running sub-agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | yes | Parent session |
| `agent_id` | string | yes | Target agent |
| `message` | string | yes | Message to send |

Returns: `{ sent: true }`

#### `cancel_agent`
Cancel a running sub-agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | yes | Parent session |
| `agent_id` | string | yes | Target agent |
| `reason` | string | no | Cancellation reason |

Returns: `{ cancelled: true }`

### Facts / Knowledge (3 tools)

#### `store_fact`
Store a fact in the knowledge store.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | yes | Fact key (e.g., `infra/server/fqdn`) |
| `value` | any | yes | JSON-serializable value |
| `tags` | string[] | no | Tags for querying |
| `shared` | boolean | no | Cross-session visibility (default: false) |
| `session_id` | string | no | Owning session |

Returns: `{ key, stored: true }`

#### `read_facts`
Query facts by pattern, tags, or scope.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key_pattern` | string | no | SQL wildcard or glob pattern |
| `tags` | string[] | no | Filter by tags (all must match) |
| `session_id` | string | no | Filter by session |
| `scope` | string | no | `accessible`, `shared`, `session`, `descendants` |
| `limit` | number | no | Max results (default: 50) |

Returns: `{ count, facts: [{ key, value, tags, session_id, created_at }] }`

#### `delete_fact`
Delete a fact.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | yes | Fact key |
| `session_id` | string | no | Owning session |

Returns: `{ key, deleted: true }`

### Model Management (1 tool)

#### `switch_model`
Change the model for a session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | yes | Target session |
| `model` | string | yes | Qualified model name |

Returns: `{ switched: true, model }`

### Commands (1 tool)

#### `send_command`
Send an arbitrary orchestration command to a session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | yes | Target session |
| `command` | string | yes | Command name |
| `args` | object | no | Command arguments |

Returns: `{ sent: true }`

## MCP Resources (5)

### `pilotswarm://sessions`
List all sessions with their current status.

Returns array of:
```json
{
  "session_id": "...",
  "title": "...",
  "status": "running|idle|waiting|input_required|completed|failed",
  "model": "...",
  "agent_id": "...",
  "is_system": false,
  "created_at": "...",
  "updated_at": "..."
}
```

### `pilotswarm://sessions/{id}`
Detailed session info.

Returns:
```json
{
  "session_id": "...",
  "title": "...",
  "status": "...",
  "model": "...",
  "iterations": 5,
  "pending_question": { "question": "...", "choices": [...] },
  "waiting_until": "...",
  "wait_reason": "...",
  "parent_session_id": "...",
  "result": "...",
  "error": "..."
}
```

### `pilotswarm://sessions/{id}/messages`
Chat history for a session. Supports `?limit=N` query parameter.

Returns array of session events (user messages, assistant responses, tool calls, status changes).

### `pilotswarm://facts?pattern={pattern}`
Query the facts store. Supports query parameters: `pattern`, `tags`, `scope`, `limit`.

### `pilotswarm://models`
Available models grouped by provider.

Returns:
```json
[
  {
    "provider_id": "github-copilot",
    "type": "github",
    "models": [
      { "name": "claude-sonnet-4.6", "description": "...", "cost": "medium" }
    ]
  }
]
```

## MCP Prompts

PilotSwarm skills (loaded from `SKILL.md` files in plugin directories) are exposed as MCP prompts.

Each skill becomes:
- **Name:** `skill:{skill-name}`
- **Description:** From SKILL.md frontmatter `description` field
- **Body:** The full SKILL.md markdown content

This allows MCP clients to browse and use PilotSwarm skills as prompt templates.

## Package Structure

```
packages/mcp-server/
├── package.json              # @pilotswarm/mcp-server
├── tsconfig.json
├── bin/
│   └── pilotswarm-mcp.ts     # CLI entry point
└── src/
    ├── index.ts               # Public API: createMcpServer()
    ├── server.ts              # MCP server setup, tool/resource/prompt registration
    ├── context.ts             # Shared server context (clients, stores, config)
    ├── tools/
    │   ├── sessions.ts        # 7 session management tools
    │   ├── agents.ts          # 3 agent operation tools
    │   ├── facts.ts           # 3 facts store tools
    │   └── models.ts          # 1 model management tool + 1 command tool
    ├── resources/
    │   ├── sessions.ts        # Session list, detail, messages
    │   ├── facts.ts           # Facts query
    │   └── models.ts          # Models list
    ├── prompts/
    │   └── skills.ts          # Skills -> MCP prompts adapter
    └── auth.ts                # Bearer token middleware (HTTP transport)
```

## CLI Interface

```
npx pilotswarm-mcp [options]

Options:
  --transport <stdio|http>   Transport mode (default: stdio)
  --port <number>            HTTP port (default: 3100)
  --store <url>              PostgreSQL URL (or env: DATABASE_URL)
  --plugin <dir>             Plugin directory (repeatable)
  --model-providers <path>   Path to .model_providers.json
  --log-level <level>        Log level (default: error for stdio, info for http)
```

## Authentication

- **stdio:** No auth. Process-level isolation is sufficient.
- **HTTP/SSE:** Bearer token via `PILOTSWARM_MCP_KEY` env var. Requests without a valid `Authorization: Bearer <key>` header are rejected with 401. If the env var is not set, HTTP transport refuses to start (fail-safe).

## Dependencies

- `@modelcontextprotocol/sdk` — MCP server SDK
- `@pilotswarm/sdk` — PilotSwarm client, management client, fact store, model providers
- No new external dependencies beyond these two

## Error Handling

- Tool calls that fail return structured MCP errors with human-readable messages
- Invalid session IDs return "session not found" errors
- DB connection failures surface as server-level errors
- HTTP auth failures return 401 before reaching tool dispatch

## Integration Example

### Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "pilotswarm": {
      "command": "npx",
      "args": ["pilotswarm-mcp", "--store", "postgresql://localhost:5432/pilotswarm"],
      "env": {
        "GITHUB_TOKEN": "gho_..."
      }
    }
  }
}
```

### Cursor (`.cursor/mcp.json`)
```json
{
  "pilotswarm": {
    "type": "local",
    "command": "npx",
    "args": ["pilotswarm-mcp", "--store", "postgresql://localhost:5432/pilotswarm"]
  }
}
```

### Remote HTTP
```bash
PILOTSWARM_MCP_KEY=secret123 npx pilotswarm-mcp --transport http --port 3100 --store $DATABASE_URL
```
