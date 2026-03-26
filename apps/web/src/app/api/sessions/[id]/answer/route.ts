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
  const answer: string | undefined =
    isRecord(body) && typeof body.answer === "string" ? body.answer : undefined;
  if (!answer || typeof answer !== "string") {
    return NextResponse.json({ error: "invalid_answer" }, { status: 400 });
  }
  const mgmt = await getMgmt();
  await mgmt.sendAnswer(id, answer);
  return NextResponse.json({ ok: true });
}

