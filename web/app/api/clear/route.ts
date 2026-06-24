import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { clearHits } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await clearHits();
  return NextResponse.json({ ok: true });
}
