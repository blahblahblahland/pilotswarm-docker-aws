import "server-only";

export function withTiming<Args extends unknown[]>(
  name: string,
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    const t0 = performance.now();
    try {
      const res = await handler(...args);
      return res;
    } finally {
      const dur = performance.now() - t0;
      // Minimal, grep-friendly log line. Safe for local profiling.
      // Example: [api] GET /api/sessions 12.3ms
      console.log(`[api] ${name} ${dur.toFixed(1)}ms`);
    }
  };
}

