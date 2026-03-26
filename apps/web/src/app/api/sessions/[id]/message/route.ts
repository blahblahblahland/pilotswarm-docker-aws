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
  const prompt: string | undefined =
    isRecord(body) && typeof body.prompt === "string" ? body.prompt : undefined;
  if (!prompt || typeof prompt !== "string") {
    return NextResponse.json({ error: "invalid_prompt" }, { status: 400 });
  }
  const mgmt = await getMgmt();
  await mgmt.sendMessage(id, prompt);
  return NextResponse.json({ ok: true });
}

