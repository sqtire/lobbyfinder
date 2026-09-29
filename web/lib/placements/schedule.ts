/**
 * Reads the referee sheet's "Chrono Schedule" tab (or any tab laid out like
 * it) and turns each match row into a ScheduleRow.
 *
 * Only the schedule is read from the sheet: stage/round, the two players,
 * their recorded score (−1 = forfeit), the mp links and the "first to" for the
 * round. The mappool is deliberately NOT read from the sheet — it is manual
 * input (lib/placements/pool.ts).
 *
 * The spreadsheet is downloaded as .xlsx (the same export roster sync uses —
 * no API key, the sheet just has to be "anyone with the link can view") or
 * uploaded as a file, and the tab is read with its cached formula values. The
 * CSV query endpoint is deliberately NOT used: it guesses header rows and
 * merges them (e.g. "team red J"), which breaks tabs with helper rows.
 */

import ExcelJS from "exceljs";
import JSZip from "jszip"; // ships with exceljs (hoisted in package-lock), no separate dependency
import { fetchSheetXlsx } from "@/lib/sheets";
import { parseCsv } from "./csv";
import type { RoomRef, ScheduleParse, ScheduleRow, SheetOutcome } from "./types";

// Override for local testing against a mock server only.
const SHEETS_BASE = process.env.PLACEMENTS_SHEETS_BASE || "https://docs.google.com";
const DEFAULT_TAB = "Chrono Schedule";

/** Largest schedule we accept (rows × columns) — a referee tab is a few hundred rows at most. */
const MAX_ROWS = 3000;
const MAX_COLS = 80;
const MAX_CELL = 600;
const MAX_XLSX_BYTES = 30 * 1024 * 1024;
const excelSerialDate = (n: number) => new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");

/**
 * Cached values of every formula cell of one tab, straight from the sheet XML.
 * exceljs drops a formula's cached value when it is 0 or "" (Google exports
 * FILTER()-built tabs as formulas, so a 4–0 score would read as blank); this
 * is the fallback for exactly those cells.
 */
async function rawFormulaValues(xlsx: Buffer, sheetName: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const zip = await JSZip.loadAsync(xlsx);
  const wbXml = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
  const rels = (await zip.file("xl/_rels/workbook.xml.rels")?.async("string")) ?? "";
  let rid: string | null = null;
  for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
    const tag = m[0];
    const name = tag.match(/\bname="([^"]*)"/)?.[1];
    if (name !== undefined && decodeXml(name) === sheetName) rid = tag.match(/\br:id="([^"]*)"/)?.[1] ?? null;
  }
  if (!rid) return out;
  let target: string | null = null;
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) if (m[0].includes(`Id="${rid}"`)) target = m[0].match(/\bTarget="([^"]*)"/)?.[1] ?? null;
  if (!target) return out;
  const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  const xml = (await zip.file(path)?.async("string")) ?? "";
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const body = m[2];
    if (!body || !body.includes("<f")) continue;
    const addr = m[1]!.match(/\br="([A-Z]+\d+)"/)?.[1];
    if (!addr) continue;
    const t = m[1]!.match(/\bt="([a-z]+)"/)?.[1] ?? "n";
    const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "";
    out.set(addr, t === "b" ? (v === "1" ? "TRUE" : "FALSE") : t === "e" ? "" : decodeXml(v));
  }
  return out;
}

/** A cell as plain text: formula results, rich text, dates/times, and hyperlink targets (appended). */
function cellString(cell: ExcelJS.Cell, raw: Map<string, string> | null): string {
  let link: string | null = null;
  const fromVal = (x: unknown): string => {
    if (x === null || x === undefined) return "";
    if (x instanceof Date) {
      if (x.getUTCFullYear() < 1900) return x.toISOString().slice(11, 16); // a time of day
      return x.toISOString().slice(0, 10);
    }
    if (typeof x === "number") {
      const fmt = typeof cell.numFmt === "string" ? cell.numFmt : "";
      if (/[dy]/i.test(fmt) && !/[hs]/i.test(fmt) && x > 20000 && x < 80000) return excelSerialDate(x);
      return String(x);
    }
    if (typeof x === "boolean") return x ? "TRUE" : "FALSE";
    if (typeof x === "string") return x;
    if (typeof x === "object") {
      const o = x as Record<string, unknown>;
      if ("formula" in o || "sharedFormula" in o || "result" in o) {
        if (o.result !== undefined) return fromVal(o.result);
        const v = raw?.get(cell.address);
        if (v === undefined || v === "") return "";
        const n = Number(v);
        return Number.isFinite(n) && /^-?[\d.]+(e-?\d+)?$/i.test(v) ? fromVal(n) : v;
      }
      if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map((r) => r.text ?? "").join("");
      if ("text" in o) {
        if (typeof o.hyperlink === "string") link = o.hyperlink;
        return fromVal(o.text);
      }
      if ("error" in o) return "";
      return "";
    }
    return String(x);
  };
  let out = fromVal(cell.value).trim();
  const hl = (cell as unknown as { hyperlink?: unknown }).hyperlink;
  if (!link && typeof hl === "string") link = hl;
  if (link && !out.includes(link)) out = out ? `${out} ${link}` : link;
  return out.length > MAX_CELL ? out.slice(0, MAX_CELL) : out;
}

/**
 * Reads one tab of an .xlsx (a Google export or a file the user uploaded) into
 * a plain string table. Row/column positions are preserved (blank rows stay),
 * so "header on row 2" means the same thing it does in the sheet.
 */
export async function readScheduleTable(xlsx: Buffer, tab: string): Promise<{ rows: string[][]; tab: string; tabs: string[] }> {
  if (xlsx.byteLength > MAX_XLSX_BYTES) throw new Error("That spreadsheet is larger than 30 MB.");
  if (xlsx.byteLength < 4 || xlsx[0] !== 0x50 || xlsx[1] !== 0x4b) throw new Error("That file isn't an .xlsx spreadsheet.");
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
  } catch (e) {
    throw new Error(`Couldn't read the spreadsheet: ${(e as Error).message}`);
  }
  const tabs = wb.worksheets.map((w) => w.name);
  const want = (tab.trim() || DEFAULT_TAB).toLowerCase();
  const ws = wb.worksheets.find((w) => w.name === tab.trim()) ?? wb.worksheets.find((w) => w.name.trim().toLowerCase() === want);
  if (!ws) {
    const named = tabs.filter((n) => !/^\d+(\.\d+)?$/.test(n.trim()));
    throw new Error(`No tab named "${tab.trim() || DEFAULT_TAB}" in that spreadsheet. Tabs: ${named.slice(0, 25).join(", ")}${named.length > 25 ? ", …" : ""}.`);
  }
  const nRows = Math.min(ws.rowCount, MAX_ROWS);
  const nCols = Math.min(Math.max(ws.columnCount, ws.actualColumnCount), MAX_COLS);
  // only pay for the raw-XML pass when exceljs actually lost a cached formula value
  let lost = false;
  for (let r = 1; r <= nRows && !lost; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= nCols; c++) {
      const v = row.getCell(c).value as unknown;
      if (v && typeof v === "object" && ("formula" in v || "sharedFormula" in v) && (v as { result?: unknown }).result === undefined) {
        lost = true;
        break;
      }
    }
  }
  const raw = lost ? await rawFormulaValues(xlsx, ws.name).catch(() => null) : null;
  const rows: string[][] = [];
  for (let r = 1; r <= nRows; r++) {
    const row = ws.getRow(r);
    const line: string[] = [];
    for (let c = 1; c <= nCols; c++) {
      const cell = row.getCell(c);
      // merged cells: only the top-left keeps the value (exceljs repeats it into every slave)
      line.push(cell.isMerged && cell.master.address !== cell.address ? "" : cellString(cell, raw));
    }
    rows.push(line);
  }
  while (rows.length && rows[rows.length - 1]!.every((x) => !x)) rows.pop();
  let width = 0;
  for (const line of rows) for (let c = line.length - 1; c >= width; c--) if (line[c]) { width = c + 1; break; }
  return { rows: rows.map((line) => line.slice(0, width)), tab: ws.name, tabs };
}

/** Downloads the spreadsheet as .xlsx (File → Download; no API key, the sheet must be link-viewable) and reads one tab. */
export async function fetchScheduleTable(sheetUrl: string, tab: string): Promise<string[][]> {
  const buf = await fetchSheetXlsx(sheetUrl, SHEETS_BASE);
  return (await readScheduleTable(buf, tab)).rows;
}

/** Normalizes an uploaded/stored table: strings only, bounded size. */
export function sanitizeTable(v: unknown): string[][] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const rows: string[][] = [];
  for (const line of v.slice(0, MAX_ROWS)) {
    if (!Array.isArray(line)) return null;
    rows.push(line.slice(0, MAX_COLS).map((x) => (typeof x === "string" ? x.slice(0, MAX_CELL) : x === null || x === undefined ? "" : String(x).slice(0, MAX_CELL))));
  }
  return rows;
}

/** "borle https://osu.ppy.sh/users/18921588/osu" (a profile-linked name cell) → name + osu! user id. */
const PROFILE_URL_RE = /https?:\/\/osu\.ppy\.sh\/(?:users|u)\/(\d+)\S*/i;
function splitPlayerCell(text: string): { name: string; user_id: number | null } {
  const m = text.match(PROFILE_URL_RE);
  const name = text.replace(/https?:\/\/\S+/gi, " ").replace(/\s+/g, " ").trim();
  return { name, user_id: m ? Number(m[1]) : null };
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
  return parseScheduleTable(parseCsv(csv));
}

export function parseScheduleTable(table: string[][]): ScheduleParse {
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
    const redCell = splitPlayerCell(cell(cols.red));
    const blueCell = splitPlayerCell(cell(cols.blue));
    const red = redCell.name;
    const blue = blueCell.name;
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
      red_id: redCell.user_id,
      blue_id: blueCell.user_id,
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
