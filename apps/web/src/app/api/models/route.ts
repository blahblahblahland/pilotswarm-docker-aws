import { NextResponse } from "next/server";
import { getMgmt } from "@/lib/pilotswarm";

export const runtime = "nodejs";

export async function GET() {
  const mgmt = await getMgmt();
  return NextResponse.json({
    defaultModel: mgmt.getDefaultModel(),
    modelsByProvider: mgmt.getModelsByProvider(),
  });
}

