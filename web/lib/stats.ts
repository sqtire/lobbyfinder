/**
 * Qualifier statistics, computed from a tournament's stored lobbies + roster +
 * pool. Replicates the "Stats v5" (HitomiChan_) sheet used for 5USC:
 *
 *   per map, for every team (and every player):
 *     placements  → RANK(score) (1 = best; ties share the rank; unplayed = 0 = last)
 *     maxpct      → score / MAX(score)
 *     pctdiff     → max(0, score − MIN(score)) / MAX(score)
 *     zsum        → Φ((score − AVERAGE(score)) / STDEV(score))   (Φ = standard normal CDF, sample stdev)
 *     zipf        → 100 / (RANK(score) + nMaps × 1.4)
 *   aggregate: SUM over maps for zsum, otherwise SUM / nMaps (an average)
 *   ranking: ascending for placements, descending otherwise; ties by avg score desc.
 *
 * Team score on a map = the sum of its members' scores on that map (Stats v5
 * sums whatever the team posted in the lobby); we take each player's best
 * score per map across lobbies first, and optionally cap the number of
 * contributing scores (e.g. 3 for 3v3). Match cost follows the sheet's
 * qualifier variant: per lobby, 2/(n+2) · Σ score / (field average of that map
 * across ALL lobbies), MVP = top score on a map within the lobby, and a
 * player's cost is the mean over their lobbies. (Stats v5 divides each score
 * by its mod multiplier — HD 1.06, HR 1.1, DT 1.2, EZ 0.5 — before dividing
 * by the RAW field average, which penalises mod maps; `mc_mod_scaling` turns
 * that quirk on for sheet-identical numbers, off by default.)
 */

import type { Hit, Roster } from "./types";
import { normalizeName } from "./rosterParse";

export type StatsMethod = "placements" | "maxpct" | "pctdiff" | "zsum" | "zipf";
export const STATS_METHODS: { id: StatsMethod; label: string; agg: string; sort: "asc" | "desc" }[] = [
  { id: "zsum", label: "Z-Sum", agg: "Z-Sum", sort: "desc" },
  { id: "placements", label: "Avg. placements", agg: "Avg. place", sort: "asc" },
  { id: "maxpct", label: "Max %", agg: "Avg. max%", sort: "desc" },
  { id: "pctdiff", label: "% difference", agg: "Avg. %diff", sort: "desc" },
  { id: "zipf", label: "Zipfian", agg: "Avg. Zipf", sort: "desc" },
];

export interface StatsSettings {
  method: StatsMethod;
  count_failed: boolean; // include scores where passed=false
  players_per_map: number; // 0 = all members who scored count toward the team score; N = top N
  mc_mod_scaling: boolean; // Stats v5 quirk: match-cost numerator divided by the score's mod multiplier
}
export const DEFAULT_STATS: StatsSettings = { method: "zsum", count_failed: true, players_per_map: 0, mc_mod_scaling: false };

/** Score multipliers osu! applies for mods (used only when mc_mod_scaling is on). */
export function modMultiplier(mods: string[]): number {
  let m = 1;
  for (const x of mods) {
    switch (x.toUpperCase()) {
      case "HD": m *= 1.06; break;
      case "HR": m *= 1.1; break;
      case "DT": case "NC": m *= 1.2; break;
      case "FL": m *= 1.12; break;
      case "EZ": m *= 0.5; break;
      case "HT": m *= 0.3; break;
      case "SO": m *= 0.9; break;
      default: break; // NF, PF, SD, TD, MR… leave score-v2 multipliers as-is
    }
  }
  return m;
}

export function sanitizeStatsSettings(v: unknown): StatsSettings {
  const o = (v ?? {}) as Partial<StatsSettings>;
  const method = STATS_METHODS.some((m) => m.id === o.method) ? (o.method as StatsMethod) : DEFAULT_STATS.method;
  const ppm = Number(o.players_per_map);
  return {
    method,
    count_failed: o.count_failed === undefined ? true : !!o.count_failed,
    players_per_map: Number.isInteger(ppm) && ppm >= 0 && ppm <= 16 ? ppm : 0,
    mc_mod_scaling: !!o.mc_mod_scaling,
  };
}

// ---- output shapes ---------------------------------------------------------

export interface StatMap {
  beatmap_id: number;
  title: string | null;
  version: string | null;
  url: string;
}
export interface MapCell {
  score: number; // 0 when unplayed
  placement: number | null; // rank among the population (null when unplayed)
  value: number; // method value for this map
  acc?: number | null;
  mods?: string[];
  match_id?: number | null;
  passed?: boolean;
}
export interface TeamRow {
  rank: number;
  name: string;
  aggregate: number;
  avg_score: number; // sum of team scores / nMaps (Stats v5)
  maps_played: number;
  cells: MapCell[]; // aligned to maps
}
export interface PlayerRow {
  rank: number;
  name: string;
  user_id: number | null;
  team: string | null;
  aggregate: number;
  avg_score: number; // over maps played
  avg_acc: number | null;
  maps_played: number;
  cells: MapCell[];
}
export interface TeamLeaderboardEntry {
  rank: number;
  team: string;
  team_score: number;
  match_id: number | null;
  players: { name: string; user_id: number | null; score: number; acc: number | null; mods: string[]; passed: boolean }[];
}
export interface PlayerLeaderboardEntry {
  rank: number;
  name: string;
  user_id: number | null;
  team: string | null;
  score: number;
  acc: number | null;
  mods: string[];
  passed: boolean;
  match_id: number | null;
}
export interface PerformanceRow {
  rank: number;
  name: string;
  user_id: number | null;
  team: string | null;
  match_cost: number;
  lobbies: number;
  played: number;
  played_pct: number;
  mvps: number;
  avg_score: number;
  avg_acc: number | null;
  best: { beatmap_id: number; score: number; match_id: number | null } | null;
}
export interface MapStat {
  beatmap_id: number;
  plays: number;
  best_player: { name: string; user_id: number | null; score: number; acc: number | null; mods: string[]; match_id: number | null } | null;
  best_team: { team: string; score: number; match_id: number | null } | null;
  avg_score: number | null;
  avg_acc: number | null;
  avg_team_score: number | null;
}
export interface StatsResult {
  generated_at: string;
  settings: StatsSettings;
  method_label: string;
  aggregate_label: string;
  maps: StatMap[];
  has_roster: boolean;
  teams: TeamRow[];
  players: PlayerRow[];
  team_leaderboards: TeamLeaderboardEntry[][]; // per map
  player_leaderboards: PlayerLeaderboardEntry[][]; // per map
  performance: PerformanceRow[];
  mappool: MapStat[];
  lobbies_used: number;
  notes: string[];
}

// ---- math ------------------------------------------------------------------

/** Standard normal CDF via erf (Abramowitz–Stegun 7.1.26, |err| < 1.5e-7). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
function sampleStdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1));
}
/** RANK(): 1 + number of strictly greater values (ties share). */
function competitionRank(x: number, all: number[]): number {
  let n = 1;
  for (const v of all) if (v > x) n++;
  return n;
}

/** Method value for each entry of `scores` (one column of the pivot: every team/player on one map). */
function methodValues(scores: number[], method: StatsMethod, nMaps: number): { values: number[]; ranks: number[] } {
  const ranks = scores.map((s) => competitionRank(s, scores));
  const max = Math.max(0, ...scores);
  const min = Math.min(...scores);
  let values: number[];
  switch (method) {
    case "placements":
      values = ranks;
      break;
    case "maxpct":
      values = scores.map((s) => (max > 0 ? s / max : 0));
      break;
    case "pctdiff":
      values = scores.map((s) => (max > 0 ? Math.max(0, s - min) / max : 0));
      break;
    case "zsum": {
      const m = mean(scores);
      const sd = sampleStdev(scores);
      values = scores.map((s) => (sd > 0 ? normCdf((s - m) / sd) : 0.5));
      break;
    }
    case "zipf":
      values = ranks.map((r) => 100 / (r + nMaps * 1.4));
      break;
  }
  return { values, ranks };
}
const aggregate = (values: number[], method: StatsMethod, nMaps: number) =>
  method === "zsum" ? values.reduce((a, b) => a + b, 0) : nMaps ? values.reduce((a, b) => a + b, 0) / nMaps : 0;

// ---- core ------------------------------------------------------------------

interface BestScore {
  score: number;
  acc: number | null;
  mods: string[];
  passed: boolean;
  match_id: number;
}

export function computeStats(input: { pool: number[]; hits: Hit[]; roster: Roster | null; settings: StatsSettings }): StatsResult {
  const { pool, hits, roster } = input;
  const settings = sanitizeStatsSettings(input.settings);
  const nMaps = pool.length;
  const poolSet = new Set(pool);
  const notes: string[] = [];
  const methodMeta = STATS_METHODS.find((m) => m.id === settings.method)!;

  // -- names + roster resolution (same rules as the Teams grid) --
  const nameToId = new Map<string, number>();
  const idToName = new Map<number, string>();
  const mapMeta = new Map<number, { title: string | null; version: string | null }>();
  for (const h of hits) {
    for (const p of h.players ?? []) {
      const key = normalizeName(p.username);
      if (!nameToId.has(key)) nameToId.set(key, p.user_id);
      if (!idToName.has(p.user_id)) idToName.set(p.user_id, p.username);
    }
    for (const g of h.games) if (poolSet.has(g.beatmap_id) && !mapMeta.has(g.beatmap_id)) mapMeta.set(g.beatmap_id, { title: g.title, version: g.version });
  }
  const teamOf = new Map<number, string>(); // user_id -> team
  const rosterNameOf = new Map<number, string>(); // user_id -> roster display name
  const teamNames: string[] = [];
  const unresolved: string[] = [];
  if (roster) {
    for (const t of roster.teams) {
      teamNames.push(t.name);
      for (const p of t.players) {
        const uid = p.user_id ?? nameToId.get(normalizeName(p.name)) ?? null;
        if (uid === null) {
          unresolved.push(p.name);
          continue;
        }
        if (!teamOf.has(uid)) {
          teamOf.set(uid, t.name);
          rosterNameOf.set(uid, p.name);
        }
      }
    }
  }
  const hasRoster = !!roster && roster.teams.length > 0;
  if (unresolved.length) notes.push(`${unresolved.length} roster player(s) have not appeared in any logged lobby yet and are excluded (${unresolved.slice(0, 5).join(", ")}${unresolved.length > 5 ? "…" : ""}).`);
  const displayName = (uid: number) => rosterNameOf.get(uid) ?? idToName.get(uid) ?? `user ${uid}`;

  // -- best score per player per map (across lobbies), honoring count_failed; population = rostered players (or everyone) --
  const best = new Map<number, Map<number, BestScore>>(); // user_id -> beatmap_id -> best
  const inScope = (uid: number) => !hasRoster || teamOf.has(uid);
  for (const h of hits) {
    for (const g of h.games) {
      if (!poolSet.has(g.beatmap_id)) continue;
      for (const s of g.scores ?? []) {
        if (!settings.count_failed && !s.passed) continue;
        if (!inScope(s.user_id)) continue;
        let byMap = best.get(s.user_id);
        if (!byMap) best.set(s.user_id, (byMap = new Map()));
        const cur = byMap.get(g.beatmap_id);
        if (!cur || s.score > cur.score) byMap.set(g.beatmap_id, { score: s.score, acc: s.accuracy ?? null, mods: s.mods ?? [], passed: s.passed, match_id: h.match_id });
      }
    }
  }
  if (!hasRoster) notes.push("No roster synced — every player who posted a score is ranked individually; team tables need a roster.");

  const playerIds = [...best.keys()];
  const maps: StatMap[] = pool.map((bid) => ({ beatmap_id: bid, title: mapMeta.get(bid)?.title ?? null, version: mapMeta.get(bid)?.version ?? null, url: `https://osu.ppy.sh/b/${bid}` }));

  // -- team score per map --
  const teamMembers = new Map<string, number[]>();
  for (const [uid, team] of teamOf) {
    if (!best.has(uid)) continue; // only players with at least one score
    if (!teamMembers.has(team)) teamMembers.set(team, []);
    teamMembers.get(team)!.push(uid);
  }
  const teamList = teamNames.filter((t) => teamMembers.has(t)); // teams with at least one scoring member
  const teamScore = new Map<string, { score: number; match_id: number | null; contributors: { uid: number; b: BestScore }[] }[]>(); // team -> per map
  for (const team of teamList) {
    const per: { score: number; match_id: number | null; contributors: { uid: number; b: BestScore }[] }[] = [];
    for (const bid of pool) {
      const contribs = (teamMembers.get(team) ?? [])
        .map((uid) => ({ uid, b: best.get(uid)?.get(bid) }))
        .filter((c): c is { uid: number; b: BestScore } => !!c.b)
        .sort((a, b) => b.b.score - a.b.score);
      const used = settings.players_per_map > 0 ? contribs.slice(0, settings.players_per_map) : contribs;
      const score = used.reduce((n, c) => n + c.b.score, 0);
      per.push({ score, match_id: used[0]?.b.match_id ?? null, contributors: used });
    }
    teamScore.set(team, per);
  }

  // -- placements / method values, per map, over the population --
  const teamRows: TeamRow[] = teamList.map((team) => ({ rank: 0, name: team, aggregate: 0, avg_score: 0, maps_played: 0, cells: [] }));
  for (let mi = 0; mi < pool.length; mi++) {
    const col = teamList.map((t) => teamScore.get(t)![mi]!.score);
    const { values, ranks } = methodValues(col, settings.method, nMaps);
    teamList.forEach((t, i) => {
      const s = teamScore.get(t)![mi]!;
      teamRows[i]!.cells.push({ score: s.score, placement: s.score > 0 ? ranks[i]! : null, value: values[i]!, match_id: s.match_id });
    });
  }
  for (const r of teamRows) {
    r.aggregate = aggregate(r.cells.map((c) => c.value), settings.method, nMaps);
    r.maps_played = r.cells.filter((c) => c.score > 0).length;
    r.avg_score = nMaps ? r.cells.reduce((n, c) => n + c.score, 0) / nMaps : 0;
  }
  sortRows(teamRows, methodMeta.sort);

  const playerRows: PlayerRow[] = playerIds.map((uid) => ({
    rank: 0,
    name: displayName(uid),
    user_id: uid,
    team: teamOf.get(uid) ?? null,
    aggregate: 0,
    avg_score: 0,
    avg_acc: null,
    maps_played: 0,
    cells: [],
  }));
  for (let mi = 0; mi < pool.length; mi++) {
    const bid = pool[mi]!;
    const col = playerIds.map((uid) => best.get(uid)!.get(bid)?.score ?? 0);
    const { values, ranks } = methodValues(col, settings.method, nMaps);
    playerIds.forEach((uid, i) => {
      const b = best.get(uid)!.get(bid);
      playerRows[i]!.cells.push({
        score: b?.score ?? 0,
        placement: b ? ranks[i]! : null,
        value: values[i]!,
        acc: b?.acc ?? null,
        mods: b?.mods ?? [],
        match_id: b?.match_id ?? null,
        passed: b?.passed ?? true,
      });
    });
  }
  for (const r of playerRows) {
    r.aggregate = aggregate(r.cells.map((c) => c.value), settings.method, nMaps);
    const played = r.cells.filter((c) => c.score > 0);
    r.maps_played = played.length;
    r.avg_score = played.length ? played.reduce((n, c) => n + c.score, 0) / played.length : 0;
    const accs = played.map((c) => c.acc).filter((a): a is number => typeof a === "number");
    r.avg_acc = accs.length ? mean(accs) : null;
  }
  sortRows(playerRows, methodMeta.sort);

  // -- per-map leaderboards --
  const teamLeaderboards: TeamLeaderboardEntry[][] = pool.map((_, mi) => {
    const entries = teamList
      .map((t) => {
        const s = teamScore.get(t)![mi]!;
        return {
          rank: 0,
          team: t,
          team_score: s.score,
          match_id: s.match_id,
          players: s.contributors.map((c) => ({ name: displayName(c.uid), user_id: c.uid, score: c.b.score, acc: c.b.acc, mods: c.b.mods, passed: c.b.passed })),
        };
      })
      .filter((e) => e.team_score > 0)
      .sort((a, b) => b.team_score - a.team_score);
    entries.forEach((e, i) => (e.rank = i + 1));
    return entries;
  });
  const playerLeaderboards: PlayerLeaderboardEntry[][] = pool.map((bid) => {
    const entries = playerIds
      .map((uid) => ({ uid, b: best.get(uid)!.get(bid) }))
      .filter((x): x is { uid: number; b: BestScore } => !!x.b)
      .sort((a, b) => b.b.score - a.b.score)
      .map((x, i) => ({
        rank: i + 1,
        name: displayName(x.uid),
        user_id: x.uid,
        team: teamOf.get(x.uid) ?? null,
        score: x.b.score,
        acc: x.b.acc,
        mods: x.b.mods,
        passed: x.b.passed,
        match_id: x.b.match_id,
      }));
    return entries;
  });

  // -- match cost: per lobby 2/(n+2) · Σ score / FIELD average of the map (all lobbies); MVP = top in the lobby --
  const fieldSum = new Map<number, { sum: number; n: number }>();
  for (const h of hits) {
    for (const g of h.games) {
      if (!poolSet.has(g.beatmap_id)) continue;
      for (const s of g.scores ?? []) {
        if (!inScope(s.user_id) || !(settings.count_failed || s.passed)) continue; // zero-score rows count, as in the sheet
        const f = fieldSum.get(g.beatmap_id) ?? { sum: 0, n: 0 };
        f.sum += s.score;
        f.n += 1;
        fieldSum.set(g.beatmap_id, f);
      }
    }
  }
  const fieldAvg = (bid: number) => {
    const f = fieldSum.get(bid);
    return f && f.n ? f.sum / f.n : 0;
  };
  const mcAcc = new Map<number, { costs: number[]; mvps: number }>();
  for (const h of hits) {
    const perPlayer = new Map<number, { ratioSum: number; played: number; mvps: number }>();
    for (const g of h.games) {
      if (!poolSet.has(g.beatmap_id)) continue;
      const scores = (g.scores ?? []).filter((s) => inScope(s.user_id) && (settings.count_failed || s.passed));
      if (scores.length === 0) continue;
      const avg = fieldAvg(g.beatmap_id);
      const top = Math.max(...scores.map((s) => s.score));
      for (const s of scores) {
        const e = perPlayer.get(s.user_id) ?? { ratioSum: 0, played: 0, mvps: 0 };
        const numer = settings.mc_mod_scaling ? s.score / modMultiplier(s.mods ?? []) : s.score;
        e.ratioSum += avg > 0 ? numer / avg : 0;
        e.played += 1;
        if (s.score === top) e.mvps += 1;
        perPlayer.set(s.user_id, e);
      }
    }
    for (const [uid, e] of perPlayer) {
      const cost = (2 / (e.played + 2)) * e.ratioSum;
      const acc = mcAcc.get(uid) ?? { costs: [], mvps: 0 };
      acc.costs.push(cost);
      acc.mvps += e.mvps;
      mcAcc.set(uid, acc);
    }
  }
  const performance: PerformanceRow[] = playerIds.map((uid) => {
    const row = playerRows.find((r) => r.user_id === uid)!;
    const m = mcAcc.get(uid) ?? { costs: [], mvps: 0 };
    let bestCell: { beatmap_id: number; score: number; match_id: number | null } | null = null;
    row.cells.forEach((c, i) => {
      if (c.score > 0 && (!bestCell || c.score > bestCell.score)) bestCell = { beatmap_id: pool[i]!, score: c.score, match_id: c.match_id ?? null };
    });
    return {
      rank: 0,
      name: row.name,
      user_id: uid,
      team: row.team,
      match_cost: m.costs.length ? mean(m.costs) : 0,
      lobbies: m.costs.length,
      played: row.maps_played,
      played_pct: nMaps ? row.maps_played / nMaps : 0,
      mvps: m.mvps,
      avg_score: row.avg_score,
      avg_acc: row.avg_acc,
      best: bestCell,
    };
  });
  performance.sort((a, b) => b.match_cost - a.match_cost || b.avg_score - a.avg_score);
  performance.forEach((p, i) => (p.rank = i + 1));

  // -- mappool stats --
  const mappool: MapStat[] = pool.map((bid, mi) => {
    const plays = playerIds.map((uid) => best.get(uid)!.get(bid)).filter((b): b is BestScore => !!b);
    const bp = playerLeaderboards[mi]![0];
    const bt = teamLeaderboards[mi]![0];
    const accs = plays.map((b) => b.acc).filter((a): a is number => typeof a === "number");
    const teamScores = teamList.map((t) => teamScore.get(t)![mi]!.score).filter((s) => s > 0);
    return {
      beatmap_id: bid,
      plays: plays.length,
      best_player: bp ? { name: bp.name, user_id: bp.user_id, score: bp.score, acc: bp.acc, mods: bp.mods, match_id: bp.match_id } : null,
      best_team: bt ? { team: bt.team, score: bt.team_score, match_id: bt.match_id } : null,
      avg_score: plays.length ? mean(plays.map((b) => b.score)) : null,
      avg_acc: accs.length ? mean(accs) : null,
      avg_team_score: teamScores.length ? mean(teamScores) : null,
    };
  });

  return {
    generated_at: new Date().toISOString(),
    settings,
    method_label: methodMeta.label,
    aggregate_label: methodMeta.agg,
    maps,
    has_roster: hasRoster,
    teams: teamRows,
    players: playerRows,
    team_leaderboards: teamLeaderboards,
    player_leaderboards: playerLeaderboards,
    performance,
    mappool,
    lobbies_used: hits.length,
    notes,
  };
}

function sortRows<T extends { aggregate: number; avg_score: number; rank: number }>(rows: T[], dir: "asc" | "desc"): void {
  rows.sort((a, b) => (dir === "asc" ? a.aggregate - b.aggregate : b.aggregate - a.aggregate) || b.avg_score - a.avg_score);
  rows.forEach((r, i) => (r.rank = i + 1));
}
