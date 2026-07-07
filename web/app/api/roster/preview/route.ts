import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { fetchSheetXlsx } from "@/lib/sheets";
import { parseRosterXlsx } from "@/lib/rosterParse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { sheet_url?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  const sheetUrl = typeof body.sheet_url === "string" ? body.sheet_url.trim() : "";
  if (!sheetUrl) return NextResponse.json({ error: "no sheet URL provided" }, { status: 400 });

  try {
    const buf = await fetchSheetXlsx(sheetUrl);
    const parsed = await parseRosterXlsx(buf);
    if (parsed.anchor_count === 0) {
      return NextResponse.json({ error: parsed.warnings[0] ?? "No profile links found in the sheet." }, { status: 422 });
    }
    return NextResponse.json({
      source_url: sheetUrl,
      sheet_name: parsed.sheet_name,
      teams: parsed.teams,
      warnings: parsed.warnings,
      anchor_count: parsed.anchor_count,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
