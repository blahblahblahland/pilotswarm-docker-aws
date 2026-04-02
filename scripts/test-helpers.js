/**
 * Shared test helper for S3 smoke test scripts.
 */

export async function check(label, fn, counters) {
    try {
        const result = await fn();
        const suffix = result !== undefined ? ` → ${JSON.stringify(result)}` : "";
        console.log(`  ✓  ${label}${suffix}`);
        counters.passed++;
    } catch (err) {
        console.error(`  ✗  ${label}`);
        console.error(`       ${err.message}`);
        counters.failed++;
    }
}
