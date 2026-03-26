import { NextResponse } from "next/server";
import { getMgmt } from "@/lib/pilotswarm";
import { isRecord, safeJson } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const mgmt = await getMgmt();
  const session = await mgmt.getSession(id);
  if (!session) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ session });
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const body = await safeJson(req);
  const title: string | undefined =
    isRecord(body) && typeof body.title === "string" ? body.title : undefined;
  if (!title || typeof title !== "string") {
    return NextResponse.json({ error: "invalid_title" }, { status: 400 });
  }
  const mgmt = await getMgmt();
  await mgmt.renameSession(id, title);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const body = await safeJson(req);
  const reason: string | undefined =
    isRecord(body) && typeof body.reason === "string" ? body.reason : undefined;
  const mgmt = await getMgmt();
  await mgmt.deleteSession(id, reason);
  return NextResponse.json({ ok: true });
}

