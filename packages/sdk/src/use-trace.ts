import { Langfuse } from "langfuse";

export type LangFuseTracer = LangFuseTracerImpl | null;

interface LangFuseTracerImpl {
    getOrCreateTrace(sessionId: string, opts?: Record<string, unknown>): any;
    flush(): Promise<void>;
}

export function createLangFuseTracer(): LangFuseTracer {
    const secretKey = process.env.LANGFUSE_SECRET_KEY;
    if (!secretKey) return null;

    const client = new Langfuse({
        secretKey,
        publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? "",
        baseUrl: process.env.LANGFUSE_BASEURL,
        flushAt: 20,
        flushInterval: 5_000,
    });

    const traceCache = new Map<string, any>();

    return {
        getOrCreateTrace(sessionId: string, opts: Record<string, unknown> = {}) {
            if (traceCache.has(sessionId)) return traceCache.get(sessionId)!;
            const t = client.trace({ id: sessionId, ...opts });
            traceCache.set(sessionId, t);
            return t;
        },
        flush() {
            return client.flushAsync();
        },
    };
}
