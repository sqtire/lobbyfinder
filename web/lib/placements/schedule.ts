/**
 * Reads the referee sheet's "Chrono Schedule" tab (or any tab laid out like
 * it) and turns each match row into a ScheduleRow.
 *
 * Only the schedule is read from the sheet: stage/round, the two players,
 * their recorded score (−1 = forfeit), the mp links and the "first to" for the
 * round. The mappool is deliberately NOT read from the sheet — it is manual
 * input (lib/placements/pool.ts).
 *
 * The tab is fetched as CSV through Google's visualization endpoint, which
 * returns computed values (the tab is built from FILTER() formulas) and needs
 * no API key — the sheet just has to be "anyone with the link can view".
 */

import { parseSheetUrl } from "@/lib/sheets";
import { parseCsv } from "./csv";
import type { RoomRef, ScheduleParse, ScheduleRow, SheetOutcome } from "./types";

// Override for local testing against a mock server only.
const SHEETS_BASE = process.env.PLACEMENTS_SHEETS_BASE || "https://docs.google.com";

const MAX_BYTES = 8 * 1024 * 1024;

export async function fetchSheetTabCsv(sheetUrl: string, tab: string): Promise<string> {
  const parsed = parseSheetUrl(sheetUrl);
  if (!parsed) throw new Error("That doesn't look like a Google Sheets URL.");
  const tabName = tab.trim();
  const url = tabName
    ? `${SHEETS_BASE}/spreadsheets/d/${parsed.id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`
    : `${SHEETS_BASE}/spreadsheets/d/${parsed.id}/export?format=csv${parsed.gid ? `&gid=${parsed.gid}` : ""}`;
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", cache: "no-store" });
  } catch (e) {
    throw new Error(`Could not reach Google Sheets: ${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? "Sheet not found — check the URL."
        : `Google returned ${res.status} — the sheet may not be link-viewable, or the tab name is wrong.`
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) throw new Error("That tab is larger than 8 MB — that's not a schedule tab.");
  const text = buf.toString("utf8");
  const ct = res.headers.get("content-type") ?? "";
  if (/text\/html/i.test(ct) || /^\s*<(!doctype|html)/i.test(text)) {
    throw new Error('Got a webpage instead of CSV — set the sheet to "anyone with the link can view".');
  }
  return text;
}

// ---- column detection -------------------------------------------------------

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

interface Cols {
  stage: number;
  match: number | null;
  date: number | null;
  time: number | null;
  red: number;
  blue: number;
  redScore: number | null;
  blueScore: number | null;
  scoreCombined: number | null;
  mp: number[];
  firstTo: number | null;
  bestOf: number | null;
}

function detectColumns(row: string[]): Cols | null {
  const h = row.map(norm);
  const find = (...names: string[]) => {
    for (const n of names) {
      const i = h.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const stage = find("stage", "round", "bracket round", "week");
  const red = find("team red", "red", "player 1", "player red", "red player", "team 1", "p1");
  const blue = find("team blue", "blue", "player 2", "player blue", "blue player", "team 2", "p2");
  const mp = h.map((x, i) => (/^(mp ?links?|mp|match ?links?|lobby( link)?s?|room( link)?s?)( ?\d+)?$/.test(x) ? i : -1)).filter((i) => i >= 0);
  if (stage < 0 || red < 0 || blue < 0 || mp.length === 0) return null;

  let redScore: number | null = null;
  let blueScore: number | null = null;
  let scoreCombined: number | null = null;
  const explicitRed = find("red score", "score red", "team red score", "p1 score");
  const explicitBlue = find("blue score", "score blue", "team blue score", "p2 score");
  if (explicitRed >= 0 && explicitBlue >= 0) {
    redScore = explicitRed;
    blueScore = explicitBlue;
  } else if (blue > red) {
    const between = [];
    for (let i = red + 1; i < blue; i++) between.push(i);
    if (between.length >= 2) {
      redScore = between[0]!;
      blueScore = between[1]!;
    } else if (between.length === 1) {
      scoreCombined = between[0]!;
    }
  }
  if (redScore === null && scoreCombined === null) {
    const s = find("score", "result");
    if (s >= 0) scoreCombined = s;
  }
  const match = find("sheet", "match id", "match", "id", "#", "match #");
  return {
    stage,
    match: match >= 0 ? match : null,
    date: find("date") >= 0 ? find("date") : null,
    time: find("time") >= 0 ? find("time") : null,
    red,
    blue,
    redScore,
    blueScore,
    scoreCombined,
    mp,
    firstTo: find("first to", "ft", "first-to") >= 0 ? find("first to", "ft", "first-to") : null,
    bestOf: find("best of", "bo") >= 0 ? find("best of", "bo") : null,
  };
}

// ---- cell parsing -----------------------------------------------------------

function parseScoreCell(raw: string): number | null | "ff" {
  const s = raw.trim();
  if (s === "") return null;
  if (/^(ff|forfeit|w\/?o|dq|-1)$/i.test(s)) return "ff";
  const n = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  if (n < 0) return "ff";
  return Math.round(n);
}

function parseCombinedScore(raw: string): [number | null | "ff", number | null | "ff"] {
  const m = raw.trim().match(/^(-?\d+|ff|forfeit)\s*[-–—:|vs]+\s*(-?\d+|ff|forfeit)$/i);
  if (!m) return [null, null];
  return [parseScoreCell(m[1]!), parseScoreCell(m[2]!)];
}

export function extractRoomRefs(text: string): RoomRef[] {
  const out: RoomRef[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/osu\.ppy\.sh\/(?:multiplayer\/rooms\/(\d+)|community\/matches\/(\d+)|mp\/(\d+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const ref: RoomRef = m[1]
      ? { kind: "lazer", id: Number(m[1]), url: `https://osu.ppy.sh/multiplayer/rooms/${m[1]}` }
      : { kind: "legacy", id: Number(m[2] ?? m[3]), url: `https://osu.ppy.sh/community/matches/${m[2] ?? m[3]}` };
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function parseFirstTo(ft: string | undefined, bo: string | undefined): number | null {
  const f = Number((ft ?? "").trim());
  if (Number.isFinite(f) && f > 0) return Math.round(f);
  const b = (bo ?? "").trim().match(/(\d+)/);
  if (b) {
    const n = Number(b[1]);
    if (n > 0) return Math.ceil(n / 2);
  }
  return null;
}

export function parseSchedule(csv: string): ScheduleParse {
  const table = parseCsv(csv);
  const warnings: string[] = [];
  let cols: Cols | null = null;
  let headerRow = -1;
  for (let i = 0; i < Math.min(table.length, 15); i++) {
    const c = detectColumns(table[i]!);
    if (c) {
      cols = c;
      headerRow = i;
      break;
    }
  }
  if (!cols) {
    throw new Error(
      'Couldn\'t find the schedule columns in that tab — expected a header row with "stage", "team red", "team blue" and "mp link".'
    );
  }
  if (cols.redScore === null && cols.scoreCombined === null) warnings.push("No score columns found between team red and team blue — every match will be treated as unplayed.");
  if (cols.firstTo === null && cols.bestOf === null) warnings.push('No "first to" column — the format will be inferred from each match\'s score.');

  const rows: ScheduleRow[] = [];
  for (let r = headerRow + 1; r < table.length; r++) {
    const line = table[r]!;
    const cell = (i: number | null) => (i === null || i < 0 ? "" : (line[i] ?? "").trim());
    const red = cell(cols.red);
    const blue = cell(cols.blue);
    if (!red && !blue) continue;
    const stage = cell(cols.stage);
    if (!stage) continue;

    let rs: number | null | "ff" = null;
    let bs: number | null | "ff" = null;
    if (cols.redScore !== null && cols.blueScore !== null) {
      rs = parseScoreCell(cell(cols.redScore));
      bs = parseScoreCell(cell(cols.blueScore));
    } else if (cols.scoreCombined !== null) {
      [rs, bs] = parseCombinedScore(cell(cols.scoreCombined));
    }
    const rooms = cols.mp.flatMap((i) => extractRoomRefs(cell(i)));

    let outcome: SheetOutcome;
    let forfeit: ScheduleRow["forfeit"] = null;
    if (rs === null && bs === null) outcome = "unplayed";
    else if (rs === "ff" && bs === "ff") {
      outcome = "double_forfeit";
      forfeit = "both";
    } else if (rs === "ff") {
      outcome = "blue";
      forfeit = "red";
    } else if (bs === "ff") {
      outcome = "red";
      forfeit = "blue";
    } else if (rs === null || bs === null) outcome = "unplayed";
    else if (rs > bs) outcome = "red";
    else if (bs > rs) outcome = "blue";
    else outcome = "tie";

    const firstTo = parseFirstTo(cols.firstTo !== null ? cell(cols.firstTo) : undefined, cols.bestOf !== null ? cell(cols.bestOf) : undefined);
    const dateRaw = cell(cols.date);
    const timeRaw = cell(cols.time);

    rows.push({
      row: r + 1,
      match_id: cell(cols.match) || String(rows.length + 1),
      stage,
      date: dateRaw ? `${dateRaw}${timeRaw ? ` ${timeRaw}` : ""}` : null,
      red: red || "(unknown)",
      blue: blue || "(unknown)",
      red_score: rs === "ff" ? -1 : rs,
      blue_score: bs === "ff" ? -1 : bs,
      first_to: firstTo,
      rooms,
      outcome,
      forfeit,
    });
  }
  if (rows.length === 0) warnings.push("No match rows found under the header.");
  return { rows, header_row: headerRow + 1, columns: Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, Array.isArray(v) ? v[0] ?? -1 : v ?? -1])), warnings };
}
