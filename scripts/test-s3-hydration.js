#!/usr/bin/env node

/**
 * S3 dehydrate/hydrate smoke test — validates session state round-trip via S3.
 *
 * Usage:
 *   node --env-file=.env scripts/test-s3-hydration.js
 *   npm run test:s3:hydration
 *
 * What it tests:
 *   1. Creates a fake session state directory (~/.copilot/session-state/<id>/)
 *   2. dehydrate() — tars it, uploads to S3, deletes local dir
 *   3. exists()    — confirms the tar.gz is in S3
 *   4. hydrate()   — downloads from S3, restores local dir
 *   5. Verifies files came back with correct content
 *   6. delete()    — cleans up from S3
 *
 * Required env vars:
 *   AWS_S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 * Optional:
 *   AWS_REGION (default: us-east-1)
 *
 * No database or running worker required.
 */

import { S3BlobStore } from "../dist/blob-store-s3.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const bucket = process.env.AWS_S3_BUCKET;
const region = process.env.AWS_REGION ?? "us-east-1";

if (!bucket) {
    console.error("\nERROR: AWS_S3_BUCKET is not set in .env\n");
    process.exit(1);
}

const SESSION_STATE_DIR = path.join(os.homedir(), ".copilot", "session-state");
const sessionId = `hydration-test-${Date.now()}`;
const sessionDir = path.join(SESSION_STATE_DIR, sessionId);

const store = new S3BlobStore(bucket, region);

let passed = 0;
let failed = 0;

async function check(label, fn) {
    try {
        const result = await fn();
        const suffix = result !== undefined ? ` → ${JSON.stringify(result)}` : "";
        console.log(`  ✓  ${label}${suffix}`);
        passed++;
    } catch (err) {
        console.error(`  ✗  ${label}`);
        console.error(`       ${err.message}`);
        failed++;
    }
}

console.log(`\nS3 Dehydrate/Hydrate Test`);
console.log(`  bucket  : ${bucket}`);
console.log(`  region  : ${region}`);
console.log(`  session : ${sessionId}`);
console.log(`  dir     : ${sessionDir}`);
console.log("");

// ── Setup: create a fake session state directory with test files ──────────────

console.log("  [setup] creating fake session state...");
fs.mkdirSync(sessionDir, { recursive: true });
fs.writeFileSync(path.join(sessionDir, "state.json"), JSON.stringify({
    sessionId,
    createdAt: new Date().toISOString(),
    messages: ["hello", "world"],
}));
fs.writeFileSync(path.join(sessionDir, "checkpoint.txt"), `checkpoint for ${sessionId}`);
fs.mkdirSync(path.join(sessionDir, "sub"), { recursive: true });
fs.writeFileSync(path.join(sessionDir, "sub", "nested.txt"), "nested file content");
console.log("  [setup] done — 3 files in session dir\n");

// ── Test 1: dehydrate ─────────────────────────────────────────────────────────

await check("dehydrate() — tar + upload to S3 + delete local dir", async () => {
    await store.dehydrate(sessionId, { testRun: true });
    if (fs.existsSync(sessionDir)) {
        throw new Error("local session dir still exists after dehydrate (should have been deleted)");
    }
    return "local dir deleted";
});

// ── Test 2: exists ────────────────────────────────────────────────────────────

await check("exists() → true (tar.gz in S3)", async () => {
    const inS3 = await store.exists(sessionId);
    if (!inS3) throw new Error("tar.gz not found in S3 after dehydrate");
    return inS3;
});

// ── Test 3: hydrate ───────────────────────────────────────────────────────────

await check("hydrate() — download from S3 + restore local dir", async () => {
    await store.hydrate(sessionId);
    if (!fs.existsSync(sessionDir)) {
        throw new Error("session dir not restored after hydrate");
    }
    return "local dir restored";
});

// ── Test 4: verify files came back correctly ──────────────────────────────────

await check("state.json content matches", async () => {
    const raw = fs.readFileSync(path.join(sessionDir, "state.json"), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.sessionId !== sessionId) throw new Error(`sessionId mismatch: ${parsed.sessionId}`);
    if (!Array.isArray(parsed.messages)) throw new Error("messages field missing");
    return "ok";
});

await check("checkpoint.txt content matches", async () => {
    const content = fs.readFileSync(path.join(sessionDir, "checkpoint.txt"), "utf-8");
    if (!content.includes(sessionId)) throw new Error(`content mismatch: ${content}`);
    return "ok";
});

await check("sub/nested.txt content matches", async () => {
    const content = fs.readFileSync(path.join(sessionDir, "sub", "nested.txt"), "utf-8");
    if (content !== "nested file content") throw new Error(`content mismatch: ${content}`);
    return "ok";
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

console.log("");
await check("delete() — remove tar.gz + meta from S3", async () => {
    await store.delete(sessionId);
    const stillInS3 = await store.exists(sessionId);
    if (stillInS3) throw new Error("still exists in S3 after delete");
    return "cleaned up";
});

// Remove restored local dir
try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    console.log("  [cleanup] local session dir removed");
} catch {}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log("");
console.log(`  ${passed} passed, ${failed} failed`);
console.log("");

if (failed > 0) {
    console.error("Some tests failed. Common causes:");
    console.error("  - 'tar' command not available (required for dehydrate/hydrate)");
    console.error("  - S3 permissions missing (s3:PutObject, s3:GetObject, s3:DeleteObject)");
    console.error("  - Wrong bucket name or region");
    process.exit(1);
}
