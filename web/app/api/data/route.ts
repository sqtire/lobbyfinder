import { NextResponse } from "next/server";
import { getConfig, getStatus, getHits, hiddenCount } from "@/lib/redis";
import { isAuthed } from "@/lib/auth";
import type { DataResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [status, config, hits, hidden] = await Promise.all([getStatus(), getConfig(), getHits(200), hiddenCount()]);
    const body: DataResponse = { status, config, hits, authed: isAuthed(), hidden_count: hidden };
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
