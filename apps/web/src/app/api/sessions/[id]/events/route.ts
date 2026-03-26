import { NextResponse } from "next/server";
import { getMgmt } from "@/lib/pilotswarm";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const { searchParams } = new URL(req.url);
  const afterSeqRaw = searchParams.get("afterSeq");
  const limitRaw = searchParams.get("limit");
  const afterSeq = afterSeqRaw ? Number(afterSeqRaw) : undefined;
  const limit = limitRaw ? Math.min(500, Math.max(1, Number(limitRaw))) : 100;

  const mgmt = await getMgmt();
  const events = await mgmt.getSessionEvents(
    id,
    Number.isFinite(afterSeq) ? afterSeq : undefined,
    Number.isFinite(limit) ? limit : 100,
  );

  return NextResponse.json({ events });
}

