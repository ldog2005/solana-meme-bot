import { NextRequest, NextResponse } from "next/server";
import { handleGet, handlePost } from "@/lib/api/router";
import { logger } from "@/lib/core/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { path } = await ctx.params;
  try {
    return await handleGet(path, req);
  } catch (e) {
    await logger.error("api", `GET /${path.join("/")} failed: ${(e as Error).message}`);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { path } = await ctx.params;
  try {
    return await handlePost(path, req);
  } catch (e) {
    await logger.error("api", `POST /${path.join("/")} failed: ${(e as Error).message}`);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
