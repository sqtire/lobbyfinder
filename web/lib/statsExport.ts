import ExcelJS from "exceljs";
import type { Hit, Roster } from "./types";
import type { StatsResult } from "./stats";
import { normalizeName } from "./rosterParse";

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvRow = (cells: unknown[]) => cells.map(csvCell).join(",");
export const mapLabel = (m: { beatmap_id: number; title: string | null; version: string | null }) =>
  m.title ? `${m.title}${m.version ? ` [${m.version}]` : ""}` : `#${m.beatmap_id}`;
const dispMods = (mods: string[] | undefined) => (mods ?? []).filter((m) => m !== "NF").join("") || "NM";

// ---- the Teams-grid viewport as rows: one row per roster player, best score/acc/mods per pool map ----

export interface GridExportRow {
  team: string;
  player: string;
  user_id: number | null;
  cells: ({ score: number; acc: number | null; mods: string[]; match_id: number } | null)[];
}
export function buildGridRows(pool: number[], hits: Hit[], roster: Roster | null): { rows: GridExportRow[]; maps: { beatmap_id: number; title: string | null; version: string | null }[] } {
  const poolSet = new Set(pool);
  const nameToId = new Map<string, number>();
  const meta = new Map<number, { title: string | null; version: string | null }>();
  const best = new Map<number, Map<number, { score: number; acc: number | null; mods: string[]; match_id: number }>>();
  for (const h of hits) {
    for (const p of h.players ?? []) {
      const k = normalizeName(p.username);
      if (!nameToId.has(k)) nameToId.set(k, p.user_id);
    }
    for (const g of h.games) {
      if (!poolSet.has(g.beatmap_id)) continue;
      if (!meta.has(g.beatmap_id)) meta.set(g.beatmap_id, { title: g.title, version: g.version });
      for (const s of g.scores ?? []) {
        let byMap = best.get(s.user_id);
        if (!byMap) best.set(s.user_id, (byMap = new Map()));
        const cur = byMap.get(g.beatmap_id);
        if (!cur || s.score > cur.score) byMap.set(g.beatmap_id, { score: s.score, acc: s.accuracy ?? null, mods: s.mods ?? [], match_id: h.match_id });
      }
    }
  }
  const rows: GridExportRow[] = [];
  for (const t of roster?.teams ?? []) {
    for (const p of t.players) {
      const uid = p.user_id ?? nameToId.get(normalizeName(p.name)) ?? null;
      const byMap = uid !== null ? best.get(uid) : undefined;
      rows.push({ team: t.name, player: p.name, user_id: uid, cells: pool.map((bid) => byMap?.get(bid) ?? null) });
    }
  }
  return { rows, maps: pool.map((bid) => ({ beatmap_id: bid, title: meta.get(bid)?.title ?? null, version: meta.get(bid)?.version ?? null })) };
}

export function gridCsv(pool: number[], hits: Hit[], roster: Roster | null): string {
  const { rows, maps } = buildGridRows(pool, hits, roster);
  const head = ["team", "player", "user_id"];
  for (const m of maps) {
    const l = mapLabel(m);
    head.push(`${l} score`, `${l} acc`, `${l} mods`, `${l} match_id`);
  }
  const lines = [csvRow(head)];
  for (const r of rows) {
    const cells: unknown[] = [r.team, r.player, r.user_id];
    for (const c of r.cells) cells.push(c ? c.score : "", c && c.acc !== null ? (c.acc * 100).toFixed(2) + "%" : "", c ? dispMods(c.mods) : "", c ? c.match_id : "");
    lines.push(csvRow(cells));
  }
  return "\uFEFF" + lines.join("\r\n");
}

// ---- XLSX workbook: the stats sheet's tabs ----

export async function statsWorkbook(opts: {
  tournament: string;
  slug: string;
  stats: StatsResult;
  grid: ReturnType<typeof buildGridRows>;
}): Promise<Buffer> {
  const { stats } = opts;
  const wb = new ExcelJS.Workbook();
  wb.creator = "MP Pool Scanner";
  wb.created = new Date();
  const label = (i: number) => mapLabel(stats.maps[i]!);
  const NUM = "#,##0";
  const PCT = "0.00%";
  const DEC = "0.0000";
  const style = (ws: ExcelJS.Worksheet, widths: number[]) => {
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  };
  const fmtCols = (ws: ExcelJS.Worksheet, cols: number[], fmt: string) => cols.forEach((c) => (ws.getColumn(c).numFmt = fmt));

  // Settings / summary
  {
    const ws = wb.addWorksheet("Summary");
    ws.addRows([
      ["Tournament", opts.tournament, `/t/${opts.slug}`],
      ["Generated", stats.generated_at],
      ["Lobbies used", stats.lobbies_used],
      ["Method", stats.method_label, stats.aggregate_label],
      ["Count failed scores", stats.settings.count_failed ? "yes" : "no"],
      ["Scores per team per map", stats.settings.players_per_map || "all who played"],
      ["Match cost mod scaling (Stats v5 quirk)", stats.settings.mc_mod_scaling ? "on" : "off"],
      ["Roster", stats.has_roster ? "synced" : "none"],
      [],
      ["Notes"],
      ...stats.notes.map((n) => [n]),
      [],
      ["Pool"],
      ...stats.maps.map((m, i) => [i + 1, m.beatmap_id, mapLabel(m), m.url]),
    ]);
    ws.getColumn(1).width = 30;
    ws.getColumn(2).width = 40;
    ws.getColumn(3).width = 50;
    ws.getColumn(4).width = 40;
  }

  // Team placements
  if (stats.has_roster) {
    const ws = wb.addWorksheet("Team placements");
    const head = ["#", "Team", stats.aggregate_label, "Avg score", "Maps played"];
    stats.maps.forEach((_, i) => head.push(`${label(i)} #`, `${label(i)} score`));
    ws.addRow(head);
    for (const t of stats.teams) {
      const row: unknown[] = [t.rank, t.name, t.aggregate, t.avg_score, t.maps_played];
      for (const c of t.cells) row.push(c.placement ?? "", c.score || "");
      ws.addRow(row);
    }
    style(ws, [5, 28, 12, 14, 8, ...stats.maps.flatMap(() => [8, 12])]);
    ws.getColumn(3).numFmt = DEC;
    ws.getColumn(4).numFmt = NUM;
    stats.maps.forEach((_, i) => (ws.getColumn(7 + i * 2).numFmt = NUM));
  }

  // Player placements
  {
    const ws = wb.addWorksheet("Player placements");
    const head = ["#", "Player", "User ID", "Team", stats.aggregate_label, "Avg score", "Avg acc", "Maps played"];
    stats.maps.forEach((_, i) => head.push(`${label(i)} #`, `${label(i)} score`));
    ws.addRow(head);
    for (const p of stats.players) {
      const row: unknown[] = [p.rank, p.name, p.user_id, p.team ?? "", p.aggregate, p.avg_score, p.avg_acc ?? "", p.maps_played];
      for (const c of p.cells) row.push(c.placement ?? "", c.score || "");
      ws.addRow(row);
    }
    style(ws, [5, 22, 11, 24, 12, 14, 9, 8, ...stats.maps.flatMap(() => [8, 12])]);
    ws.getColumn(5).numFmt = DEC;
    ws.getColumn(6).numFmt = NUM;
    ws.getColumn(7).numFmt = PCT;
    stats.maps.forEach((_, i) => (ws.getColumn(10 + i * 2).numFmt = NUM));
  }

  // Team leaderboards (flat: one row per contributing player)
  if (stats.has_roster) {
    const ws = wb.addWorksheet("Team leaderboards");
    ws.addRow(["Map", "#", "Team", "Team score", "Match", "Player", "User ID", "Score", "Acc", "Mods", "Passed"]);
    stats.team_leaderboards.forEach((entries, i) => {
      for (const e of entries) {
        if (e.players.length === 0) ws.addRow([label(i), e.rank, e.team, e.team_score, e.match_id ?? "", "", "", "", "", "", ""]);
        for (const p of e.players) ws.addRow([label(i), e.rank, e.team, e.team_score, e.match_id ?? "", p.name, p.user_id, p.score, p.acc ?? "", dispMods(p.mods), p.passed ? "yes" : "no"]);
      }
    });
    style(ws, [34, 5, 26, 14, 12, 22, 11, 12, 9, 8, 8]);
    fmtCols(ws, [4, 8], NUM);
    ws.getColumn(9).numFmt = PCT;
  }

  // Player leaderboards
  {
    const ws = wb.addWorksheet("Player leaderboards");
    ws.addRow(["Map", "#", "Player", "User ID", "Team", "Score", "Acc", "Mods", "Passed", "Match"]);
    stats.player_leaderboards.forEach((entries, i) => {
      for (const e of entries) ws.addRow([label(i), e.rank, e.name, e.user_id, e.team ?? "", e.score, e.acc ?? "", dispMods(e.mods), e.passed ? "yes" : "no", e.match_id ?? ""]);
    });
    style(ws, [34, 5, 22, 11, 24, 12, 9, 8, 8, 12]);
    ws.getColumn(6).numFmt = NUM;
    ws.getColumn(7).numFmt = PCT;
  }

  // Performance (match cost)
  {
    const ws = wb.addWorksheet("Performance");
    ws.addRow(["#", "Player", "User ID", "Team", "Match cost", "Lobbies", "Played", "Played %", "MVPs", "Avg score", "Avg acc", "Best map", "Best score", "Best match"]);
    for (const p of stats.performance) {
      const bestIdx = p.best ? stats.maps.findIndex((m) => m.beatmap_id === p.best!.beatmap_id) : -1;
      ws.addRow([p.rank, p.name, p.user_id, p.team ?? "", p.match_cost, p.lobbies, p.played, p.played_pct, p.mvps, p.avg_score, p.avg_acc ?? "", bestIdx >= 0 ? label(bestIdx) : "", p.best?.score ?? "", p.best?.match_id ?? ""]);
    }
    style(ws, [5, 22, 11, 24, 12, 8, 8, 9, 6, 14, 9, 34, 12, 12]);
    ws.getColumn(5).numFmt = DEC;
    ws.getColumn(8).numFmt = PCT;
    ws.getColumn(10).numFmt = NUM;
    ws.getColumn(11).numFmt = PCT;
    ws.getColumn(13).numFmt = NUM;
  }

  // Mappool stats
  {
    const ws = wb.addWorksheet("Mappool");
    ws.addRow(["#", "Map", "Beatmap ID", "Plays", "Best player", "Score", "Acc", "Mods", "Match", "Best team", "Team score", "Match", "Avg score", "Avg acc", "Avg team score"]);
    stats.mappool.forEach((m, i) => {
      ws.addRow([
        i + 1,
        label(i),
        m.beatmap_id,
        m.plays,
        m.best_player?.name ?? "",
        m.best_player?.score ?? "",
        m.best_player?.acc ?? "",
        m.best_player ? dispMods(m.best_player.mods) : "",
        m.best_player?.match_id ?? "",
        m.best_team?.team ?? "",
        m.best_team?.score ?? "",
        m.best_team?.match_id ?? "",
        m.avg_score ?? "",
        m.avg_acc ?? "",
        m.avg_team_score ?? "",
      ]);
    });
    style(ws, [5, 34, 12, 7, 22, 12, 9, 8, 12, 26, 14, 12, 14, 9, 14]);
    fmtCols(ws, [6, 11, 13, 15], NUM);
    fmtCols(ws, [7, 14], PCT);
  }

  // Grid (the Teams tab as displayed)
  {
    const ws = wb.addWorksheet("Grid");
    const head = ["Team", "Player", "User ID"];
    for (const m of opts.grid.maps) {
      const l = mapLabel(m);
      head.push(`${l} score`, `${l} acc`, `${l} mods`);
    }
    ws.addRow(head);
    for (const r of opts.grid.rows) {
      const row: unknown[] = [r.team, r.player, r.user_id ?? ""];
      for (const c of r.cells) row.push(c ? c.score : "", c && c.acc !== null ? c.acc : "", c ? dispMods(c.mods) : "");
      ws.addRow(row);
    }
    style(ws, [26, 22, 11, ...opts.grid.maps.flatMap(() => [12, 9, 8])]);
    opts.grid.maps.forEach((_, i) => {
      ws.getColumn(4 + i * 3).numFmt = NUM;
      ws.getColumn(5 + i * 3).numFmt = PCT;
    });
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}
