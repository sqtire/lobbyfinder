import ExcelJS from "exceljs";

/**
 * Anchor-first mainsheet parser.
 *
 * Never assumes a layout. Instead:
 *   1. Scan EVERY cell of every tab for an osu! profile reference, in any of
 *      three forms: a rich hyperlink on the cell, a HYPERLINK() formula, or a
 *      raw profile URL as text. Each match is a PLAYER ANCHOR.
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
  label_via: "row" | "above" | "fallback";
  players: ParsedPlayer[];
}
export interface ParseResult {
  sheet_name: string;
  teams: ParsedTeam[];
  warnings: string[];
  anchor_count: number;
}

const PROFILE_RE = /osu\.ppy\.sh\/(?:users|u)\/([^\/\s"'?#\\)]+)/i;
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
}

function parseWorksheet(ws: ExcelJS.Worksheet): { anchors: Anchor[]; teams: ParsedTeam[]; warnings: string[] } {
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
    anchors.push({ row: rec.row, col: rec.col, user_id, name: "", via: "link" });
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

  if (anchors.length === 0) return { anchors, teams: [], warnings: [] };

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
      if (rec && !rec.url && rec.text && !isJunkLabel(rec.text)) sameRow.push(rec);
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
  if (nameOnly > 0)
    warnings.push(`${nameOnly} player(s) had a profile link without a numeric ID — they will be matched by username.`);
  return { anchors, teams, warnings };
}

/** Parse a whole workbook; the tab with the most anchors wins. */
export async function parseRosterXlsx(buf: Buffer): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);

  let best: { ws: ExcelJS.Worksheet; parsed: ReturnType<typeof parseWorksheet> } | null = null;
  const others: string[] = [];
  for (const ws of wb.worksheets) {
    let parsed: ReturnType<typeof parseWorksheet>;
    try {
      parsed = parseWorksheet(ws);
    } catch {
      continue;
    }
    if (!best || parsed.anchors.length > best.parsed.anchors.length) {
      if (best && best.parsed.anchors.length > 0) others.push(`${best.ws.name} (${best.parsed.anchors.length})`);
      best = { ws, parsed };
    } else if (parsed.anchors.length > 0) {
      others.push(`${ws.name} (${parsed.anchors.length})`);
    }
  }

  if (!best || best.parsed.anchors.length === 0) {
    return {
      sheet_name: best?.ws.name ?? "",
      teams: [],
      warnings: [
        "No osu! profile links found in any tab. If player names in this sheet aren't hyperlinked to profiles, add links or use a tab that has them.",
      ],
      anchor_count: 0,
    };
  }

  const warnings = [...best.parsed.warnings];
  if (others.length) warnings.push(`Other tabs also contained profile links: ${others.join(", ")} — parsed "${best.ws.name}".`);
  return {
    sheet_name: best.ws.name,
    teams: best.parsed.teams,
    warnings,
    anchor_count: best.parsed.anchors.length,
  };
}
