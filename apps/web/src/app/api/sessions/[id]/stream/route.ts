import { getMgmt } from "@/lib/pilotswarm";
import { withTiming } from "../../../_timing";

export const runtime = "nodejs";

function sseEncode(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export const GET = withTiming("GET /api/sessions/:id/stream", async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const { searchParams } = new URL(req.url);
  const afterSeqRaw = searchParams.get("afterSeq");
  let lastSeq = afterSeqRaw ? Number(afterSeqRaw) : 0;

  const mgmt = await getMgmt();

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const signal = req.signal;

      try {
        // Initial payload: current status + initial events
        const status = await mgmt.getSessionStatus(id);
        const initialEvents = await mgmt.getSessionEvents(id, lastSeq || undefined, 200);
        if (initialEvents.length > 0) {
          lastSeq = initialEvents[initialEvents.length - 1]!.seq;
        }

        controller.enqueue(encoder.encode(sseEncode("init", { status, lastSeq })));
        if (initialEvents.length > 0) {
          controller.enqueue(encoder.encode(sseEncode("events", { events: initialEvents, lastSeq })));
        }

        let lastVersion = status.customStatusVersion ?? 0;
        let heartbeatAt = Date.now();

        while (!signal.aborted) {
          // 1) Long-poll orchestration status changes (keeps UI responsive)
          try {
            const next = await mgmt.waitForStatusChange(id, lastVersion, 200, 25_000);
            if (next.customStatusVersion > lastVersion) {
              lastVersion = next.customStatusVersion;
              controller.enqueue(encoder.encode(sseEncode("status", next)));
            }
          } catch {
            // timeout or transient failure; continue
          }

          // 2) Poll CMS events (append-only transcript)
          try {
            const evts = await mgmt.getSessionEvents(id, lastSeq || undefined, 200);
            if (evts.length > 0) {
              lastSeq = evts[evts.length - 1]!.seq;
              controller.enqueue(encoder.encode(sseEncode("events", { events: evts, lastSeq })));
            }
          } catch {
            // ignore; next loop will retry
          }

          // 3) Heartbeat to keep intermediaries from buffering
          if (Date.now() - heartbeatAt > 15_000) {
            heartbeatAt = Date.now();
            controller.enqueue(encoder.encode(`: ping ${heartbeatAt}\n\n`));
          }
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
});

