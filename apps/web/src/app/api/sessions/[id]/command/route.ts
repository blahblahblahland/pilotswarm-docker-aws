import { NextResponse } from "next/server";
import { getMgmt } from "@/lib/pilotswarm";
import { isRecord, safeJson } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const body = await safeJson(req);
  const cmd: string | undefined =
    isRecord(body) && typeof body.cmd === "string" ? body.cmd : undefined;
  const args: Record<string, unknown> | undefined =
    isRecord(body) && isRecord(body.args) ? body.args : undefined;
  const requestId: string | undefined =
    isRecord(body) && typeof body.id === "string" ? body.id : undefined;
  if (!cmd || typeof cmd !== "string") {
    return NextResponse.json({ error: "invalid_cmd" }, { status: 400 });
  }
  const mgmt = await getMgmt();
  await mgmt.sendCommand(id, { cmd, id: requestId ?? crypto.randomUUID(), args });
  return NextResponse.json({ ok: true });
}

