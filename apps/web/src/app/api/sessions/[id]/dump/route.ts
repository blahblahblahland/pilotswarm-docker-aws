import { NextResponse } from "next/server";
import { getMgmt } from "@/lib/pilotswarm";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const mgmt = await getMgmt();
  const md = await mgmt.dumpSession(id);
  return new NextResponse(md, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

