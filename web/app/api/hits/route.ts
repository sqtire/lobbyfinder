import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { removeHits, resetHidden } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { action?: string; match_ids?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  if (body.action === "reset_hidden") {
    const restored = await resetHidden();
    return NextResponse.json({ ok: true, restored });
  }

  if (body.action === "remove") {
    const ids = Array.isArray(body.match_ids) ? body.match_ids.map((v) => Number(v)) : [];
    if (ids.length === 0) return NextResponse.json({ error: "no match_ids provided" }, { status: 400 });
    const removed = await removeHits(ids);
    return NextResponse.json({ ok: true, removed });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
