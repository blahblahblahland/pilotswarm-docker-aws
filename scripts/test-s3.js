#!/usr/bin/env node

/**
 * S3 integration smoke test — exercises S3BlobStore end-to-end.
 *
 * Usage:
 *   node --env-file=.env scripts/test-s3.js
 *   npm run test:s3
 *
 * Required env vars:
 *   AWS_S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 * Optional:
 *   AWS_REGION (default: us-east-1)
 *
 * Tests:
 *   uploadArtifact, downloadArtifact, artifactExists, listArtifacts,
 *   listAllObjects, deleteArtifacts, artifactExists-after-delete
 *
 * Exits with code 1 if any test fails.
 */

import { S3BlobStore } from "../dist/blob-store-s3.js";
import { check } from "./test-helpers.js";

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
const sessionId = `smoke-test-${Date.now()}`;
const filename = "smoke-test.md";
const content = `# PilotSwarm S3 Smoke Test\nRun at: ${new Date().toISOString()}\nSession: ${sessionId}`;
const c = { passed: 0, failed: 0 };

console.log(`\nS3 Smoke Test`);
console.log(`  bucket  : ${bucket}`);
console.log(`  region  : ${region}`);
console.log(`  session : ${sessionId}`);
console.log("");

await check("uploadArtifact", () => store.uploadArtifact(sessionId, filename, content), c);

await check("artifactExists → true", async () => {
    const exists = await store.artifactExists(sessionId, filename);
    if (!exists) throw new Error("expected true, got false");
    return exists;
}, c);

await check("downloadArtifact (content matches)", async () => {
    const downloaded = await store.downloadArtifact(sessionId, filename);
    if (downloaded !== content) throw new Error(`content mismatch`);
    return "ok";
}, c);

await check("listArtifacts", async () => {
    const list = await store.listArtifacts(sessionId);
    if (!list.includes(filename)) throw new Error(`"${filename}" not found in list`);
    return list;
}, c);

// Stream bucket objects without accumulating all keys into memory
await check("listAllObjects", async () => {
    let count = 0;
    let found = false;
    for await (const obj of store.listAllObjects()) {
        count++;
        if (obj.name.includes(sessionId)) found = true;
    }
    if (!found) throw new Error(`session key not found in bucket (${count} objects scanned)`);
    return `${count} object(s) in bucket`;
}, c);

await check("deleteArtifacts", async () => {
    const count = await store.deleteArtifacts(sessionId);
    if (count === 0) throw new Error("expected at least 1 deleted, got 0");
    return `${count} deleted`;
}, c);

await check("artifactExists after delete → false", async () => {
    const exists = await store.artifactExists(sessionId, filename);
    if (exists) throw new Error("artifact still exists after deleteArtifacts()");
    return exists;
}, c);

console.log("");
console.log(`  ${c.passed} passed, ${c.failed} failed`);
console.log("");

if (c.failed > 0) {
    console.error("Some tests failed. Common causes:");
    console.error("  - Bucket name wrong or doesn't exist");
    console.error("  - IAM user missing s3:PutObject / s3:GetObject / s3:DeleteObject / s3:ListBucket");
    console.error("  - Wrong region (bucket is in a different region than AWS_REGION)");
    console.error("  - Credentials not set or expired");
    process.exit(1);
}
