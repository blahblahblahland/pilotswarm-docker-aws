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

## Deployment

### Local Development (Docker Compose)

PilotSwarm includes a `docker-compose.yml` that starts PostgreSQL and builds the app.

**Prereqs:**
- Create a local `.env` in the repo root with:

```bash
DATABASE_URL=postgresql://postgres:admin@postgres:5432/pilotswarm
GITHUB_TOKEN=<your-copilot-token>
WORKERS=1
```

**Start PostgreSQL:**

```bash
docker compose up -d postgres
```

**Run the TUI:**

```bash
docker compose run --rm -it -v “${PWD}/.env:/app/.env:ro” pilotswarm node bin/tui.js
```

**View Logs:**

```bash
docker exec -i <container_name> sh -lc “tail -n 200 /tmp/duroxide-tui.log”
```

### Production: AWS Fargate + Neon PostgreSQL + Vercel

A complete serverless stack with zero infrastructure management:

**Stack Overview:**
- **Database:** [Neon](https://neon.tech) (serverless PostgreSQL, 5GB free tier)
- **Worker:** AWS Fargate (serverless containers, ECS)
- **Web UI:** Vercel (serverless Next.js)
- **Blob Storage:** S3 (session dehydration)
- **Optional:** CloudWatch (CPU/memory metrics in Stats tab)

**Setup Steps:**

1. **Neon Database:**
   - Create a free Neon account and database
   - Copy the connection string: `postgresql://user:password@host/dbname?sslmode=require`
   - Set `DATABASE_URL` to this connection string (must include `?sslmode=require` for Neon)

2. **AWS ECS + Fargate:**
   - Create a new ECS cluster (Fargate launch type)
   - Create a task definition using the PilotSwarm Docker image
   - Provide env vars: `DATABASE_URL`, `GITHUB_TOKEN`, `AWS_S3_BUCKET`, `AWS_REGION` (for blob storage)
   - Create a service that runs 1+ worker task
   - Set CPU/memory: 256 CPU, 512 MB memory minimum (can scale higher)

3. **Vercel Web Dashboard:**
   - Deploy the `apps/web` Next.js app to Vercel
   - Set env vars: `DATABASE_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` (for Stats tab CPU metric)
   - The web UI will:
     - Display real-time stats (tokens in/out, agents running, worker CPU from CloudWatch)
     - Show inspector tabs: Activity, Logs (with per-tool durations), Files, Details, Stats
     - Allow session control: spawn, rename, delete
     - Stream chat in real-time

4. **System Agents (automatic):**
   - **Sweeper:** Runs every 30 minutes, cleans up completed sessions and orchestration history (reduces idle token cost)
   - **ResourceMgr:** Runs every 24 hours, monitors storage/database and auto-cleanup old events (< 24h retention)

**Cost Estimate (low usage):**
- Neon: Free tier ($20/month paid)
- Fargate: ~$15–30/month (2–4 vCPU hours per day, on-demand pricing)
- Vercel: Free tier ($20/month Pro)
- S3: ~$0.50/month (session dehydration)
- **Total:** ~$55/month (free tier components) or free for prototyping

**Important Notes:**
- Neon's free tier includes 5GB monthly transfer — enough for ~1000 sessions/day
- Fargate requires explicit VPC + security group setup; see AWS ECS console for one-click setup
- ResourceMgr's infrastructure stats require CloudWatch (enabled by default on ECS); the Stats tab will show “n/a” for CPU if AWS credentials are not set
- Session recovery is automatic — if a worker pod terminates unexpectedly, any other worker will resume the session from the last state

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](docs/getting-started.md) | From zero to running — PostgreSQL, GitHub token, `.env` |
| [User Guide](docs/guide.md) | Runtime concepts, API reference, standard vs durable comparison |
| [Configuration](docs/configuration.md) | PostgreSQL, blob storage, environment variables, worker/client options |
| [Deployment](DEPLOYMENT.md) | Production stack guide: Fargate + Neon + Vercel, system agents, token optimization |
| [Examples](docs/examples.md) | Chat app, TUI, worker, and test suite walkthrough |
| [Architecture](docs/architecture.md) | Internal design — orchestrations, session proxy, dehydration |

## Requirements

- Node.js >= 24
- PostgreSQL (local [docker compose], cloud [Neon], or self-hosted)
- GitHub Copilot access token or BYOK LLM provider
- Blob Storage (optional): Azure Blob, S3, or local filesystem for session dehydration
- AWS Credentials (optional): for CloudWatch metrics in Stats tab

## License

MIT
