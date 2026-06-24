import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { saveConfig } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let patch: { target_beatmap_ids?: unknown; enabled?: boolean } = {};
  try {
    patch = (await req.json()) as typeof patch;
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  try {
    const config = await saveConfig(patch);
    return NextResponse.json({ ok: true, config });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
