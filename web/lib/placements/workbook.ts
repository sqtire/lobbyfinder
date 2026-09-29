import ExcelJS from "exceljs";
import type { PlacementsResult } from "./types";

/**
 * The .xlsx export, laid out like the Stats v5 / TNST result tabs:
 *
 *   Final Placements       points → tiebreak → per-round results
 *   Performance Scores     #, player, tiebreak, maps played, top scores, avg placement, averages, best score
 *   Mappool Stats          one row per DIFFICULTY (NM1 T1, NM1 T2, …): best player/score/acc/mods/match, average, median
 *   Individual Leaderboards side-by-side blocks per slot (both tiers in one block, RAW scores)
 *   Solo Placements        per slot: placement + best raw score
 *   Tiebreak Detail        what the tiebreak actually used (adjusted scores, adjusted placements, values)
 *   Matches / Games / Summary  audit trail
 *
 * Scores are normalized with the score multipliers everywhere (raw values stay in Games); the ×0.95
 * lower-tier factor lives only in Tiebreak Detail.
 */

const NUM = "#,##0";
const PCT = "0.00%";
const DEC = "0.0000";
const DEC2 = "0.00";
const dispMods = (mods: string[]) => mods.filter((m) => m !== "NF").join("") || "NM";
const roomUrl = (kind: "lazer" | "legacy", id: number) => (kind === "lazer" ? `https://osu.ppy.sh/multiplayer/rooms/${id}` : `https://osu.ppy.sh/community/matches/${id}`);
const tierName = (tier: number, tiers: number) => (tiers > 1 ? (tier === 0 ? "T1" : tiers === 2 ? "T2" : `T${tier + 1}`) : "");

const HEAD_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2B2135" } };
const HEAD_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: "FFFFFFFF" } };
const TITLE_FONT: Partial<ExcelJS.Font> = { bold: true, size: 14 };
const SUB_FONT: Partial<ExcelJS.Font> = { italic: true, color: { argb: "FF6F6280" } };

export async function placementsWorkbook(res: PlacementsResult): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "MP Pool Scanner — final placements";
  wb.created = new Date();
  const title = (res.title || "Final placements").toUpperCase();
  const tiebreak = res.tiebreak_label;
  const slotsTotal = res.maps.length;

  const widths = (ws: ExcelJS.Worksheet, ws_widths: number[], from = 1) => ws_widths.forEach((w, i) => (ws.getColumn(from + i).width = w));
  const headRow = (ws: ExcelJS.Worksheet, rowNo: number, from = 1, to?: number) => {
    const row = ws.getRow(rowNo);
    const end = to ?? row.cellCount;
    for (let c = from; c <= end; c++) {
      const cell = row.getCell(c);
      cell.font = HEAD_FONT;
      cell.fill = HEAD_FILL;
      cell.alignment = { vertical: "middle" };
    }
  };
  const titleRow = (ws: ExcelJS.Worksheet, text: string, sub?: string) => {
    ws.addRow([text]).font = TITLE_FONT;
    if (sub) ws.addRow([sub]).font = SUB_FONT;
    ws.addRow([]);
  };
  const fmt = (ws: ExcelJS.Worksheet, cols: number[], f: string) => cols.forEach((c) => (ws.getColumn(c).numFmt = f));
  const acc = (a: number | null | undefined) => (a === null || a === undefined ? "" : a);
  const num = (n: number | null | undefined) => (n === null || n === undefined ? "" : n);

  // ---- Final Placements ------------------------------------------------------
  {
    const ws = wb.addWorksheet("Final Placements");
    titleRow(ws, `${title} - FINAL PLACEMENTS`, `Ordered by points, then ${tiebreak}. ${res.formula[2]}`);
    const head = ["#", "Player", "User ID", "Points", "W", "L", "FF W", "FF L", "Matches", `Tiebreak (${tiebreak})`, "Top scores", "Avg. placement", "Maps played", "Avg. score", "Avg. acc", "Best map", "Best score", "Buchholz", ...res.stages];
    ws.addRow(head);
    const headNo = ws.rowCount;
    for (const p of res.placements) {
      ws.addRow([
        p.rank,
        p.player.name,
        p.player.user_id ?? "",
        p.points,
        p.wins,
        p.losses,
        p.forfeit_wins,
        p.forfeit_losses,
        p.matches,
        num(p.performance),
        p.top_scores,
        num(p.avg_placement),
        `${p.unique_maps} / ${p.slots_total}`,
        num(p.avg_score),
        acc(p.avg_acc),
        p.best?.label ?? "",
        p.best?.score ?? "",
        p.buchholz,
        ...res.stages.map((s) => {
          const st = p.stages.find((x) => x.stage === s);
          return st && st.result !== "—" ? `${st.result} ${st.score}${st.opponent ? ` vs ${st.opponent.name}` : ""}` : "";
        }),
      ]);
    }
    headRow(ws, headNo);
    ws.views = [{ state: "frozen", ySplit: headNo, xSplit: 2 }];
    widths(ws, [5, 22, 11, 7, 5, 5, 6, 6, 8, 16, 10, 12, 11, 12, 9, 10, 12, 9, ...res.stages.map(() => 26)]);
    fmt(ws, [10], DEC);
    fmt(ws, [12], DEC2);
    fmt(ws, [14, 17], NUM);
    fmt(ws, [15], PCT);
  }

  // ---- Performance Scores (tiebreak alone) ------------------------------------
  {
    const ws = wb.addWorksheet("Performance Scores");
    titleRow(ws, `${title} - INDIVIDUAL STATISTICS`, `Performance = ${tiebreak}; sorted by it alone, points ignored.`);
    ws.addRow(["#", "Player", "User ID", "Performance ▼", "Maps played", "%", "Top scores", "Avg. placement", "Avg. score", "Avg. acc", "Best map", "Best score", "Best match", "Points", "Placement"]);
    const headNo = ws.rowCount;
    const rows = [...res.placements].sort((a, b) => (b.performance ?? -Infinity) - (a.performance ?? -Infinity) || (b.avg_value ?? -Infinity) - (a.avg_value ?? -Infinity));
    rows.forEach((p, i) =>
      ws.addRow([
        i + 1,
        p.player.name,
        p.player.user_id ?? "",
        num(p.performance),
        `${p.unique_maps} / ${slotsTotal}`,
        slotsTotal ? p.unique_maps / slotsTotal : "",
        p.top_scores,
        num(p.avg_placement),
        num(p.avg_score),
        acc(p.avg_acc),
        p.best?.label ?? "",
        p.best?.score ?? "",
        p.best?.match_id ?? "",
        p.points,
        p.rank,
      ])
    );
    headRow(ws, headNo);
    ws.views = [{ state: "frozen", ySplit: headNo, xSplit: 2 }];
    widths(ws, [5, 22, 11, 14, 11, 7, 10, 13, 12, 9, 10, 12, 10, 7, 10]);
    fmt(ws, [4], DEC);
    fmt(ws, [6, 10], PCT);
    fmt(ws, [8], DEC2);
    fmt(ws, [9, 12], NUM);
  }

  // ---- Mappool Stats (one row per difficulty) ---------------------------------
  {
    const ws = wb.addWorksheet("Mappool Stats");
    titleRow(ws, `${title} - MAPPOOL STATISTICS`, res.score_rules.length ? "One row per difficulty; scores normalized with the score multipliers (Score × column)." : "One row per difficulty.");
    ws.addRow(["Map", "Tier", "Artist - Title [Diff]", "Map ID", "Stars", "Score ×", "Best player", "Score", "Acc", "Mods", "Match", "Lobby", "Plays", "Avg. score", "Median", "Avg. acc"]);
    const headNo = ws.rowCount;
    for (const m of res.maps) {
      for (const b of m.beatmaps) {
        ws.addRow([
          m.label,
          tierName(b.tier, m.beatmaps.length),
          b.title,
          b.beatmap_id,
          num(b.difficulty_rating),
          b.score_multipliers,
          b.best?.player.name ?? "",
          b.best?.score ?? "",
          b.best ? b.best.accuracy : "",
          b.best ? dispMods(b.best.mods) : "",
          b.best?.match_id ?? "",
          b.best ? roomUrl(b.best.room_kind, b.best.room_id) : "",
          b.plays,
          num(b.mean),
          num(b.median),
          acc(b.avg_acc),
        ]);
      }
    }
    headRow(ws, headNo);
    ws.views = [{ state: "frozen", ySplit: headNo, xSplit: 3 }];
    widths(ws, [7, 5, 52, 10, 6, 16, 20, 11, 8, 7, 8, 44, 6, 12, 12, 9]);
    fmt(ws, [5], DEC2);
    fmt(ws, [8, 14, 15], NUM);
    fmt(ws, [9, 16], PCT);
  }

  // ---- Individual Leaderboards (side-by-side blocks per slot, raw) ------------
  {
    const ws = wb.addWorksheet("Individual Leaderboards");
    const withMult = res.score_rules.length > 0;
    const COLS = withMult ? ["#", "Player", "Tier", "Score", "×", "Accuracy", "Max. Combo", "Mods", "Match"] : ["#", "Player", "Tier", "Score", "Accuracy", "Max. Combo", "Mods", "Match"];
    const W = COLS.length + 1; // one spacer column between blocks (COLS depends on withMult)
    const maxRows = Math.max(0, ...res.maps.map((m) => (res.leaderboards[m.key] ?? []).length));
    const cellAt = (r: number, c: number) => ws.getRow(r).getCell(c);
    res.maps.forEach((m, bi) => {
      const c0 = 2 + bi * W;
      const tiers = m.beatmaps.length;
      cellAt(1, c0).value = m.label;
      cellAt(1, c0).font = TITLE_FONT;
      cellAt(1, c0 + 3).value = "Avg. Score:";
      cellAt(1, c0 + 4).value = num(m.mean);
      cellAt(1, c0 + 4).numFmt = NUM;
      cellAt(2, c0 + 3).value = "Avg. Acc:";
      cellAt(2, c0 + 4).value = acc(m.avg_acc);
      cellAt(2, c0 + 4).numFmt = PCT;
      cellAt(2, c0 + 5).value = `${m.plays} plays / ${m.players} players`;
      cellAt(2, c0 + 5).font = SUB_FONT;
      m.beatmaps.forEach((b, ti) => {
        const cell = cellAt(3 + ti, c0);
        cell.value = tiers > 1 ? `${tierName(b.tier, tiers)}: ${b.title}` : b.title;
        cell.font = SUB_FONT;
      });
      const headNo = 3 + Math.max(1, tiers);
      COLS.forEach((h, i) => (cellAt(headNo, c0 + i).value = h));
      headRow(ws, headNo, c0, c0 + COLS.length - 1);
      (res.leaderboards[m.key] ?? []).forEach((e, i) => {
        const r = headNo + 1 + i;
        cellAt(r, c0).value = e.rank;
        cellAt(r, c0 + 1).value = e.player.name;
        cellAt(r, c0 + 2).value = tierName(e.tier, tiers);
        cellAt(r, c0 + 3).value = Math.round(e.score);
        cellAt(r, c0 + 3).numFmt = NUM;
        const o = withMult ? 1 : 0;
        if (withMult) {
          cellAt(r, c0 + 4).value = e.score_multiplier === 1 ? "" : Number(e.score_multiplier.toFixed(4));
        }
        cellAt(r, c0 + 4 + o).value = e.accuracy;
        cellAt(r, c0 + 4 + o).numFmt = PCT;
        cellAt(r, c0 + 5 + o).value = e.max_combo ?? "";
        cellAt(r, c0 + 6 + o).value = dispMods(e.mods) + (e.passed ? "" : " (F)");
        cellAt(r, c0 + 7 + o).value = { text: e.match_id ? `#${e.match_id}` : "lobby", hyperlink: roomUrl(e.room_kind, e.room_id) };
        cellAt(r, c0 + 7 + o).font = { color: { argb: "FF0563C1" }, underline: true };
      });
      widths(ws, withMult ? [4, 20, 5, 11, 6, 10, 10, 7, 8, 2] : [4, 20, 5, 11, 10, 10, 7, 8, 2], c0);
    });
    ws.getColumn(1).width = 2;
    ws.addRow([]); // ensure the sheet isn't empty when there are no maps
    void maxRows;
    ws.views = [{ state: "frozen", ySplit: 0, xSplit: 0 }];
  }

  // ---- Solo Placements (placement + best raw score per slot) ------------------
  {
    const ws = wb.addWorksheet("Solo Placements");
    titleRow(ws, `${title} - INDIVIDUAL SCORES`, `Best ${res.score_rules.length ? "normalized" : "raw"} score per slot and its placement among every player's best (ties share).`);
    const head: unknown[] = ["#", "Player", "Points", `Tiebreak`, "Top scores", "Avg. placement"];
    res.maps.forEach((m) => head.push(`${m.label} #`, `${m.label} score`));
    ws.addRow(head);
    const headNo = ws.rowCount;
    for (const p of res.placements) {
      const row: unknown[] = [p.rank, p.player.name, p.points, num(p.performance), p.top_scores, num(p.avg_placement)];
      for (const m of res.maps) {
        const c = res.grid.cells[p.player.key]?.[m.key] ?? null;
        row.push(c ? c.placement : "", c ? Math.round(c.score) : "");
      }
      ws.addRow(row);
    }
    headRow(ws, headNo);
    ws.views = [{ state: "frozen", ySplit: headNo, xSplit: 2 }];
    widths(ws, [5, 22, 7, 11, 10, 13, ...res.maps.flatMap(() => [6, 11])]);
    fmt(ws, [4], DEC);
    fmt(ws, [6], DEC2);
    res.maps.forEach((_, i) => (ws.getColumn(8 + i * 2).numFmt = NUM));
  }

  // ---- Tiebreak Detail --------------------------------------------------------
  {
    const ws = wb.addWorksheet("Tiebreak Detail");
    const mult = res.settings.lower_multiplier;
    titleRow(ws, `${title} - TIEBREAK DETAIL (${tiebreak})`, res.formula[1]);
    const zipf = res.settings.value_mode === "zipf";
    const head: unknown[] = ["#", "Player", "Points", "Tiebreak", "Avg. value", "Slots used"];
    res.maps.forEach((m) => head.push(`${m.label} adj`, `${m.label} adj #`, `${m.label} value`));
    ws.addRow(head);
    const headNo = ws.rowCount;
    for (const p of res.placements) {
      const row: unknown[] = [p.rank, p.player.name, p.points, num(p.performance), num(p.avg_value), p.unique_maps];
      for (const m of res.maps) {
        const c = res.grid.cells[p.player.key]?.[m.key] ?? null;
        row.push(c ? c.tiebreak.adjusted : "", c ? c.tiebreak.placement : "", c && c.tiebreak.value !== null ? c.tiebreak.value : "");
      }
      ws.addRow(row);
    }
    ws.addRow([]);
    ws.addRow(["Slot", "Rated", "Adj. mean", "Adj. stdev", "Plays", "Players", "Lower tier ×"]);
    const h2 = ws.rowCount;
    for (const m of res.maps) ws.addRow([m.label, m.tiebreak.rated ? "yes" : "no", num(m.tiebreak.mean_adj), num(m.tiebreak.stdev_adj), m.plays, m.players, m.beatmaps.length > 1 ? mult : ""]);
    headRow(ws, headNo);
    headRow(ws, h2, 1, 7);
    ws.views = [{ state: "frozen", ySplit: headNo, xSplit: 2 }];
    widths(ws, [5, 22, 7, 11, 11, 10, ...res.maps.flatMap(() => [11, 8, 9])]);
    fmt(ws, [4, 5], DEC);
    res.maps.forEach((_, i) => {
      ws.getColumn(7 + i * 3).numFmt = NUM;
      ws.getColumn(9 + i * 3).numFmt = zipf ? "0.000" : DEC;
    });
  }

  // ---- Matches ----------------------------------------------------------------
  {
    const ws = wb.addWorksheet("Matches");
    ws.addRow(["Stage", "Match", "Date", "Red", "Blue", "Sheet score", "Outcome", "Points red", "Points blue", "First to", "Counted maps", "Lobby raw score", "Lobbies", "Notes"]);
    for (const m of res.matches) {
      ws.addRow([
        m.stage,
        m.match_id,
        m.date ?? "",
        m.red.name,
        m.blue.name,
        m.sheet_score ? `${m.sheet_score[0]}–${m.sheet_score[1]}` : m.forfeit ? `FF (${m.forfeit})` : "",
        m.outcome,
        m.points[0],
        m.points[1],
        m.first_to ?? "",
        m.counted,
        m.lobby_score ? `${m.lobby_score[0]}–${m.lobby_score[1]}` : "",
        m.rooms.map((x) => `${x.ref.url}${x.ok ? "" : ` (${x.error})`}`).join(" | "),
        m.notes.join(" "),
      ]);
    }
    headRow(ws, 1);
    ws.views = [{ state: "frozen", ySplit: 1 }];
    widths(ws, [12, 8, 16, 20, 20, 11, 12, 9, 9, 8, 9, 12, 48, 60]);
  }

  // ---- Games (every lobby game, counted or not) ----------------------------------
  {
    const ws = wb.addWorksheet("Games");
    ws.addRow(["Stage", "Match", "Red", "Blue", "#", "Lobby", "Item ID", "Slot", "Item beatmap", "Red score (raw)", "Red normalized", "Red acc", "Red mods", "Red diff", "Blue score (raw)", "Blue normalized", "Blue acc", "Blue mods", "Blue diff", "Map winner", "Score after", "Status", "Reason"]);
    for (const m of res.matches) {
      for (const gm of m.games) {
        ws.addRow([
          m.stage,
          m.match_id,
          m.red.name,
          m.blue.name,
          gm.order,
          roomUrl(gm.room_kind, gm.room_id),
          gm.item_id,
          gm.label ?? "",
          gm.beatmap_id,
          gm.red?.score ?? "",
          gm.red_norm !== null ? Math.round(gm.red_norm) : "",
          gm.red ? gm.red.accuracy : "",
          gm.red ? dispMods(gm.red.mods) : "",
          gm.red?.beatmap_id ?? "",
          gm.blue?.score ?? "",
          gm.blue_norm !== null ? Math.round(gm.blue_norm) : "",
          gm.blue ? gm.blue.accuracy : "",
          gm.blue ? dispMods(gm.blue.mods) : "",
          gm.blue?.beatmap_id ?? "",
          gm.raw_winner ?? "",
          gm.score_after ? `${gm.score_after[0]}–${gm.score_after[1]}` : "",
          gm.status,
          gm.reason ?? "",
        ]);
      }
    }
    headRow(ws, 1);
    ws.views = [{ state: "frozen", ySplit: 1 }];
    widths(ws, [12, 8, 18, 18, 5, 44, 11, 7, 11, 12, 12, 8, 8, 10, 12, 12, 8, 8, 10, 9, 10, 9, 50]);
    fmt(ws, [10, 11, 15, 16], NUM);
    fmt(ws, [12, 17], PCT);
  }

  // ---- Summary ------------------------------------------------------------------
  {
    const ws = wb.addWorksheet("Summary");
    ws.addRows([
      ["Tournament", res.title],
      ["Generated", res.generated_at],
      ["Stages", res.stages.join(", ")],
      ["Matches", res.counts.matches],
      ["Lobbies read", res.counts.rooms],
      ["Maps counted / excluded", `${res.counts.games_counted} / ${res.counts.games_excluded}`],
      ["Players", res.counts.players],
      [],
      ["Formula"],
      ...res.formula.map((f) => [f]),
      [],
      ["Settings"],
      ["Tiebreak", tiebreak],
      ["Prior maps (k)", res.settings.prior_maps],
      ["Min plays per slot", res.settings.min_plays],
      ["Weighting (Φ/z only)", res.settings.map_weighting === "per_map" ? "per slot" : "per play"],
      ["Lower-tier multiplier (tiebreak only)", res.settings.lower_multiplier],
      ["Score multipliers", res.score_rules.length ? `${res.score_rules.length} rule(s) — listed below` : "none"],
      ["Count failed scores", res.settings.count_failed ? "yes" : "no"],
      ["Count maps before a forfeit", res.settings.forfeit_lobby_maps ? "yes" : "no"],
      ["Excluded items", res.settings.excluded_items.join(", ") || "none"],
      ["Sheet", res.settings.sheet_url],
      ["Tab", res.settings.sheet_tab],
      ...(res.score_rules.length
        ? [[], ["Score multipliers (normalization, applied to every stat)"], ["Stage", "Slot", "Tier", "Mods", "Multiplier"], ...res.score_rules.map((r) => [r.stage ?? "all", r.label ?? "all", r.tier === null ? "any" : `T${r.tier + 1}`, r.mods.join("") || "—", r.factor])]
        : []),
      [],
      ["Notes"],
      ...res.notes.map((n) => [n]),
      [],
      ["Pool"],
      ...res.maps.flatMap((m) => m.beatmaps.map((b) => [m.label, tierName(b.tier, m.beatmaps.length), b.beatmap_id, b.title, b.url])),
    ]);
    widths(ws, [34, 14, 12, 50, 36]);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
