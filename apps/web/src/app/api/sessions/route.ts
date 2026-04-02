import { NextResponse } from "next/server";
import { getClient, getMgmt } from "@/lib/pilotswarm";
import { getDefaultModel } from "@/lib/env";
import { isRecord, safeJson } from "@/lib/http";
import { withTiming } from "../_timing";

export const runtime = "nodejs";

export const GET = withTiming("GET /api/sessions", async function GET() {
  const mgmt = await getMgmt();
  const sessions = await mgmt.listSessions();
  return NextResponse.json({ sessions });
});

export const POST = withTiming("POST /api/sessions", async function POST(req: Request) {
  const body = await safeJson(req);
  const model =
    isRecord(body) && typeof body.model === "string"
      ? body.model
      : getDefaultModel() ?? undefined;
  const systemMessage =
    isRecord(body) && typeof body.systemMessage === "string"
      ? body.systemMessage
      : undefined;
  const toolNames =
    isRecord(body) && Array.isArray(body.toolNames) && body.toolNames.every(t => typeof t === "string")
      ? (body.toolNames as string[])
      : undefined;
  const parentSessionId =
    isRecord(body) && typeof body.parentSessionId === "string"
      ? body.parentSessionId
      : undefined;

  const client = await getClient();
  const session = await client.createSession({
    ...(model ? { model } : {}),
    ...(systemMessage ? { systemMessage } : {}),
    ...(toolNames ? { toolNames } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
  });

  // Ensure orchestration exists even before first user message.
  // The TUI does this via send("") to create the orchestration record.
  await session.send("");

  return NextResponse.json({ sessionId: session.sessionId });
});

