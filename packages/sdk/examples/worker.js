#!/usr/bin/env node

/**
 * Headless pilotswarm worker.
 * Runs as a K8s pod — polls PostgreSQL for orchestrations and executes them.
 *
 * Env vars:
 *   DATABASE_URL                    — PostgreSQL connection string
 *   GITHUB_TOKEN                    — Copilot API token (not needed with custom LLM)
 *   LLM_ENDPOINT                    — Custom LLM endpoint URL (Azure OpenAI, etc.)
 *   LLM_API_KEY                     — API key for the custom endpoint
 *   LLM_PROVIDER_TYPE               — Provider type: "openai" | "azure" | "anthropic"
 *   LLM_API_VERSION                 — Azure API version (default: "2024-10-21")
 *   COPILOT_MODEL                   — Model name/deployment (default: auto)
 *   LOG_LEVEL                       — Tracing level (default: "info")
 *   AWS_S3_BUCKET_NAME              — S3 bucket for session dehydration
 *   AWS_S3_REGION                   — S3 region
 *   AWS_ACCESS_KEY_ID               — AWS access key ID
 *   AWS_SECRET_ACCESS_KEY           — AWS secret access key
 *   AWS_S3_ENDPOINT                 — Optional S3-compatible endpoint override
 *   POD_NAME                        — K8s pod name (default: hostname)
 *   PLUGIN_DIRS                     — Comma-separated plugin directories (default: /app/plugin)
 *
 * Usage:
 *   node --env-file=.env.remote examples/worker.js
 *   # Or in Docker: ENTRYPOINT ["node", "examples/worker.js"]
 */

import os from "node:os";
import fs from "node:fs";
import { PilotSwarmWorker } from "pilotswarm-sdk";

const logLevel = process.env.LOG_LEVEL || "info";
const podName = process.env.POD_NAME || os.hostname();

// Plugin directories: env override or auto-detect /app/plugin (Docker default)
const pluginDirs = process.env.PLUGIN_DIRS
    ? process.env.PLUGIN_DIRS.split(",").map(d => d.trim()).filter(Boolean)
    : [];
if (pluginDirs.length === 0 && fs.existsSync("/app/plugin/plugin.json")) {
    pluginDirs.push("/app/plugin");
}

console.log(`[worker] Pod: ${podName}`);
console.log(`[worker] Store: ${process.env.DATABASE_URL?.replace(/\/\/.*@/, "//***@")}`);
if (pluginDirs.length > 0) console.log(`[worker] Plugin dirs: ${pluginDirs.join(", ")}`);

// Model providers: auto-discovered from model_providers.json or env vars.
// The worker loads them automatically — just log what it finds after start.

// System message: falls back to default.agent.md from plugin if not set here.
// Set explicitly to override the plugin default, or leave undefined to use it.
const SYSTEM_MESSAGE = undefined;

const worker = new PilotSwarmWorker({
    store: process.env.DATABASE_URL,
    githubToken: process.env.GITHUB_TOKEN,
    logLevel,
    awsS3BucketName: process.env.AWS_S3_BUCKET_NAME,
    awsS3Region: process.env.AWS_S3_REGION,
    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    awsS3Endpoint: process.env.AWS_S3_ENDPOINT,
    workerNodeId: podName,
    systemMessage: SYSTEM_MESSAGE,
    pluginDirs,
});

await worker.start();
console.log(`[worker] Started ✓ Polling for orchestrations...`);
if (worker.modelProviders) {
    const groups = worker.modelProviders.getModelsByProvider();
    for (const g of groups) {
        const names = g.models.map(m => m.qualifiedName).join(", ");
        console.log(`[worker] ${g.providerId} (${g.type}): ${names}`);
    }
    console.log(`[worker] Default model: ${worker.modelProviders.defaultModel}`);
}
if (worker.loadedAgents.length > 0) {
    console.log(`[worker] Agents: ${worker.loadedAgents.map(a => a.name).join(", ")}`);
}
if (worker.loadedSkillDirs.length > 0) {
    console.log(`[worker] Skill dirs: ${worker.loadedSkillDirs.join(", ")}`);
}
const mcpNames = Object.keys(worker.loadedMcpServers);
if (mcpNames.length > 0) {
    console.log(`[worker] MCP servers: ${mcpNames.join(", ")}`);
}

// Graceful shutdown
async function shutdown(signal) {
    console.log(`[worker] ${signal} received, shutting down...`);
    await worker.stop();
    process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Block forever — worker polls in background
await new Promise(() => {});
