import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    ListObjectsV2Command,
    HeadObjectCommand,
    DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { BlobStore, BlobStoreObject } from "./blob-store.js";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SESSION_STATE_DIR = path.join(os.homedir(), ".copilot", "session-state");

export class S3BlobStore implements BlobStore {
    private client: S3Client;
    private bucket: string;

    constructor(bucket: string, region = "us-east-1") {
        this.bucket = bucket;
        this.client = new S3Client({ region });
    }
    
        async dehydrate(sessionId: string, meta?: Record<string, unknown>): Promise<void> {
        const sessionDir = path.join(SESSION_STATE_DIR, sessionId);
        if (!fs.existsSync(sessionDir)) return;

        const tarPath = path.join(os.tmpdir(), `${sessionId}.tar.gz`);
        try {
            execSync(`tar czf "${tarPath}" -C "${SESSION_STATE_DIR}" "${sessionId}"`);

            await this.client.send(new PutObjectCommand({
                Bucket: this.bucket,
                Key: `${sessionId}.tar.gz`,
                Body: fs.createReadStream(tarPath),
            }));

            const metadata = {
                sessionId,
                dehydratedAt: new Date().toISOString(),
                worker: os.hostname(),
                sizeBytes: fs.statSync(tarPath).size,
                ...meta,
            };
            const metaJson = JSON.stringify(metadata);
            await this.client.send(new PutObjectCommand({
                Bucket: this.bucket,
                Key: `${sessionId}.meta.json`,
                Body: metaJson,
                ContentType: "application/json",
            }));

            fs.rmSync(sessionDir, { recursive: true, force: true });
        } finally {
            try { fs.unlinkSync(tarPath); } catch {}
        }
    }

    async hydrate(sessionId: string): Promise<void> {
        const sessionDir = path.join(SESSION_STATE_DIR, sessionId);
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }

        const tarPath = path.join(os.tmpdir(), `${sessionId}.tar.gz`);
        try {
            const response = await this.client.send(new GetObjectCommand({
                Bucket: this.bucket,
                Key: `${sessionId}.tar.gz`,
            }));
            const chunks: Buffer[] = [];
            for await (const chunk of response.Body as any) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            fs.mkdirSync(SESSION_STATE_DIR, { recursive: true });
            fs.writeFileSync(tarPath, Buffer.concat(chunks));
            execSync(`tar xzf "${tarPath}" -C "${SESSION_STATE_DIR}"`);
        } finally {
            try { fs.unlinkSync(tarPath); } catch {}
        }
    }

    async checkpoint(sessionId: string): Promise<void> {
        const sessionDir = path.join(SESSION_STATE_DIR, sessionId);
        if (!fs.existsSync(sessionDir)) return;

        const tarPath = path.join(os.tmpdir(), `${sessionId}.tar.gz`);
        try {
            execSync(`tar czf "${tarPath}" -C "${SESSION_STATE_DIR}" "${sessionId}"`);
            await this.client.send(new PutObjectCommand({
                Bucket: this.bucket,
                Key: `${sessionId}.tar.gz`,
                Body: fs.createReadStream(tarPath),
            }));
        } finally {
            try { fs.unlinkSync(tarPath); } catch {}
        }
    }
    async exists(sessionId: string): Promise<boolean> {
        try {
            await this.client.send(new HeadObjectCommand({
                Bucket: this.bucket,
                Key: `${sessionId}.tar.gz`,
            }));
            return true;
        } catch {
            return false;
        }
    }

    async delete(sessionId: string): Promise<void> {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: `${sessionId}.tar.gz` }));
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: `${sessionId}.meta.json` }));
    }

    private artifactKey(sessionId: string, filename: string): string {
        return `artifacts/${sessionId}/${filename.replace(/[/\\]/g, "_")}`;
    }

    async uploadArtifact(sessionId: string, filename: string, content: string, contentType = "text/markdown"): Promise<string> {
        const key = this.artifactKey(sessionId, filename);
        await this.client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: content,
            ContentType: contentType,
        }));
        return key;
    }

    async downloadArtifact(sessionId: string, filename: string): Promise<string> {
        const response = await this.client.send(new GetObjectCommand({
            Bucket: this.bucket,
            Key: this.artifactKey(sessionId, filename),
        }));
        const chunks: Buffer[] = [];
        for await (const chunk of response.Body as any) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks).toString("utf-8");
    }

    async listArtifacts(sessionId: string): Promise<string[]> {
        const prefix = `artifacts/${sessionId}/`;
        const response = await this.client.send(new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
        }));
        return (response.Contents ?? []).map(obj => obj.Key!.slice(prefix.length));
    }

    async artifactExists(sessionId: string, filename: string): Promise<boolean> {
        try {
            await this.client.send(new HeadObjectCommand({
                Bucket: this.bucket,
                Key: this.artifactKey(sessionId, filename),
            }));
            return true;
        } catch {
            return false;
        }
    }

    generateArtifactSasUrl(sessionId: string, filename: string, expiryMinutes = 1): string {
        // S3 presigned URLs are async — this is a sync shim; use getS3PresignedUrl() for real usage
        throw new Error("Use getS3ArtifactPresignedUrl() for S3 presigned URLs (async).");
    }

    async getS3ArtifactPresignedUrl(sessionId: string, filename: string, expiryMinutes = 1): Promise<string> {
        const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: this.artifactKey(sessionId, filename),
        });
        return getSignedUrl(this.client, command, { expiresIn: expiryMinutes * 60 });
    }

    async deleteArtifacts(sessionId: string): Promise<number> {
        const files = await this.listArtifacts(sessionId);
        for (const file of files) {
            await this.client.send(new DeleteObjectCommand({
                Bucket: this.bucket,
                Key: this.artifactKey(sessionId, file),
            }));
        }
        return files.length;
    }
    async *listAllObjects(): AsyncIterable<BlobStoreObject> {
        let continuationToken: string | undefined;
        do {
            const response = await this.client.send(new ListObjectsV2Command({
                Bucket: this.bucket,
                ContinuationToken: continuationToken,
            }));
            for (const obj of response.Contents ?? []) {
                yield { name: obj.Key!, sizeBytes: obj.Size ?? 0 };
            }
            continuationToken = response.NextContinuationToken;
        } while (continuationToken);
    }
}
