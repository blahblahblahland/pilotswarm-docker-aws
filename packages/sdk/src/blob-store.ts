import {
    DeleteObjectCommand,
    DeleteObjectsCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    DEFAULT_SESSION_STATE_DIR,
    type SessionMetadata,
    type SessionStateStore,
    type ArtifactStore,
    archiveSessionDir,
    buildMetadata,
    extractSessionArchive,
} from "./session-store.js";

type SessionBlobStoreOptions = {
    accessKeyId?: string;
    secretAccessKey?: string;
    endpoint?: string;
};

type ListedObject = {
    name: string;
    properties?: {
        contentLength?: number;
    };
};

/**
 * Manages session state in AWS S3.
 *
 * - `dehydrate()` — tar + upload session dir, remove local files
 * - `hydrate()` — download + untar session dir
 * - `checkpoint()` — tar + upload without removing local files
 * - `exists()` / `delete()` — object lifecycle
 *
 * @internal
 */
export class SessionBlobStore implements SessionStateStore, ArtifactStore {
    private readonly s3: S3Client;
    private readonly bucketName: string;
    private readonly region: string;
    private readonly sessionStateDir: string;
    readonly containerClient: {
        listBlobsFlat: (opts?: { prefix?: string }) => AsyncIterable<ListedObject>;
    };

    constructor(bucketName: string, region: string, sessionStateDir?: string, opts?: SessionBlobStoreOptions) {
        this.bucketName = bucketName;
        this.region = region;
        this.sessionStateDir = sessionStateDir ?? DEFAULT_SESSION_STATE_DIR;
        this.s3 = new S3Client({
            region,
            ...(opts?.endpoint ? { endpoint: opts.endpoint } : {}),
            ...((opts?.accessKeyId && opts?.secretAccessKey)
                ? {
                    credentials: {
                        accessKeyId: opts.accessKeyId,
                        secretAccessKey: opts.secretAccessKey,
                    },
                }
                : {}),
        });
        this.containerClient = {
            listBlobsFlat: (opts) => this.listObjects(opts?.prefix),
        };
    }

    private async *listObjects(prefix?: string): AsyncIterable<ListedObject> {
        let continuationToken: string | undefined;
        do {
            const response = await this.s3.send(new ListObjectsV2Command({
                Bucket: this.bucketName,
                Prefix: prefix,
                ContinuationToken: continuationToken,
            }));
            for (const object of response.Contents ?? []) {
                if (!object.Key) continue;
                yield {
                    name: object.Key,
                    properties: {
                        contentLength: object.Size,
                    },
                };
            }
            continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
        } while (continuationToken);
    }

    private async objectExists(key: string): Promise<boolean> {
        try {
            await this.s3.send(new HeadObjectCommand({
                Bucket: this.bucketName,
                Key: key,
            }));
            return true;
        } catch (err: any) {
            const statusCode = err?.$metadata?.httpStatusCode;
            const code = err?.name ?? err?.Code;
            if (statusCode === 404 || code === "NotFound" || code === "NoSuchKey") return false;
            throw err;
        }
    }

    private async readObjectToBuffer(key: string): Promise<Buffer> {
        const response = await this.s3.send(new GetObjectCommand({
            Bucket: this.bucketName,
            Key: key,
        }));
        const body = response.Body;
        if (!body) return Buffer.alloc(0);
        if (typeof (body as any).transformToByteArray === "function") {
            const bytes = await (body as any).transformToByteArray();
            return Buffer.from(bytes);
        }
        const chunks: Buffer[] = [];
        for await (const chunk of body as AsyncIterable<Uint8Array | Buffer | string>) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
    }

    /**
     * Dehydrate a session: tar, upload, remove local files.
     * Frees the worker slot for another session.
     */
    async dehydrate(sessionId: string, meta?: Record<string, unknown>): Promise<void> {
        const sessionDir = path.join(this.sessionStateDir, sessionId);
        const sessionDirExists = fs.existsSync(sessionDir);
        console.info(
            `[SessionBlobStore] dehydrate start session=${sessionId} bucket=${this.bucketName} ` +
            `region=${this.region} sessionStateDir=${this.sessionStateDir} ` +
            `sessionDir=${sessionDir} exists=${sessionDirExists}`,
        );
        if (!sessionDirExists) {
            console.warn(`[SessionBlobStore] dehydrate skipped session=${sessionId} reason=local-session-dir-missing`);
            return;
        }

        const tarPath = path.join(os.tmpdir(), `${sessionId}.tar.gz`);
        try {
            archiveSessionDir(this.sessionStateDir, sessionId, tarPath);
            console.info(
                `[SessionBlobStore] tar created session=${sessionId} tarPath=${tarPath} sizeBytes=${fs.statSync(tarPath).size}`,
            );

            console.info(`[SessionBlobStore] upload tar start session=${sessionId} key=${sessionId}.tar.gz`);
            await this.s3.send(new PutObjectCommand({
                Bucket: this.bucketName,
                Key: `${sessionId}.tar.gz`,
                Body: fs.createReadStream(tarPath),
                ContentType: "application/gzip",
            }));
            console.info(`[SessionBlobStore] upload tar success session=${sessionId} key=${sessionId}.tar.gz`);

            const metadata: SessionMetadata = buildMetadata(tarPath, sessionId, meta);
            const metaJson = JSON.stringify(metadata);
            console.info(`[SessionBlobStore] upload metadata start session=${sessionId} key=${sessionId}.meta.json`);
            await this.s3.send(new PutObjectCommand({
                Bucket: this.bucketName,
                Key: `${sessionId}.meta.json`,
                Body: metaJson,
                ContentType: "application/json",
            }));
            console.info(`[SessionBlobStore] upload metadata success session=${sessionId} key=${sessionId}.meta.json`);

            fs.rmSync(sessionDir, { recursive: true, force: true });
            console.info(`[SessionBlobStore] dehydrate complete session=${sessionId} localDirRemoved=${!fs.existsSync(sessionDir)}`);
        } catch (err: any) {
            console.error(
                `[SessionBlobStore] dehydrate failed session=${sessionId} ` +
                `error=${err?.message ?? err}`,
            );
            throw err;
        } finally {
            try { fs.unlinkSync(tarPath); } catch {}
        }
    }

    /**
     * Hydrate a session: download tar from S3, extract to local disk.
     * No-op if local session files already exist.
     */
    async hydrate(sessionId: string): Promise<void> {
        const sessionDir = path.join(this.sessionStateDir, sessionId);
        console.info(
            `[SessionBlobStore] hydrate start session=${sessionId} bucket=${this.bucketName} ` +
            `region=${this.region} sessionDir=${sessionDir} localDirBefore=${fs.existsSync(sessionDir)}`,
        );
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }

        const tarPath = path.join(os.tmpdir(), `${sessionId}.tar.gz`);
        try {
            const tarBuffer = await this.readObjectToBuffer(`${sessionId}.tar.gz`);
            console.info(
                `[SessionBlobStore] hydrate download success session=${sessionId} ` +
                `key=${sessionId}.tar.gz sizeBytes=${tarBuffer.length}`,
            );
            fs.writeFileSync(tarPath, tarBuffer);
            extractSessionArchive(this.sessionStateDir, tarPath);
            console.info(
                `[SessionBlobStore] hydrate complete session=${sessionId} localDirAfter=${fs.existsSync(sessionDir)}`,
            );
        } catch (err: any) {
            console.error(
                `[SessionBlobStore] hydrate failed session=${sessionId} ` +
                `error=${err?.message ?? err}`,
            );
            throw err;
        } finally {
            try { fs.unlinkSync(tarPath); } catch {}
        }
    }

    /**
     * Checkpoint: upload current session state to S3 without removing local files.
     * Used for crash resilience — the session stays warm in memory.
     */
    async checkpoint(sessionId: string): Promise<void> {
        const sessionDir = path.join(this.sessionStateDir, sessionId);
        if (!fs.existsSync(sessionDir)) {
            console.warn(`[SessionBlobStore] checkpoint skipped session=${sessionId} reason=local-session-dir-missing`);
            return;
        }

        const tarPath = path.join(os.tmpdir(), `${sessionId}.tar.gz`);
        try {
            archiveSessionDir(this.sessionStateDir, sessionId, tarPath);
            console.info(
                `[SessionBlobStore] checkpoint tar created session=${sessionId} tarPath=${tarPath} sizeBytes=${fs.statSync(tarPath).size}`,
            );

            console.info(`[SessionBlobStore] checkpoint upload tar start session=${sessionId} key=${sessionId}.tar.gz`);
            await this.s3.send(new PutObjectCommand({
                Bucket: this.bucketName,
                Key: `${sessionId}.tar.gz`,
                Body: fs.createReadStream(tarPath),
                ContentType: "application/gzip",
            }));
            console.info(`[SessionBlobStore] checkpoint upload tar success session=${sessionId} key=${sessionId}.tar.gz`);

            const metadata: SessionMetadata = buildMetadata(tarPath, sessionId, { reason: "checkpoint" });
            const metaJson = JSON.stringify(metadata);
            console.info(`[SessionBlobStore] checkpoint upload metadata start session=${sessionId} key=${sessionId}.meta.json`);
            await this.s3.send(new PutObjectCommand({
                Bucket: this.bucketName,
                Key: `${sessionId}.meta.json`,
                Body: metaJson,
                ContentType: "application/json",
            }));
            console.info(`[SessionBlobStore] checkpoint upload metadata success session=${sessionId} key=${sessionId}.meta.json`);
        } catch (err: any) {
            console.error(
                `[SessionBlobStore] checkpoint failed session=${sessionId} ` +
                `error=${err?.message ?? err}`,
            );
            throw err;
        } finally {
            try { fs.unlinkSync(tarPath); } catch {}
        }
    }

    /** Check if a dehydrated session exists in S3. */
    async exists(sessionId: string): Promise<boolean> {
        try {
            const exists = await this.objectExists(`${sessionId}.tar.gz`);
            console.info(
                `[SessionBlobStore] exists session=${sessionId} key=${sessionId}.tar.gz result=${exists}`,
            );
            return exists;
        } catch (err: any) {
            console.warn(
                `[SessionBlobStore] exists failed session=${sessionId} key=${sessionId}.tar.gz ` +
                `error=${err?.message ?? err}`,
            );
            throw err;
        }
    }

    /** Delete a dehydrated session from S3. */
    async delete(sessionId: string): Promise<void> {
        await this.s3.send(new DeleteObjectCommand({
            Bucket: this.bucketName,
            Key: `${sessionId}.tar.gz`,
        }));
        await this.s3.send(new DeleteObjectCommand({
            Bucket: this.bucketName,
            Key: `${sessionId}.meta.json`,
        }));
    }

    // ─── Artifact Storage ────────────────────────────────────

    private artifactBlobPath(sessionId: string, filename: string): string {
        const safe = filename.replace(/[/\\]/g, "_");
        return `artifacts/${sessionId}/${safe}`;
    }

    /**
     * Upload an artifact file (e.g. .md) to S3.
     * Max 1MB content.
     */
    async uploadArtifact(
        sessionId: string,
        filename: string,
        content: string,
        contentType = "text/markdown",
    ): Promise<string> {
        const MAX_SIZE = 1_048_576;
        if (content.length > MAX_SIZE) {
            throw new Error(`Artifact too large: ${content.length} bytes (max ${MAX_SIZE})`);
        }
        const blobPath = this.artifactBlobPath(sessionId, filename);
        await this.s3.send(new PutObjectCommand({
            Bucket: this.bucketName,
            Key: blobPath,
            Body: content,
            ContentType: contentType,
        }));
        return blobPath;
    }

    /**
     * Download an artifact file from S3.
     * Returns the file content as a string.
     */
    async downloadArtifact(sessionId: string, filename: string): Promise<string> {
        const blobPath = this.artifactBlobPath(sessionId, filename);
        const buffer = await this.readObjectToBuffer(blobPath);
        return buffer.toString("utf-8");
    }

    /**
     * List artifact files for a session.
     * Returns filenames (not full object paths).
     */
    async listArtifacts(sessionId: string): Promise<string[]> {
        const prefix = `artifacts/${sessionId}/`;
        const files: string[] = [];
        for await (const object of this.listObjects(prefix)) {
            files.push(object.name.slice(prefix.length));
        }
        return files;
    }

    /**
     * Check if an artifact exists.
     */
    async artifactExists(sessionId: string, filename: string): Promise<boolean> {
        return this.objectExists(this.artifactBlobPath(sessionId, filename));
    }

    /**
     * Generate a short-lived read-only presigned URL for an artifact.
     */
    async generateArtifactSasUrl(
        sessionId: string,
        filename: string,
        expiryMinutes = 1,
    ): Promise<string> {
        const blobPath = this.artifactBlobPath(sessionId, filename);
        return getSignedUrl(this.s3, new GetObjectCommand({
            Bucket: this.bucketName,
            Key: blobPath,
        }), {
            expiresIn: Math.max(1, Math.round(expiryMinutes * 60)),
        });
    }

    /**
     * Delete all artifacts for a session.
     */
    async deleteArtifacts(sessionId: string): Promise<number> {
        const prefix = `artifacts/${sessionId}/`;
        const keys: string[] = [];
        for await (const object of this.listObjects(prefix)) {
            keys.push(object.name);
        }
        if (keys.length === 0) return 0;
        await this.s3.send(new DeleteObjectsCommand({
            Bucket: this.bucketName,
            Delete: {
                Objects: keys.map(Key => ({ Key })),
                Quiet: true,
            },
        }));
        return keys.length;
    }
}
