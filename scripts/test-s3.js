#!/usr/bin/env node

/**
 * S3 integration smoke test — exercises S3BlobStore end-to-end.
 *
 * Usage:
 *   node --env-file=.env scripts/test-s3.js
 *   npm run test:s3
 *
 * Required env vars:
 *   AWS_S3_BUCKET          — bucket name
 *   AWS_ACCESS_KEY_ID      — IAM access key
 *   AWS_SECRET_ACCESS_KEY  — IAM secret key
 *
 * Optional:
 *   AWS_REGION             — defaults to us-east-1
 *
 * Tests:
 *   uploadArtifact, downloadArtifact, artifactExists, listArtifacts,
 *   listAllObjects, deleteArtifacts, artifactExists-after-delete
 *
 * Exits with code 1 if any test fails.
 */

import { S3BlobStore } from "../dist/blob-store-s3.js";

const bucket = process.env.AWS_S3_BUCKET;
const region = process.env.AWS_REGION ?? "us-east-1";

if (!bucket) {
    console.error("\nERROR: AWS_S3_BUCKET is not set.");
    console.error("  Add it to your .env file and re-run: node --env-file=.env scripts/test-s3.js\n");
    process.exit(1);
}

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.error("\nERROR: AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY is not set.");
    console.error("  Add IAM credentials to your .env file.\n");
    process.exit(1);
}

const store = new S3BlobStore(bucket, region);
// Use a unique session ID per run so tests don't collide
const sessionId = `smoke-test-${Date.now()}`;
const filename = "smoke-test.md";
const content = `# PilotSwarm S3 Smoke Test\nRun at: ${new Date().toISOString()}\nSession: ${sessionId}`;

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

console.log(`\nS3 Smoke Test`);
console.log(`  bucket  : ${bucket}`);
console.log(`  region  : ${region}`);
console.log(`  session : ${sessionId}`);
console.log("");

// 1. Upload an artifact
await check("uploadArtifact", () =>
    store.uploadArtifact(sessionId, filename, content)
);

// 2. Confirm it exists
await check("artifactExists → true", async () => {
    const exists = await store.artifactExists(sessionId, filename);
    if (!exists) throw new Error("expected true, got false");
    return exists;
});

// 3. Download and verify content matches
await check("downloadArtifact (content matches)", async () => {
    const downloaded = await store.downloadArtifact(sessionId, filename);
    if (downloaded !== content) throw new Error(`content mismatch:\nExpected: ${content}\nGot:      ${downloaded}`);
    return "ok";
});

// 4. List artifacts for the session
await check("listArtifacts", async () => {
    const list = await store.listArtifacts(sessionId);
    if (!list.includes(filename)) throw new Error(`"${filename}" not found in list: [${list.join(", ")}]`);
    return list;
});

// 5. List all objects in the bucket (confirms visibility at bucket level)
await check("listAllObjects", async () => {
    const objects = [];
    for await (const obj of store.listAllObjects()) {
        objects.push(obj.name);
    }
    const found = objects.some(k => k.includes(sessionId));
    if (!found) throw new Error(`session key not found in bucket object list (${objects.length} total)`);
    return `${objects.length} object(s) in bucket`;
});

// 6. Delete all artifacts for the session
await check("deleteArtifacts", async () => {
    const count = await store.deleteArtifacts(sessionId);
    if (count === 0) throw new Error("expected at least 1 deleted, got 0");
    return `${count} deleted`;
});

// 7. Confirm artifact is gone after delete
await check("artifactExists after delete → false", async () => {
    const exists = await store.artifactExists(sessionId, filename);
    if (exists) throw new Error("artifact still exists after deleteArtifacts()");
    return exists;
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log("");
console.log(`  ${passed} passed, ${failed} failed`);
console.log("");

if (failed > 0) {
    console.error("Some tests failed. Common causes:");
    console.error("  - Bucket name wrong or doesn't exist");
    console.error("  - IAM user missing s3:PutObject / s3:GetObject / s3:DeleteObject / s3:ListBucket");
    console.error("  - Wrong region (bucket is in a different region than AWS_REGION)");
    console.error("  - Credentials not set or expired");
    process.exit(1);
}
