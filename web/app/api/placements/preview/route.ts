import { getSessionUser } from "@/lib/auth";
import { bad, json, readJson } from "@/lib/api";
import { parsePool } from "@/lib/placements/pool";
import { fetchSheetTabCsv, parseSchedule } from "@/lib/placements/schedule";
import type { PreviewResponse } from "@/lib/placements/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reads the schedule tab and parses the pool text WITHOUT touching the osu!
 * API, so the panel can show which stages exist (and their formats) before a
 * run is started. Signed-in users only (it fetches a Google sheet).
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return bad("sign in required", 401);
  const body = (await readJson<{ sheet_url?: string; sheet_tab?: string; pool_text?: string }>(req)) ?? {};
  const url = typeof body.sheet_url === "string" ? body.sheet_url.trim() : "";
  if (!/docs\.google\.com\/spreadsheets\/d\//.test(url)) return bad("Paste the referee sheet's Google Sheets link.");
  const tab = (typeof body.sheet_tab === "string" ? body.sheet_tab : "").trim() || "Chrono Schedule";
  let csv: string;
  try {
    csv = await fetchSheetTabCsv(url, tab);
  } catch (e) {
    return bad((e as Error).message);
  }
  let schedule;
  try {
    schedule = parseSchedule(csv);
  } catch (e) {
    return bad((e as Error).message);
  }
  const stageMap = new Map<string, PreviewResponse["schedule"]["stages"][number]>();
  for (const r of schedule.rows) {
    let s = stageMap.get(r.stage);
    if (!s) stageMap.set(r.stage, (s = { stage: r.stage, matches: 0, played: 0, forfeits: 0, unplayed: 0, with_rooms: 0, first_to: [] }));
    s.matches++;
    if (r.outcome === "unplayed") s.unplayed++;
    else if (r.forfeit) s.forfeits++;
    else s.played++;
    if (r.rooms.length) s.with_rooms++;
    if (r.first_to && !s.first_to.includes(r.first_to)) s.first_to.push(r.first_to);
  }
  const refs = new Set<string>();
  let lazer = 0;
  let legacy = 0;
  for (const r of schedule.rows)
    for (const ref of r.rooms) {
      const k = `${ref.kind}:${ref.id}`;
      if (refs.has(k)) continue;
      refs.add(k);
      if (ref.kind === "lazer") lazer++;
      else legacy++;
    }
  const pool = typeof body.pool_text === "string" ? parsePool(body.pool_text) : { maps: [], warnings: [] };
  const out: PreviewResponse = {
    schedule: {
      header_row: schedule.header_row,
      stages: [...stageMap.values()],
      total_rows: schedule.rows.length,
      rooms: refs.size,
      lazer_rooms: lazer,
      legacy_matches: legacy,
      warnings: schedule.warnings,
    },
    pool,
  };
  return json(out);
}
