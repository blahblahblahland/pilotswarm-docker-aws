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
  const reason: string | undefined =
    isRecord(body) && typeof body.reason === "string" ? body.reason : undefined;
  const mgmt = await getMgmt();
  await mgmt.cancelSession(id, reason);
  return NextResponse.json({ ok: true });
}

