import ExcelJS from "exceljs";

/**
 * Anchor-first mainsheet parser.
 *
 * Never assumes a layout. Instead:
 *   1. Scan EVERY cell of every tab for an osu! profile reference, in any of
 *      three forms: a rich hyperlink on the cell, a HYPERLINK() formula, or a
 *      raw profile URL as text. Each match is a PLAYER ANCHOR.
 *      Fallback (only when a tab has NO profile links at all): a rank tag such
 *      as "#7348" next to a text cell is treated as a PLAYER ANCHOR too — the
 *      text cell is the name, the player has no user_id and is matched by
 *      username against scanned lobbies (same path as slug-only links).
 *      Last resort (no links AND no rank tags): a plain name grid — one team
 *      per row ("Team1: | name | name | …") or one team per column (team name
 *      in a header row, names below). Detected from the tab's dominant row
 *      shape, orientation chosen by aspect + header-token heuristics. Every
 *      player is name-matched; the preview is the safety net.
 *   2. Cluster anchors into team blocks by row adjacency.
 *   3. Label each block from the nearest plausible text cell (same row to the
 *      left first, then up to a few rows above), filtering junk (ranks,
 *      decorations, header words). A long+short pair on the same row combines,
 *      e.g. "Alabama" + "A" -> "Alabama A".
 * The result is a PREVIEW the operator confirms/edits before committing —
 * anchor detection is reliable; team labels are best-effort by design.
 */

export interface ParsedPlayer {
  name: string;
  user_id: number | null; // null => will be matched by username against scraped data
  via: "link" | "name";
  row: number;
  col: number;
}
export interface ParsedTeam {
  name: string;
  label_via: "row" | "above" | "fallback" | "grid";
  players: ParsedPlayer[];
}
export interface ParseResult {
  sheet_name: string;
  teams: ParsedTeam[];
  warnings: string[];
  anchor_count: number;
  mode: "link" | "rank" | "grid" | "none";
  orientation: "rows" | "columns" | null; // grid mode only
}
export type GridOrientation = "auto" | "rows" | "columns";

const PROFILE_RE = /osu\.ppy\.sh\/(?:users|u)\/([^\/\s"'?#\\)]+)/i;
/** "#7348", "#14,393", "# 1234" — the rank tag mainsheets put next to a player name. */
const RANK_RE = /^#\s?\d[\d,.]*$/;
/** Column/position headers a plain grid may carry: "T1", "P2", "Player 3", "Seed", "Captain", bare "Team"… ("Team 3" is a real label). */
const HEADER_TOKEN_RE =
  /^(?:(?:t|p|s|player|players|slot|seed|pos|position|member|members|name|names|username|usernames|user|users|captain|capt|osu!?|id|ids|rank|ranks|country|flag|discord|timezone|tz|notes?)\s*[#:]?\s*\d*|teams?|squads?)\s*[:.]?$/i;
/** Mappool slot labels — a mappool table is the classic false positive for a name grid. */
const MODSLOT_RE = /^(?:NM|HD|HR|DT|FM|TB|EZ|FL|HT|MIX|EX|RX|AP|SD|PF|FS)\s?\d*$/i;
/** Cells that read like a schedule, not a player: "A vs B", "Saturday 18:00", "2026-08-16", "UTC+2". */
const SCHEDULE_RE =
  /\bvs?\.?\b|\d{1,2}:\d{2}|\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? ?\d|\d{4}-\d{2}-\d{2}|\butc\b|\bgmt\b/i;
const LABEL_JUNK_WORDS =
  /\b(viewer|viewers|seed|avg|average|rank|ranks|broadcast|channel|schedule|bracket|qualifier|qualifiers|lobby|referee|staff|pool|list|find)\b/i;
const DECOR_RE = /[║╚╝╔╗╠╣═─│┌┐└┘✦★☆•·▪▸▾◂|]+/g;

interface CellRec {
  row: number;
  col: number;
  text: string;
  url: string | null;
}

export function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");
}

function extractUrl(cell: ExcelJS.Cell): string | null {
  const v: any = cell.value;
  if (v && typeof v === "object") {
    if (typeof v.hyperlink === "string" && PROFILE_RE.test(v.hyperlink)) return v.hyperlink;
    if (typeof v.formula === "string" && PROFILE_RE.test(v.formula)) return v.formula;
  }
  const hl: any = (cell as any).hyperlink;
  if (typeof hl === "string" && PROFILE_RE.test(hl)) return hl;
  if (typeof v === "string" && PROFILE_RE.test(v)) return v;
  return null;
}

function cellText(cell: ExcelJS.Cell): string {
  try {
    const t = cell.text;
    return typeof t === "string" ? t.trim() : String(t ?? "").trim();
  } catch {
    return "";
  }
}

function stripDecor(s: string): string {
  return s.replace(DECOR_RE, " ").replace(/\s+/g, " ").trim();
}

/** Junk for TEAM LABEL purposes (ranks, headers, decorations, numbers). */
function isJunkLabel(t: string): boolean {
  const s = stripDecor(t);
  if (!s) return true;
  if (/^#?[\d,.\s%()#\-–—]+$/.test(s)) return true; // "#17,980", "12", "50%"
  if (LABEL_JUNK_WORDS.test(s)) return true;
  if (s.length > 48) return true;
  if (/^https?:/i.test(s)) return true;
  return false;
}

/** Usable as a player's display name. */
function isGoodName(t: string): boolean {
  const s = t.trim();
  if (!s || s === "#") return false;
  if (/^https?:/i.test(s)) return false;
  if (stripDecor(s) !== s || !stripDecor(s)) return false;
  if (s.length > 32) return false;
  return true;
}

function classifyAnchor(url: string): { user_id: number | null; slug: string | null } {
  const m = url.match(PROFILE_RE);
  if (!m) return { user_id: null, slug: null };
  let seg = m[1]!;
  try {
    seg = decodeURIComponent(seg);
  } catch {
    /* keep raw */
  }
  if (/^\d+$/.test(seg)) return { user_id: Number(seg), slug: null };
  return { user_id: null, slug: seg };
}

interface Anchor {
  row: number;
  col: number;
  user_id: number | null;
  name: string;
  via: "link" | "name";
  src: "link" | "rank";
}

// ---- last-resort plain-grid parser -----------------------------------------

type Mode = "link" | "rank" | "grid";

const isNumericish = (t: string) => /^#?[\d,.\s%()#\-–—]+$/.test(stripDecor(t));
const isHeaderToken = (t: string) => HEADER_TOKEN_RE.test(stripDecor(t).trim());
const isGridPlayer = (t: string) => isGoodName(t) && !isNumericish(t) && !isHeaderToken(t) && !RANK_RE.test(t) && !SCHEDULE_RE.test(t);

interface GridTeam {
  label: string | null;
  labelCell: CellRec | null;
  players: CellRec[];
}

/**
 * One orientation of the grid parse. `lines` are the candidate "team lines"
 * (rows, or columns when transposed): each line = its non-empty text cells,
 * with (major, minor) coordinates already normalized so that minor increases
 * along the line. The first cell of the dominant shape is the label position.
 */
function gridTeamsFrom(lines: Map<number, { minor: number; rec: CellRec }[]>): GridTeam[] {
  // dominant shape = most frequent exact set of minor positions among lines with >= 3 cells
  const shapeCount = new Map<string, { n: number; minors: number[] }>();
  for (const cells of lines.values()) {
    if (cells.length < 3) continue;
    const minors = cells.map((c) => c.minor).sort((a, b) => a - b);
    const k = minors.join(",");
    const e = shapeCount.get(k);
    if (e) e.n++;
    else shapeCount.set(k, { n: 1, minors });
  }
  let dominant: number[] | null = null;
  let bestN = 0;
  for (const { n, minors } of shapeCount.values()) {
    if (n > bestN || (n === bestN && dominant && minors.length > dominant.length)) {
      bestN = n;
      dominant = minors;
    }
  }
  if (!dominant || bestN < 2) return [];
  const labelMinor = dominant[0]!;
  const playerMinors = new Set(dominant.slice(1));

  const teams: GridTeam[] = [];
  const majors = [...lines.keys()].sort((a, b) => a - b);
  for (const major of majors) {
    const cells = lines.get(major)!;
    const byMinor = new Map(cells.map((c) => [c.minor, c.rec] as const));
    const labelRec = byMinor.get(labelMinor) ?? null;
    const players = [...playerMinors]
      .sort((a, b) => a - b)
      .map((m) => byMinor.get(m))
      .filter((r): r is CellRec => !!r && !r.url && isGridPlayer(r.text));
    if (!labelRec || players.length < 1) continue;
    // a line whose "players" are mostly column headers is a header line, not a team
    const headerish = [...playerMinors].map((m) => byMinor.get(m)).filter((r) => r && isHeaderToken(r.text)).length;
    if (headerish * 2 >= playerMinors.size) continue;
    const labelText = stripDecor(labelRec.text).replace(/[:：]\s*$/, "").trim();
    const label = labelText && !isJunkLabel(labelText) && !isHeaderToken(labelText) ? labelText : null;
    teams.push({ label, labelCell: labelRec, players });
  }
  // a roster needs at least 2 teams and, on average, more than one player per team
  const totalPlayers = teams.reduce((n, t) => n + t.players.length, 0);
  if (teams.length < 2 || totalPlayers < teams.length * 2) return [];
  // mappool tables are the classic false positive: slot tokens (NM1, HD2, TB…) anywhere in the grid give it away
  const slotCells = teams.reduce(
    (n, t) => n + (MODSLOT_RE.test(stripDecor(t.labelCell?.text ?? "").replace(/[:：]\s*$/, "")) ? 1 : 0) + t.players.filter((p) => MODSLOT_RE.test(p.text)).length,
    0
  );
  if (slotCells >= 3) return [];
  // schedules/brackets read as "Match 1: Match 2, Match 3…" when transposed — a label + players that form one numbered series
  const seriesLike = teams.filter((t) => {
    const stem = (x: string) => stripDecor(x).replace(/[:：]\s*$/, "").replace(/\d+$/, "").trim().toLowerCase();
    const numbered = (x: string) => /\d+$/.test(stripDecor(x).replace(/[:：]\s*$/, ""));
    const lab = t.labelCell ? stem(t.labelCell.text) : "";
    if (!lab || !t.labelCell || !numbered(t.labelCell.text)) return false;
    const same = t.players.filter((p) => numbered(p.text) && stem(p.text) === lab).length;
    return same * 5 >= t.players.length * 3; // >= 60% of the "players" continue the label's series
  }).length;
  if (seriesLike * 2 >= teams.length) return [];
  return teams;
}

/**
 * Try both orientations. An orientation whose labels are column headers (P1, Player 2…) is out;
 * when both remain plausible, one-team-per-row wins (by far the common mainsheet shape) unless
 * the operator forces "columns" from the preview.
 */
function parseGrid(cells: Map<string, CellRec>, prefer: GridOrientation): { teams: GridTeam[]; orientation: "rows" | "columns" } | null {
  const rows = new Map<number, { minor: number; rec: CellRec }[]>();
  const cols = new Map<number, { minor: number; rec: CellRec }[]>();
  for (const rec of cells.values()) {
    if (rec.url || !rec.text) continue;
    if (!rows.has(rec.row)) rows.set(rec.row, []);
    rows.get(rec.row)!.push({ minor: rec.col, rec });
    if (!cols.has(rec.col)) cols.set(rec.col, []);
    cols.get(rec.col)!.push({ minor: rec.row, rec });
  }
  const byRows = gridTeamsFrom(rows);
  const byCols = gridTeamsFrom(cols);
  const headerRatio = (ts: GridTeam[]) => (ts.length ? ts.filter((t) => isHeaderToken(t.labelCell?.text ?? "")).length / ts.length : 1);
  const okRows = byRows.length > 0 && headerRatio(byRows) < 0.5;
  const okCols = byCols.length > 0 && headerRatio(byCols) < 0.5;
  if (prefer === "rows" && okRows) return { teams: byRows, orientation: "rows" };
  if (prefer === "columns" && okCols) return { teams: byCols, orientation: "columns" };
  if (!okRows && !okCols) return null;
  if (okRows && !okCols) return { teams: byRows, orientation: "rows" };
  if (okCols && !okRows) return { teams: byCols, orientation: "columns" };
  return { teams: byRows, orientation: "rows" };
}

function parseWorksheet(
  ws: ExcelJS.Worksheet,
  prefer: GridOrientation = "auto"
): {
  anchors: Anchor[];
  teams: ParsedTeam[];
  warnings: string[];
  mode: Mode;
  orientation: "rows" | "columns" | null;
} {
  const cells = new Map<string, CellRec>();
  const key = (r: number, c: number) => `${r}:${c}`;

  ws.eachRow({ includeEmpty: false }, (row, r) => {
    row.eachCell({ includeEmpty: false }, (cell, c) => {
      const text = cellText(cell);
      const url = extractUrl(cell);
      if (text || url) cells.set(key(r, c), { row: r, col: c, text, url });
    });
  });

  // ---- 1. anchors ----
  const anchors: Anchor[] = [];
  const anchorAt = new Set<string>();
  for (const rec of cells.values()) {
    if (!rec.url) continue;
    const { user_id, slug } = classifyAnchor(rec.url);
    if (user_id === null && slug === null) continue;
    anchorAt.add(key(rec.row, rec.col));
    anchors.push({ row: rec.row, col: rec.col, user_id, name: "", via: "link", src: "link" });
    // display name: own text, else adjacent (above / left / up-left / right), else slug, else id
    const own = rec.text;
    const cand = [own];
    for (const [dr, dc] of [
      [-1, 0],
      [0, -1],
      [-1, -1],
      [0, 1],
    ] as const) {
      const n = cells.get(key(rec.row + dr, rec.col + dc));
      cand.push(n && !n.url ? n.text : "");
    }
    const nameCell = cand.find((t) => t && isGoodName(t));
    const a = anchors[anchors.length - 1]!;
    a.name = nameCell ?? (slug ? slug.replace(/_/g, " ") : `user ${user_id}`);
  }

  // ---- 1b. fallback: rank tags as anchors, ONLY if this tab has no profile links ----
  // Keeps every link-bearing sheet byte-for-byte on the old path; link anchors and
  // rank anchors are never mixed, so a player can't be counted twice.
  let rankMode = false;
  if (anchors.length === 0) {
    for (const rec of cells.values()) {
      if (rec.url || !RANK_RE.test(rec.text)) continue;
      let name: string | null = null;
      for (const [dr, dc] of [
        [0, -1], // "name | #rank"  (most common)
        [-1, 0], // name above rank
        [0, 1], // "#rank | name"
        [-1, -1],
      ] as const) {
        const n = cells.get(key(rec.row + dr, rec.col + dc));
        if (n && !n.url && !RANK_RE.test(n.text) && isGoodName(n.text)) {
          name = n.text;
          break;
        }
      }
      if (!name) continue;
      anchorAt.add(key(rec.row, rec.col));
      anchors.push({ row: rec.row, col: rec.col, user_id: null, name, via: "name", src: "rank" });
    }
    rankMode = anchors.length > 0;
  }

  // ---- 1c. last resort: a plain name grid (no links, no rank tags anywhere in the tab) ----
  if (anchors.length === 0) {
    const grid = parseGrid(cells, prefer);
    if (!grid) return { anchors, teams: [], warnings: [], mode: "link", orientation: null };
    const teams: ParsedTeam[] = [];
    let guessed = 0;
    for (const g of grid.teams) {
      const seen = new Set<string>();
      const players: ParsedPlayer[] = [];
      for (const r of g.players) {
        const id = `n${normalizeName(r.text)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        players.push({ name: r.text, user_id: null, via: "name", row: r.row, col: r.col });
      }
      let name = g.label;
      if (!name) {
        guessed++;
        name = `Team ${teams.length + 1}`;
      }
      teams.push({ name, label_via: "grid", players });
    }
    const gridAnchors: Anchor[] = teams.flatMap((t) =>
      t.players.map((p) => ({ row: p.row, col: p.col, user_id: null, name: p.name, via: "name" as const, src: "rank" as const }))
    );
    const nPlayers = gridAnchors.length;
    const warnings = [
      `No osu! profile links or #rank tags in this tab — parsed it as a plain name grid (one team per ${grid.orientation === "rows" ? "row" : "column"}: ` +
        `${teams.length} teams, ${nPlayers} players). Everyone is matched to lobby data by username (n badge), so spellings must be current osu! usernames.`,
    ];
    if (guessed) warnings.push(`${guessed} team name(s) guessed — review them in the preview.`);
    return { anchors: gridAnchors, teams, warnings, mode: "grid", orientation: grid.orientation };
  }

  // ---- 2. cluster into blocks by row adjacency ----
  anchors.sort((a, b) => a.row - b.row || a.col - b.col);
  const blocks: Anchor[][] = [];
  for (const a of anchors) {
    const last = blocks[blocks.length - 1];
    if (last && a.row - last[last.length - 1]!.row <= 1) last.push(a);
    else blocks.push([a]);
  }

  // ---- 3. label + assemble ----
  const warnings: string[] = [];
  const teams: ParsedTeam[] = [];
  let fallbackN = 0;

  for (const block of blocks) {
    const topRow = block[0]!.row;
    const minCol = Math.min(...block.map((a) => a.col));
    const maxCol = Math.max(...block.map((a) => a.col));
    const usedNames = new Set<string>();
    for (const a of block) {
      for (const [dr, dc] of [
        [-1, 0],
        [0, -1],
        [-1, -1],
        [0, 1],
      ] as const) {
        const n = cells.get(key(a.row + dr, a.col + dc));
        if (n && !n.url && n.text === a.name) usedNames.add(key(n.row, n.col));
      }
    }

    let label: string | null = null;
    let via: ParsedTeam["label_via"] = "fallback";

    // same-row, left of the first anchor: nearest long text (+ optional 1-2 char suffix)
    const sameRow: CellRec[] = [];
    for (let c = minCol - 1; c >= 1; c--) {
      const rec = cells.get(key(topRow, c));
      if (!rec || rec.url || !rec.text || isJunkLabel(rec.text)) continue;
      if (usedNames.has(key(rec.row, rec.col))) continue; // a player's name cell is never the team label
      sameRow.push(rec);
    }
    const long = sameRow.find((r) => stripDecor(r.text).length >= 3);
    const short = sameRow.find((r) => {
      const s = stripDecor(r.text);
      return s.length > 0 && s.length <= 2 && /^[a-z0-9]+$/i.test(s);
    });
    if (long) {
      label = stripDecor(long.text) + (short ? ` ${stripDecor(short.text)}` : "");
      via = "row";
    } else {
      // scan up to 4 rows above; a row with exactly one plausible label wins,
      // a row with 2+ candidates is treated as a player-name row and skipped
      for (let dr = 1; dr <= 4 && !label; dr++) {
        const r = topRow - dr;
        if (r < 1) break;
        const cand: CellRec[] = [];
        for (let c = Math.max(1, minCol - 6); c <= maxCol + 2; c++) {
          const rec = cells.get(key(r, c));
          if (!rec || rec.url || !rec.text) continue;
          if (usedNames.has(key(r, c))) continue;
          if (isJunkLabel(rec.text)) continue;
          cand.push(rec);
        }
        if (cand.length === 1) {
          label = stripDecor(cand[0]!.text);
          via = "above";
        }
      }
    }
    if (!label) {
      fallbackN++;
      label = `Team ${teams.length + 1}`;
      warnings.push(`Could not find a name for the team at sheet row ${topRow} — labeled "${label}".`);
    }

    // dedupe within block (a player linked twice, e.g. name + "#" both linked)
    const seen = new Set<string>();
    const players: ParsedPlayer[] = [];
    for (const a of block) {
      const id = a.user_id !== null ? `u${a.user_id}` : `n${normalizeName(a.name)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      players.push({ name: a.name, user_id: a.user_id, via: a.user_id === null ? "name" : "link", row: a.row, col: a.col });
    }
    teams.push({ name: label, label_via: via, players });
  }

  if (fallbackN > 0) warnings.push(`${fallbackN} team name(s) guessed — review them in the preview.`);
  const nameOnly = teams.reduce((n, t) => n + t.players.filter((p) => p.user_id === null).length, 0);
  if (rankMode) {
    warnings.push(
      `No osu! profile links in this tab — ${nameOnly} player(s) were detected from name + #rank cells and will be ` +
        `matched to lobby data by username (n badge). A player who renamed since the sheet was written won't match.`
    );
  } else if (nameOnly > 0) {
    warnings.push(`${nameOnly} player(s) had a profile link without a numeric ID — they will be matched by username.`);
  }
  return { anchors, teams, warnings, mode: rankMode ? "rank" : "link", orientation: null };
}

/** Parse a whole workbook; the tab with the most anchors wins. */
export async function parseRosterXlsx(buf: Buffer, opts: { orientation?: GridOrientation } = {}): Promise<ParseResult> {
  const prefer = opts.orientation ?? "auto";
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);

  let best: { ws: ExcelJS.Worksheet; parsed: ReturnType<typeof parseWorksheet> } | null = null;
  const others: string[] = [];
  for (const ws of wb.worksheets) {
    let parsed: ReturnType<typeof parseWorksheet>;
    try {
      parsed = parseWorksheet(ws, prefer);
    } catch {
      continue;
    }
    const describe = (name: string, p: ReturnType<typeof parseWorksheet>) =>
      `${name} (${p.anchors.length} ${p.mode === "rank" ? "rank tags" : p.mode === "grid" ? "grid names" : "links"})`;
    // links and rank tags are strong signals; a plain grid counts at half weight when tabs compete
    const weight = (p: ReturnType<typeof parseWorksheet>) => p.anchors.length * (p.mode === "grid" ? 0.5 : 1);
    if (!best || weight(parsed) > weight(best.parsed)) {
      if (best && best.parsed.anchors.length > 0) others.push(describe(best.ws.name, best.parsed));
      best = { ws, parsed };
    } else if (parsed.anchors.length > 0) {
      others.push(describe(ws.name, parsed));
    }
  }

  if (!best || best.parsed.anchors.length === 0) {
    return {
      sheet_name: best?.ws.name ?? "",
      teams: [],
      warnings: [
        "No osu! profile links, no name + #rank cells, and no recognizable name grid (team + names per row/column) in any tab. Hyperlink the player names to their osu! profiles, or use the tab that lists teams with their players.",
      ],
      anchor_count: 0,
      mode: "none",
      orientation: null,
    };
  }

  const warnings = [...best.parsed.warnings];
  if (others.length) warnings.push(`Other tabs also contained players: ${others.join(", ")} — parsed "${best.ws.name}".`);
  return {
    sheet_name: best.ws.name,
    teams: best.parsed.teams,
    warnings,
    anchor_count: best.parsed.anchors.length,
    mode: best.parsed.mode,
    orientation: best.parsed.orientation,
  };
}
