import { bad, json, readJson, requireTenant } from "@/lib/api";
import { fetchSheetXlsx } from "@/lib/sheets";
import { parseRosterXlsx } from "@/lib/rosterParse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: { slug: string } };

export async function POST(req: Request, { params }: Ctx) {
  const t = await requireTenant(params.slug, "edit");
  if (!t.ok) return t.res;
  const body = await readJson<{ sheet_url?: unknown }>(req);
  const sheetUrl = typeof body?.sheet_url === "string" ? body.sheet_url.trim() : "";
  if (!sheetUrl) return bad("no sheet URL provided");
  try {
    const buf = await fetchSheetXlsx(sheetUrl);
    const parsed = await parseRosterXlsx(buf);
    if (parsed.anchor_count === 0) return bad(parsed.warnings[0] ?? "No profile links found in the sheet.", 422);
    return json({
      source_url: sheetUrl,
      sheet_name: parsed.sheet_name,
      teams: parsed.teams,
      warnings: parsed.warnings,
      anchor_count: parsed.anchor_count,
    });
  } catch (e) {
    return bad((e as Error).message, 502);
  }
}
