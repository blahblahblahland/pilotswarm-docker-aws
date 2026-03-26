## PilotSwarm Web UI

Minimal web console for managing PilotSwarm sessions. It talks directly to the same PostgreSQL database your worker/client use.

### Prerequisites

- Node 24+
- PostgreSQL running with the same `DATABASE_URL` used by your PilotSwarm worker/client
- `pilotswarm` built at the repo root (`npm install && npm run build` at the root)

### Configure

From this `apps/web` directory:

```bash
cp .env.local.example .env.local
```

Then edit `.env.local`:

- **DATABASE_URL**: point to the same database as `DATABASE_URL` in the root `.env`
- **PILOTSWARM_DEFAULT_MODEL** (optional): set to a qualified model from `model_providers.json`, for example:

```bash
PILOTSWARM_DEFAULT_MODEL=anthropic:claude-3-5-sonnet-20241022
```

Make sure `model_providers.json` at the repo root has your providers and models configured (GitHub, Azure OpenAI, Anthropic, etc.) and that any referenced env vars (for example `ANTHROPIC_API_KEY`) are set when you run the worker.

### Run the worker + web UI

In two terminals:

```bash
# 1) At repo root: start a worker against DATABASE_URL
node --env-file=.env.remote examples/worker.js

# 2) In apps/web: start the web dev server
cd apps/web
npm install
npm run dev
```

Then open `http://localhost:3000` and go to the **Sessions** view.

### Production build

```bash
cd apps/web
npm run build
npm run start
```

> Note: the build process will require the `duroxide` native dependency for your platform to be installed correctly in `node_modules`. If a `duroxide-*-*-*` binary is missing you will see a build-time error; rerun `npm install` at the repo root so `duroxide` can download the appropriate binary for your OS/architecture.

