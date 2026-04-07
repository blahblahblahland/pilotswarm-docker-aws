# Deploying PilotSwarm Workers to EC2

This guide covers the recommended EC2 deployment shape for this repo:

- one or more **headless workers** on EC2
- **managed PostgreSQL** for duroxide + CMS state
- **Amazon S3** for session archives and artifacts
- **Amazon ECR** for the worker image
- the **TUI stays on your laptop** and connects in remote mode

This matches the current repo runtime model:

- [`packages/sdk/examples/worker.js`](../packages/sdk/examples/worker.js) runs a headless worker
- [`deploy/Dockerfile.worker`](../deploy/Dockerfile.worker) builds the worker image
- `npm run tui:remote` runs the TUI as a client-only admin tool

## Recommended Topology

```text
Local laptop
  └─ TUI remote mode
        │
        ▼
Managed PostgreSQL  <──────>  EC2 worker instance(s)
        │                         └─ Docker + systemd
        ▼
Amazon S3
  ├─ <sessionId>.tar.gz
  ├─ <sessionId>.meta.json
  └─ artifacts/<sessionId>/<filename>
```

## 1. AWS Infrastructure

Create these resources first:

### EC2

- Ubuntu 24.04 LTS
- security group:
  - allow SSH from your admin IP only
  - no inbound app port is required for worker-only deployment
- instance profile / IAM role with:
  - ECR pull permissions
  - S3 access to the PilotSwarm bucket
  - optional CloudWatch Logs permissions

### PostgreSQL

Use managed PostgreSQL, for example:

- Amazon RDS PostgreSQL
- an existing managed PostgreSQL instance

The worker needs one `DATABASE_URL` that points to the same database your remote TUI/client will use.

### S3

Use the existing worker bucket for:

- `<sessionId>.tar.gz`
- `<sessionId>.meta.json`
- `artifacts/<sessionId>/<filename>`

For standard AWS S3, you can omit `AWS_S3_ENDPOINT`.

## 2. Build and Push the Worker Image

Create an ECR repository:

```bash
aws ecr create-repository --repository-name pilotswarm-worker
```

Authenticate Docker to ECR:

```bash
aws ecr get-login-password --region us-east-1 | \
docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-east-1.amazonaws.com
```

Build and push a tagged worker image from the repo root:

```bash
npm run build

docker buildx build \
  --platform linux/amd64 \
  -f deploy/Dockerfile.worker \
  -t <account-id>.dkr.ecr.us-east-1.amazonaws.com/pilotswarm-worker:2026-04-01-001 \
  --push .
```

Use immutable tags for rollouts. Do not rely on `latest` as your only deploy tag.

## 3. Prepare the EC2 Instance

SSH to the instance and install Docker:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker ubuntu
```

Create runtime directories:

```bash
sudo mkdir -p /etc/pilotswarm
sudo mkdir -p /var/log/pilotswarm
```

Install the ECR Docker credential helper so the service can pull from private ECR using the EC2 IAM role:

```bash
sudo apt-get install -y amazon-ecr-credential-helper
sudo mkdir -p /root/.docker
sudo tee /root/.docker/config.json > /dev/null <<'EOF'
{
  "credsStore": "ecr-login"
}
EOF
```

## 4. Create the Worker Env Files on EC2

Copy the checked-in templates from:

- [`deploy/ec2/worker.env.example`](../deploy/ec2/worker.env.example)
- [`deploy/ec2/worker.service.env.example`](../deploy/ec2/worker.service.env.example)

Create `/etc/pilotswarm/worker.env`:

```bash
sudo cp deploy/ec2/worker.env.example /etc/pilotswarm/worker.env
sudo chmod 600 /etc/pilotswarm/worker.env
```

Required values in `/etc/pilotswarm/worker.env`:

```bash
DATABASE_URL=postgresql://user:password@host:5432/dbname
GITHUB_TOKEN=ghu_xxx

AWS_S3_BUCKET_NAME=pilot-swarm
AWS_S3_REGION=us-east-1
# Omit AWS_S3_ENDPOINT for standard AWS S3
LOG_LEVEL=info
```

If you are **not** using an EC2 IAM role for S3, also set:

```bash
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

Create `/etc/pilotswarm/worker.service.env`:

```bash
sudo cp deploy/ec2/worker.service.env.example /etc/pilotswarm/worker.service.env
sudo chmod 600 /etc/pilotswarm/worker.service.env
```

Set the image reference there:

```bash
PILOTSWARM_IMAGE=<account-id>.dkr.ecr.us-east-1.amazonaws.com/pilotswarm-worker:2026-04-01-001
```

## 5. Install the systemd Service

Copy the checked-in service file:

- [`deploy/ec2/pilotswarm-worker.service`](../deploy/ec2/pilotswarm-worker.service)

Install it:

```bash
sudo cp deploy/ec2/pilotswarm-worker.service /etc/systemd/system/pilotswarm-worker.service
sudo systemctl daemon-reload
sudo systemctl enable pilotswarm-worker
sudo systemctl start pilotswarm-worker
```

Check status:

```bash
sudo systemctl status pilotswarm-worker
sudo journalctl -u pilotswarm-worker -f
```

On success, you should see log lines similar to:

```text
[worker] Started ✓ Polling for orchestrations...
```

## 6. Connect From Your Laptop

Keep the TUI off-box and run it in remote mode against the same PostgreSQL:

```bash
npm run tui:remote
```

Your local `.env.remote` should point to the same `DATABASE_URL` as the EC2 worker.

## 7. Verify the Deployment

### Basic health

- worker service is active
- worker logs show PostgreSQL connection and polling
- no S3 credential or endpoint errors

### Session test

From your laptop TUI:

```text
Wait 120 seconds, then say "wake test complete".
```

Verify:

- a session row appears in `copilot_sessions.sessions`
- events appear in `copilot_sessions.session_events`
- `<sessionId>.tar.gz` appears in S3
- `<sessionId>.meta.json` appears in S3
- the session resumes after the timer

### Artifact test

Prompt:

```text
Create a file named s3-check.md with the text "hello from ec2 worker" and save it as an artifact.
```

Verify:

- `artifacts/<sessionId>/s3-check.md` appears in S3
- the TUI can download the file

## 8. Update Procedure

For a new worker release:

1. build a new image tag
2. push it to ECR
3. update `/etc/pilotswarm/worker.service.env`
4. restart the service

Commands:

```bash
sudoedit /etc/pilotswarm/worker.service.env
sudo systemctl restart pilotswarm-worker
sudo systemctl status pilotswarm-worker
```

## 9. Resilience Test

After the worker is healthy, test restart behavior:

1. create a durable wait session
2. restart the service while the timer is pending
3. confirm the resumed session continues correctly

```bash
sudo systemctl restart pilotswarm-worker
```

If PostgreSQL and S3 are configured correctly, a restarted worker should continue durable work from stored state.

## Notes

- Prefer an **EC2 IAM role** over static AWS keys on the instance.
- Omit `AWS_S3_ENDPOINT` unless you truly need a custom S3-compatible endpoint.
- If you change `.model_providers.json`, rebuild and repush the worker image so the updated catalog is baked into the container.
- This repo’s runtime model is worker-centric: the worker does the LLM execution, tool execution, dehydration, hydration, and artifact storage.
