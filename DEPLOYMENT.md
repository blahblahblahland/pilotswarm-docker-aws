# PilotSwarm — Deployment Guide

This documents the full deployment stack used for this fork:
- **Worker backend** → AWS Fargate (ECS) + ECR
- **Database** → Neon PostgreSQL (serverless)
- **Session blobs** → AWS S3
- **Frontend** → Vercel (Next.js, `apps/web/`)

---

## Architecture Overview

```
Browser
  │
  └─► Vercel (apps/web/ Next.js)
        │  REST + SSE  (no WebSocket — Vercel-compatible)
        │
        └─► Neon PostgreSQL ◄─── AWS Fargate worker
                                        │
                                        └─► AWS S3  (session blobs / artifacts)
```

The **worker** is the AI backend. It polls the database for pending orchestration jobs,
runs GitHub Copilot SDK agents, and stores session state in S3.
The **web frontend** reads from the same Neon database via REST/SSE API routes.

---

## Prerequisites

| Tool | Purpose |
|------|---------|
| Node.js ≥ 24 | Build the worker TypeScript |
| Docker Desktop | Build the worker container image |
| AWS CLI | Push images to ECR; deploy to ECS |
| Vercel CLI (`npm i -g vercel`) | Deploy the web frontend |
| A GitHub account | GitHub Copilot token (LLM provider) |

---

## 1. Environment Variables

Create `.env` at the project root (never commit this file):

```env
# Database (Neon — get connection string from neon.tech console)
DATABASE_URL=postgresql://<user>:<password>@<host>/<db>?sslmode=require

# GitHub Copilot token (Personal Access Token or Copilot App token)
GITHUB_TOKEN=ghp_...

# AWS — S3 bucket for session blobs
AWS_S3_BUCKET=<your-bucket-name>
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=<your-key-id>
AWS_SECRET_ACCESS_KEY=<your-secret>

# Worker concurrency (optional, default 1)
WORKERS=1
```

> **Security:** `.env` is gitignored. Never commit real credentials.
> Rotate any keys that were ever pushed to a public repo.

---

## 2. Neon PostgreSQL Setup

1. Create a free project at [neon.tech](https://neon.tech).
2. Copy the **connection string** from the Neon console → Connection Details.
3. Paste it as `DATABASE_URL` in your `.env`.
4. The worker auto-creates all required schemas on first run
   (`duroxide` orchestration tables + `cms` session/event tables).

**Free tier limit:** 5 GB/month data transfer.
The Sweeper runs every 30 min and ResourceMgr runs every 24 hr to keep idle usage low.
The limit resets on the 1st of each month.

---

## 3. AWS Setup

### 3a. ECR (container registry)

```bash
# Create the ECR repository (one-time)
aws ecr create-repository --repository-name pilotswarm-worker --region us-east-1
```

The repository URI will be: `<account-id>.dkr.ecr.us-east-1.amazonaws.com/pilotswarm-worker`

Update these files with your AWS account ID:
- `deploy/ecs/task-definition.json` — `executionRoleArn`, `taskRoleArn`, `image`
- `package.json` → `docker:push` script

### 3b. S3 Bucket (session blobs)

```bash
# Create the S3 bucket (one-time)
aws s3 mb s3://pilotswarm-sessions-<account-id>-us-east-1 --region us-east-1

# Block public access
aws s3api put-public-access-block \
  --bucket pilotswarm-sessions-<account-id>-us-east-1 \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

Set `AWS_S3_BUCKET` in `.env` to the bucket name you chose.

---

## 4. Build the Worker Image

```bash
# From project root:
npm run build             # compile TypeScript → dist/
npm run docker:build      # build Docker image (deploy/Dockerfile.worker)
npm run docker:push       # push to ECR (must be aws-cli logged in)
```

Or manually:
```bash
# Authenticate Docker to ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-east-1.amazonaws.com

# Build and push
docker buildx build --platform linux/amd64 \
  -f deploy/Dockerfile.worker \
  -t <account-id>.dkr.ecr.us-east-1.amazonaws.com/pilotswarm-worker:latest \
  --push .
```

---

## 5. Deploy Worker to AWS Fargate

The deploy script handles everything in one shot (IAM roles, SSM secrets,
CloudWatch logs, ECS cluster, task definition, service):

```bash
# Make sure .env is populated, then:
bash deploy/ecs/deploy.sh
```

What it does:
1. Creates `ecsTaskExecutionRole` IAM role (ECS task execution + SSM read)
2. Creates `pilotswarm-task-role` IAM role (S3 full access for the worker)
3. Stores secrets in SSM Parameter Store (`/pilotswarm/*`)
4. Creates CloudWatch log group `/ecs/pilotswarm-worker`
5. Creates ECS cluster `pilotswarm` with FARGATE + FARGATE_SPOT capacity
6. Registers task definition from `deploy/ecs/task-definition.json`
7. Creates (or updates) ECS service with 1 Fargate task

**Monitor after deploy:**
```bash
npm run ecs:status    # check service health
npm run ecs:logs      # tail CloudWatch logs live
```

**Redeploy after code changes:**
```bash
npm run build && npm run docker:build && npm run docker:push
aws ecs update-service --cluster pilotswarm --service pilotswarm-worker \
  --force-new-deployment --region us-east-1
```

---

## 6. Deploy Frontend to Vercel

The frontend lives in `apps/web/` and is a standard Next.js app.

### 6a. One-time setup

```bash
cd apps/web
vercel link           # link to your Vercel project
```

Or connect via the Vercel dashboard → Import Git Repository → point to your fork.

### 6b. Environment variables in Vercel

In Vercel dashboard → Settings → Environment Variables, add:

| Key | Value |
|-----|-------|
| `DATABASE_URL` | Your Neon connection string |

The web app only needs `DATABASE_URL`. AWS credentials are NOT needed in Vercel
— only the worker touches S3.

### 6c. Deploy

Vercel auto-deploys on push to `main`. To deploy manually:

```bash
cd apps/web
vercel --prod
```

Or push to main from the repo root:
```bash
git checkout main
git merge dev_docker --ff-only   # or your working branch
git push origin main
```

> **Important:** Vercel watches the `main` branch. Changes on other branches
> will NOT trigger a production deploy automatically.

### 6d. Vercel build settings

Vercel auto-detects Next.js. The `vercel-build` script in root `package.json`
pre-builds the pilotswarm package before the Next.js build runs — no manual
configuration needed.

---

## 7. Repository Structure

```
pilotswarm/
├── src/                    # Worker runtime source (TypeScript)
├── dist/                   # Compiled output (gitignored)
├── examples/worker.js      # Worker entry point
├── plugin/
│   └── agents/             # System agent definitions (.agent.md)
│       ├── sweeper.agent.md        # Cleanup — runs every 30 min
│       └── resourcemgr.agent.md   # Monitoring — runs every 24 hr
├── apps/web/               # Next.js frontend (deployed to Vercel)
│   ├── src/app/
│   │   ├── api/            # REST + SSE API routes
│   │   └── sessions/       # Main UI (sessions-shell.tsx)
├── deploy/
│   ├── Dockerfile.worker   # Worker container image
│   ├── ecs/
│   │   ├── deploy.sh       # One-command Fargate deploy
│   │   └── task-definition.json
├── .env                    # Secrets — NEVER commit with real values
└── DEPLOYMENT.md           # This file
```

---

## 8. Cost Optimization Notes

These changes were made to reduce idle usage on free/low-cost tiers:

| Component | Before | After | Reason |
|-----------|--------|-------|--------|
| Sweeper interval | 60 sec | 30 min | Reduced LLM + Neon DB calls by 30x |
| ResourceMgr interval | 5 min | 24 hr | Monitoring only needed daily |
| ResourceMgr auto-cleanup | every 30 min | every cycle (24 hr) | Consolidated into single daily run |

**Neon free tier:** 5 GB/month transfer. With the reduced intervals the idle
DB traffic is ~97% lower. The limit resets on the 1st of each month.

**Fargate cost:** 1 task × 0.25 vCPU × 0.5 GB = ~$8/month.
FARGATE_SPOT is already enabled in the cluster config — use it to cut this by ~70%.

---

## 9. Secrets Reference

All secrets are stored in AWS SSM Parameter Store under `/pilotswarm/*`
and injected into the Fargate task at runtime. The deploy script handles this automatically.

| Secret | Where used |
|--------|-----------|
| `DATABASE_URL` | Worker + Web (Neon connection string) |
| `GITHUB_TOKEN` | Worker only (Copilot LLM calls) |
| `AWS_S3_BUCKET` | Worker only (session blob store) |
| `AWS_ACCESS_KEY_ID` | Worker only (S3 access) |
| `AWS_SECRET_ACCESS_KEY` | Worker only (S3 access) |
