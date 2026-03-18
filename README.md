# PilotSwarm

> **Experimental** — This project is under active development and not yet ready for production use. APIs may change without notice.

A durable execution runtime for [GitHub Copilot SDK](https://github.com/github/copilot-sdk) agents. Crash recovery, durable timers, session dehydration, and multi-node scaling — powered by [duroxide](https://github.com/microsoft/duroxide). Just add a connection string.

## Quick Start

```bash
npm install pilotswarm
cp .env.example .env
# edit .env with DATABASE_URL and GITHUB_TOKEN
```

```typescript
import { PilotSwarmClient, PilotSwarmWorker, defineTool } from "pilotswarm";

// Define tools — same API as Copilot SDK
const getWeather = defineTool("get_weather", {
    description: "Get weather for a city",
    parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
    },
    handler: async ({ city }) => {
        const res = await fetch(`https://wttr.in/${city}?format=j1`);
        return await res.json();
    },
});

// Start a worker (runs LLM turns, executes tools)
const worker = new PilotSwarmWorker({
    store: process.env.DATABASE_URL,          // PostgreSQL connection string
    githubToken: process.env.GITHUB_TOKEN,
});
worker.registerTools([getWeather]);           // register tools at the worker level
await worker.start();

// Start a client (manages sessions — can run on a different machine)
const client = new PilotSwarmClient({
    store: process.env.DATABASE_URL,
});
await client.start();

// Create a session — reference tools by name (serializable)
const session = await client.createSession({
    toolNames: ["get_weather"],
    systemMessage: "You are a weather assistant.",
});

const response = await session.sendAndWait("Check NYC weather every hour for 8 hours");
console.log(response);
// The agent calls wait(3600) between checks — the process shuts down,
// a durable timer fires an hour later, and any worker resumes the session.

await client.stop();
await worker.stop();
```

## What You Get

| Feature | Copilot SDK | PilotSwarm |
|---------|-------------|---------------------|
| Tool calling | ✅ | ✅ Same `defineTool()` API |
| Wait/pause | ❌ Blocks process | ✅ Durable timer — process shuts down, resumes later |
| Crash recovery | ❌ Session lost | ✅ Automatic resume from last state |
| Multi-node | ❌ Single process | ✅ Sessions migrate between worker pods |
| Session persistence | ❌ In-memory | ✅ PostgreSQL + Azure Blob Storage |
| Event streaming | ❌ Local only | ✅ Cross-process event subscriptions |

## How It Works

The runtime automatically injects a `wait` tool into every session. When the LLM needs to pause:

1. **Short waits** (< 30s) — sleep in-process
2. **Long waits** (≥ 30s) — dehydrate session to blob storage → durable timer → any worker hydrates and continues

```
Client                        PostgreSQL                     Worker Pods
  │                              │                              │
  │── send("monitor hourly") ──→ │                              │
  │                              │── orchestration queued ────→ │
  │                              │                              │── runTurn (LLM)
  │                              │                              │── wait(3600)
  │                              │                              │── dehydrate → blob
  │                              │── durable timer (1 hour) ──→ │
  │                              │                              │── hydrate ← blob
  │                              │                              │── runTurn (LLM)
  │                              │                              │── response
  │←── result ──────────────────│                              │
```

## Examples

| Example | Description | Command |
|---------|-------------|---------|
| [Chat](examples/chat.js) | Interactive console chat | `npm run chat` |
| [TUI](cli/tui.js) | Multi-session terminal UI with logs | `npx pilotswarm-tui` |
| [Worker](examples/worker.js) | Headless worker for K8s | `npm run worker` |
| [Tests](test/sdk.test.js) | Automated test suite | `npm test` |

## Run with Docker

PilotSwarm includes a `docker-compose.yml` that starts PostgreSQL and builds the app image.

### Prereqs

- Create a local `.env` in the repo root (do **not** commit it) with at least:

```bash
DATABASE_URL=postgresql://postgres:admin@postgres:5432/pilotswarm
GITHUB_TOKEN=...
WORKERS=1
```

Notes:
- Inside Docker Compose, the PostgreSQL host must be `postgres` (the compose service name), not `localhost`.
- If your Copilot token has no entitlement/quota, worker turns will fail with `402 You have no quota`. In that case, use a BYOK provider via `model_providers.json` / `LLM_API_KEY` instead.

### Start PostgreSQL

```bash
docker compose up -d postgres
```

### Run the TUI (recommended)

The TUI will best-effort load `/app/.env`, so mounting your `.env` file is the most reliable approach across shells/Compose variants:

```bash
docker compose run --rm -it -v "${PWD}/.env:/app/.env:ro" pilotswarm node bin/tui.js
```

### Logs and troubleshooting

- Worker/runtime logs are written to `/tmp/duroxide-tui.log` inside the container. To inspect:

```bash
docker exec -i <container_name> sh -lc "tail -n 200 /tmp/duroxide-tui.log"
```

- If the UI looks “blank” during startup, check for missing env warnings in the left pane and confirm your `.env` is mounted into `/app/.env`.

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](docs/getting-started.md) | From zero to running — PostgreSQL, GitHub token, `.env`, AKS |
| [User Guide](docs/guide.md) | Runtime concepts, API reference, standard vs durable comparison |
| [Configuration](docs/configuration.md) | PostgreSQL, blob storage, environment variables, worker/client options |
| [Deploying to AKS](docs/deploying-to-aks.md) | Kubernetes deployment, scaling, rolling updates |
| [Examples](docs/examples.md) | Chat app, TUI, worker, and test suite walkthrough |
| [Architecture](docs/architecture.md) | Internal design — orchestrations, session proxy, dehydration |

## Requirements

- Node.js >= 24
- PostgreSQL
- GitHub Copilot access token (worker-side only)
- Azure Blob Storage (optional, for session dehydration across nodes)

## License

MIT
