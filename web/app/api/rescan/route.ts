import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { startRescan, cancelRescan } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let fromId = NaN;
  try {
    const body = (await req.json()) as { from_id?: number | string };
    fromId = Number(body.from_id);
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  const result = await startRescan(fromId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result);
}

export async function DELETE() {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const cancelled = await cancelRescan();
  return NextResponse.json({ ok: true, cancelled });
}
