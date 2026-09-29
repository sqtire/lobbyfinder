/**
 * Final placements for a points-based 1v1 tournament.
 *
 *   primary sort   points from the sheet (1 per win, forfeit wins included)
 *   tiebreak       "ZAdj" — an adjusted average of per-map performance:
 *
 *     adj_i = score_i × m_tier          m = lower_multiplier (0.95) on a lower-tier difficulty, 1 on the upper
 *     z_i   = (adj_i − μ_map) / σ_map   over every counted play of that "map" — the pool slot with
 *                                       all its tiers pooled (rating_scope "slot", the AEROLS rule), or
 *                                       each difficulty on its own ("difficulty": the multiplier cancels)
 *     v_i   = Φ(z_i)  (value_mode "phi", the Z-Sum convention)  or  z_i ("z")
 *     ZAdj  = (Σ v_i + k·neutral) / (n + k)   neutral = 0.5 for Φ, 0 for z
 *
 *   Z-Sum (Σ Φ(z)) rewards playing more maps, which punishes sweeps and
 *   forfeit wins; a plain average makes a 3-map sample outrank a 30-map one.
 *   ZAdj is the plain average pulled toward "average" (neutral) by k phantom
 *   plays: with k = 2, a 5-map player at 0.80 scores (4.0+1)/7 = 0.714 and a
 *   30-map player at 0.75 scores (22.5+1)/32 = 0.734. k = 0 is the plain average.
 *
 * Which lobby games count (in lobby order):
 *   1. not manually excluded, completed (not aborted)
 *   2. the map (item, or either player's own difficulty — freestyle) is in the pool
 *   3. BOTH scheduled players posted a score (drops warmups / for-fun solo plays)
 *   4. optionally drops failed scores
 *   5. only the first (red score + blue score) such games count — the sheet's
 *      result decides how many maps the match really had, so anything after
 *      the deciding map is "for fun". A map labelled TB counts only as the
 *      deciding game of a (ft, ft−1) match, i.e. when the score was (ft−1)-(ft−1).
 *   Forfeit matches: the lobby's valid games count (forfeit_lobby_maps) or not.
 *
 * Map wins ("raw") compare the two raw scores; with tiered/freestyle pools that
 * is not the referee's converted comparison, so they're shown but never sorted on.
 */

import { normCdf } from "@/lib/stats";
import { normalizeName } from "@/lib/rosterParse";
import { describeMultipliers, parseMultipliers, scoreMultiplier } from "./multipliers";
import { poolForStage } from "./pool";
import type {
  BeatmapMeta,
  BestScore,
  GridCell,
  LeaderboardEntry,
  MapStatRow,
  MatchGame,
  MatchResult,
  PlacementRow,
  PlacementsResult,
  PlacementsSettings,
  PlayerPlay,
  PlayerRef,
  PoolMap,
  RoomData,
  RoomRef,
  RoomScore,
  ScheduleRow,
  StageResult,
} from "./types";

export const roomKey = (r: RoomRef) => `${r.kind}:${r.id}`;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function sampleStdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1));
}
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
const fmtScore = (a: number, b: number) => `${a}–${b}`;

export function mapTitle(meta: BeatmapMeta | undefined, id: number): string {
  if (!meta || (!meta.title && !meta.version)) return `#${id}`;
  const base = meta.artist && meta.title ? `${meta.artist} - ${meta.title}` : meta.title ?? `#${id}`;
  return meta.version ? `${base} [${meta.version}]` : base;
}

export interface EngineInput {
  settings: PlacementsSettings;
  schedule: ScheduleRow[];
  pool: PoolMap[];
  rooms: Map<string, RoomData>;
  roomErrors: Map<string, string>;
  beatmaps: Map<number, BeatmapMeta>;
}

export function computePlacements(input: EngineInput): PlacementsResult {
  const { settings, pool, rooms, roomErrors } = input;
  const notes: string[] = [];
  const multParse = parseMultipliers(settings.multipliers_text ?? "", [...new Set(pool.map((m) => m.label))]);
  const scoreRules = multParse.rules;
  notes.push(...multParse.warnings);
  {
    const known = new Set(input.schedule.map((r) => r.stage.trim().toLowerCase()));
    for (const r of scoreRules)
      if (r.stage && !known.has(r.stage.trim().toLowerCase())) notes.push(`Multipliers line ${r.line}: "${r.stage}" isn't a stage in the schedule, so that rule never applies.`);
  }

  // -- stage filter (keep sheet order) --
  const wanted = settings.stages.length ? new Set(settings.stages.map((s) => s.trim().toLowerCase())) : null;
  const rowsAll = input.schedule.filter((r) => !wanted || wanted.has(r.stage.trim().toLowerCase()));
  const stages: string[] = [];
  for (const r of rowsAll) if (!stages.includes(r.stage)) stages.push(r.stage);
  const rows = rowsAll.filter((r) => r.outcome !== "unplayed" || r.rooms.length > 0);
  const skippedUnplayed = rowsAll.length - rows.length;
  if (skippedUnplayed) notes.push(`${skippedUnplayed} scheduled match(es) have no score and no lobby yet and were skipped.`);

  // -- beatmap metadata: pool ids from lobbies first, then the lookup --
  const meta = new Map<number, BeatmapMeta>(input.beatmaps);
  for (const room of rooms.values()) for (const m of Object.values(room.beatmaps)) if (!meta.has(m.id)) meta.set(m.id, m);

  // -- player resolution: sheet name -> osu! user (by username, else by lobby activity) --
  const nameToUser = new Map<string, number>();
  const userName = new Map<number, string>();
  for (const room of rooms.values()) for (const u of Object.values(room.users)) userName.set(u.id, u.username);
  const activityNotes: string[] = [];
  // profile links on the sheet's name cells are exact ids — take them first
  for (const r of rows) {
    if (r.red_id) nameToUser.set(normalizeName(r.red), r.red_id);
    if (r.blue_id) nameToUser.set(normalizeName(r.blue), r.blue_id);
  }
  for (const r of rows) {
    const rowRooms = r.rooms.map((ref) => rooms.get(roomKey(ref))).filter((x): x is RoomData => !!x);
    if (!rowRooms.length) continue;
    const users = new Map<number, string>();
    const scoreCount = new Map<number, number>();
    for (const room of rowRooms) {
      for (const u of Object.values(room.users)) users.set(u.id, u.username);
      for (const gm of room.games) for (const s of gm.scores) scoreCount.set(s.user_id, (scoreCount.get(s.user_id) ?? 0) + 1);
    }
    const byName = new Map<string, number>();
    for (const [id, name] of users) byName.set(normalizeName(name), id);
    const names = [r.red, r.blue];
    const resolved: (number | null)[] = [r.red_id, r.blue_id].map((id, i) => id ?? nameToUser.get(normalizeName(names[i]!)) ?? byName.get(normalizeName(names[i]!)) ?? null);
    names.forEach((name, i) => {
      if (resolved[i] !== null) nameToUser.set(normalizeName(name), resolved[i]!);
    });
    const bothUnknown = resolved[0] === null && resolved[1] === null;
    // In a 1v1 the two people who posted scores are the two players: whoever is
    // left after username matching gets the remaining (most active) scorer.
    const scorers = [...scoreCount.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    names.forEach((name, i) => {
      if (resolved[i] !== null) return;
      const pick = scorers.find((id) => id !== resolved[1 - i]);
      if (pick === undefined) return;
      resolved[i] = pick;
      const previous = [...nameToUser.entries()].find(([, id]) => id === pick)?.[0];
      nameToUser.set(normalizeName(name), pick);
      const uname = users.get(pick) ?? `user ${pick}`;
      activityNotes.push(
        bothUnknown
          ? `Match ${r.match_id}: neither "${r.red}" nor "${r.blue}" matches a lobby username — assigned by activity (${uname} → "${name}"); check this one.`
          : previous && previous !== normalizeName(name)
            ? `"${name}" (match ${r.match_id}) is ${uname}, who is also listed as "${previous}" — treated as one player.`
            : `"${name}" (match ${r.match_id}) matched to ${uname} by lobby activity — the sheet name differs from the osu! username.`
      );
    });
  }
  notes.push(...[...new Set(activityNotes)]);

  const players = new Map<string, PlayerRef>();
  const refFor = (sheetName: string): PlayerRef => {
    const uid = nameToUser.get(normalizeName(sheetName)) ?? null;
    const key = uid !== null ? `u:${uid}` : `n:${normalizeName(sheetName)}`;
    let p = players.get(key);
    if (!p) {
      p = { key, user_id: uid, name: uid !== null ? userName.get(uid) ?? sheetName : sheetName };
      players.set(key, p);
    }
    return p;
  };

  // -- walk every match --
  const matches: MatchResult[] = [];
  const plays: PlayerPlay[] = [];
  const excludedItems = new Set(settings.excluded_items);
  let gamesCounted = 0;
  let gamesExcluded = 0;
  let roomsUsed = 0;

  for (const r of rows) {
    const red = refFor(r.red);
    const blue = refFor(r.blue);
    const stagePool = poolForStage(pool, r.stage);
    const mnotes: string[] = [];
    const points: [number, number] = r.outcome === "red" ? [1, 0] : r.outcome === "blue" ? [0, 1] : [0, 0];
    if (r.outcome === "tie") mnotes.push("Sheet score is a tie — no point awarded.");

    const roomInfos = r.rooms.map((ref) => {
      const data = rooms.get(roomKey(ref));
      return { ref, ok: !!data, error: data ? null : roomErrors.get(roomKey(ref)) ?? "not fetched", name: data?.name ?? null, data };
    });
    const okRooms = roomInfos
      .filter((x) => x.data)
      .sort((a, b) => (a.data!.started_at && b.data!.started_at ? Date.parse(a.data!.started_at) - Date.parse(b.data!.started_at) : 0));
    roomsUsed += okRooms.length;
    for (const x of roomInfos) if (!x.ok) mnotes.push(`Lobby ${x.ref.url} could not be read: ${x.error}.`);
    if (!okRooms.length && r.outcome !== "unplayed" && !r.forfeit) mnotes.push("No readable lobby — the result counts for points only.");

    const sheetScore: [number, number] | null = r.red_score !== null && r.blue_score !== null && r.red_score >= 0 && r.blue_score >= 0 ? [r.red_score, r.blue_score] : null;
    const limit = sheetScore ? sheetScore[0] + sheetScore[1] : r.forfeit ? (settings.forfeit_lobby_maps ? Infinity : 0) : 0;
    const ft = r.first_to ?? (sheetScore ? Math.max(sheetScore[0], sheetScore[1]) : null);
    const decidingIsTb = !!ft && !!sheetScore && Math.max(...sheetScore) === ft && Math.min(...sheetScore) === ft - 1;

    const games: MatchGame[] = [];
    let counted = 0;
    let raw: [number, number] = [0, 0];
    let order = 0;
    for (const { ref, data } of okRooms) {
      for (const gm of data!.games) {
        order++;
        const rs = red.user_id !== null ? gm.scores.find((s) => s.user_id === red.user_id) ?? null : null;
        const bs = blue.user_id !== null ? gm.scores.find((s) => s.user_id === blue.user_id) ?? null : null;
        const candidates = [gm.beatmap_id, rs?.beatmap_id, bs?.beatmap_id].filter((x): x is number => typeof x === "number");
        const poolEntry = candidates.map((id) => stagePool.get(id)).find((x) => !!x) ?? null;
        // normalized score: raw × the score multiplier for the difficulty the player actually played (+ their mods)
        const norm = (s: RoomScore | null) => {
          if (!s) return null;
          const own = stagePool.get(s.beatmap_id) ?? poolEntry;
          const f = own ? scoreMultiplier(scoreRules, r.stage, own.label, own.tier, s.mods) : 1;
          return { own, f, score: s.score * f };
        };
        const rn = norm(rs);
        const bn = norm(bs);
        const base: MatchGame = {
          room_id: ref.id,
          room_kind: ref.kind,
          item_id: gm.item_id,
          order,
          beatmap_id: gm.beatmap_id,
          label: poolEntry?.label ?? null,
          red: rs,
          blue: bs,
          red_norm: rn ? rn.score : null,
          blue_norm: bn ? bn.score : null,
          raw_winner: rn && bn ? (rn.score > bn.score ? "red" : bn.score > rn.score ? "blue" : "tie") : null,
          status: "excluded",
          reason: null,
          score_after: null,
        };
        const exclude = (reason: string) => {
          games.push({ ...base, reason });
          gamesExcluded++;
        };
        if (excludedItems.has(gm.item_id)) {
          exclude("excluded manually");
          continue;
        }
        if (gm.aborted || !gm.completed) {
          exclude("aborted / never completed");
          continue;
        }
        if (!poolEntry) {
          exclude("not a pool map (warmup?)");
          continue;
        }
        if (!rs || !bs) {
          exclude(!rs && !bs ? "neither player posted a score" : `only ${rs ? red.name : blue.name} posted a score`);
          continue;
        }
        if (!settings.count_failed && (!rs.passed || !bs.passed)) {
          exclude("failed score (count failed scores is off)");
          continue;
        }
        if (limit === 0) {
          exclude(r.forfeit ? "forfeit match — lobby maps not counted (setting)" : "sheet has no score for this match");
          continue;
        }
        if (counted >= limit) {
          exclude(`played after the match was decided (${fmtScore(sheetScore![0], sheetScore![1])}) — for fun`);
          continue;
        }
        if (poolEntry.is_tb) {
          const isDeciding = Number.isFinite(limit) && counted === limit - 1;
          if (!decidingIsTb || !isDeciding) {
            exclude(ft ? `tiebreaker played when the score was not ${ft - 1}–${ft - 1}` : "tiebreaker played before the deciding game");
            continue;
          }
        }
        counted++;
        gamesCounted++;
        if (base.raw_winner === "red") raw = [raw[0] + 1, raw[1]];
        else if (base.raw_winner === "blue") raw = [raw[0], raw[1] + 1];
        games.push({ ...base, status: "counted", score_after: [raw[0], raw[1]] });
        const mk = (me: PlayerRef, opp: PlayerRef, s: RoomScore, won: boolean | null): PlayerPlay => {
          const own = stagePool.get(s.beatmap_id) ?? poolEntry;
          const multiplier = own.tier > 0 ? settings.lower_multiplier : 1;
          const f = scoreMultiplier(scoreRules, r.stage, own.label, own.tier, s.mods);
          const normalized = s.score * f;
          return {
            player_key: me.key,
            beatmap_id: own.beatmap_id,
            label: own.label,
            map_key: own.slot,
            tier: own.tier,
            multiplier,
            adjusted: normalized * multiplier,
            score: normalized,
            raw_score: s.score,
            score_multiplier: f,
            accuracy: s.accuracy,
            max_combo: s.max_combo,
            mods: s.mods,
            passed: s.passed,
            match_id: r.match_id,
            stage: r.stage,
            opponent_key: opp.key,
            room_id: ref.id,
            room_kind: ref.kind,
            item_id: gm.item_id,
            won,
            rated: false,
            z: null,
            phi: null,
          };
        };
        plays.push(mk(red, blue, rs, base.raw_winner === "tie" ? null : base.raw_winner === "red"));
        plays.push(mk(blue, red, bs, base.raw_winner === "tie" ? null : base.raw_winner === "blue"));
      }
    }
    if (Number.isFinite(limit) && limit > 0 && counted < limit) {
      mnotes.push(`Sheet says ${fmtScore(sheetScore![0], sheetScore![1])} (${limit} maps) but only ${counted} pool map(s) with both players were found in the lobby.`);
    }
    if (r.forfeit && counted > 0) mnotes.push(`Forfeit result; ${counted} map(s) played before it were counted.`);

    matches.push({
      match_id: r.match_id,
      stage: r.stage,
      date: r.date,
      first_to: r.first_to,
      red,
      blue,
      sheet_score: sheetScore,
      outcome: r.outcome,
      forfeit: r.forfeit,
      points,
      rooms: roomInfos.map(({ ref, ok, error, name }) => ({ ref, ok, error, name })),
      games,
      counted,
      lobby_score: counted ? raw : null,
      notes: mnotes,
    });
  }

  // -- slots in pool order (every tier of a slot pooled) --
  const poolMapsInScope = pool.filter((m) => m.stage === null || stages.some((s) => s.trim().toLowerCase() === m.stage!.trim().toLowerCase()));
  const slots = new Map<string, PoolMap[]>();
  for (const m of poolMapsInScope) {
    if (!slots.has(m.slot)) slots.set(m.slot, []);
    slots.get(m.slot)!.push(m);
  }
  const lowerMult = settings.lower_multiplier;
  const hasTiers = poolMapsInScope.some((m) => m.tier > 0);
  if (hasTiers) {
    for (const [, ms] of slots) {
      const upper = ms.find((m) => m.tier === 0);
      const upperSr = upper ? meta.get(upper.beatmap_id)?.difficulty_rating ?? null : null;
      for (const m of ms) {
        if (m.tier === 0) continue;
        const sr = meta.get(m.beatmap_id)?.difficulty_rating ?? null;
        if (upper && upperSr !== null && sr !== null && sr > upperSr + 0.05) {
          notes.push(
            `${m.label}: #${m.beatmap_id} (${sr.toFixed(2)}★) is listed as the lower tier but is rated harder than the first id #${upper.beatmap_id} (${upperSr.toFixed(2)}★) — the first id on a pool line is the upper difficulty; swap them if this is wrong.`
          );
        }
      }
    }
  }

  // -- tiebreak distributions over counted plays (ADJUSTED scores; visible stats below are raw) --
  const bySlot = new Map<string, PlayerPlay[]>();
  for (const p of plays) {
    if (!bySlot.has(p.map_key)) bySlot.set(p.map_key, []);
    bySlot.get(p.map_key)!.push(p);
  }
  const minPlays = Math.max(2, settings.min_plays);
  const slotStats = new Map<string, { mean: number | null; stdev: number | null; rated: boolean }>();
  for (const [key, ps] of bySlot) {
    const adj = ps.map((p) => p.adjusted);
    const m = mean(adj);
    const sd = sampleStdev(adj);
    slotStats.set(key, { mean: m, stdev: sd, rated: ps.length >= minPlays && sd !== null && sd > 0 });
  }
  for (const p of plays) {
    const st = slotStats.get(p.map_key)!;
    if (st.rated) {
      p.rated = true;
      p.z = (p.adjusted - st.mean!) / st.stdev!;
      p.phi = normCdf(p.z);
    }
  }
  const unrated = [...bySlot.entries()].filter(([key]) => !slotStats.get(key)!.rated);
  if (unrated.length) {
    notes.push(`${unrated.length} slot(s) have fewer than ${minPlays} counted plays (or no spread) and don't count toward the tiebreak: ${unrated.map(([, ps]) => `${ps[0]!.label} (${ps.length})`).join(", ")}.`);
  }

  // -- best play per (slot, player): raw for everything visible, adjusted for the tiebreak --
  interface Best {
    raw: PlayerPlay;
    adj: PlayerPlay;
    plays: PlayerPlay[];
  }
  const bestBy = new Map<string, Map<string, Best>>(); // slot -> player -> best
  for (const p of plays) {
    if (!bestBy.has(p.map_key)) bestBy.set(p.map_key, new Map());
    const m = bestBy.get(p.map_key)!;
    const cur = m.get(p.player_key);
    if (!cur) m.set(p.player_key, { raw: p, adj: p, plays: [p] });
    else {
      cur.plays.push(p);
      if (p.score > cur.raw.score) cur.raw = p;
      if (p.adjusted > cur.adj.adjusted) cur.adj = p;
    }
  }
  // -- players hidden from rankings (their scores still feed every calculation) --
  const hidden = new Set<string>();
  {
    const unmatched: string[] = [];
    for (const raw of (settings.hidden_players ?? "").split(/[\n,;]+/)) {
      const t = raw.trim();
      if (!t) continue;
      const id = t.match(/osu\.ppy\.sh\/(?:users|u)\/(\d+)/i)?.[1] ?? (/^\d{2,10}$/.test(t) ? t : null);
      let key: string | null = null;
      if (id && players.has(`u:${id}`)) key = `u:${id}`;
      if (!key) {
        const n = normalizeName(t);
        const viaSheet = nameToUser.get(n);
        if (viaSheet !== undefined && players.has(`u:${viaSheet}`)) key = `u:${viaSheet}`;
        else key = [...players.values()].find((p) => normalizeName(p.name) === n)?.key ?? (players.has(`n:${n}`) ? `n:${n}` : null);
      }
      if (key) hidden.add(key);
      else unmatched.push(t);
    }
    if (unmatched.length) notes.push(`Hidden players not found in the schedule: ${unmatched.map((u) => `"${u}"`).join(", ")}.`);
  }
  const rawPlacement = new Map<string, Map<string, number>>(); // slot -> player -> placement among everyone's best score
  const visPlacement = new Map<string, Map<string, number>>(); // same, among ranked (non-hidden) players only
  const adjPlacement = new Map<string, Map<string, number>>();
  for (const [slot, m] of bestBy) {
    const raws = [...m.values()].map((b) => b.raw.score);
    const vis = [...m.entries()].filter(([pk]) => !hidden.has(pk)).map(([, b]) => b.raw.score);
    const adjs = [...m.values()].map((b) => b.adj.adjusted);
    rawPlacement.set(slot, new Map([...m.entries()].map(([pk, b]) => [pk, 1 + raws.filter((s) => s > b.raw.score).length])));
    visPlacement.set(slot, new Map([...m.entries()].filter(([pk]) => !hidden.has(pk)).map(([pk, b]) => [pk, 1 + vis.filter((s) => s > b.raw.score).length])));
    adjPlacement.set(slot, new Map([...m.entries()].map(([pk, b]) => [pk, 1 + adjs.filter((s) => s > b.adj.adjusted).length])));
  }

  // -- tiebreak values --
  const k = Math.max(0, settings.prior_maps);
  const mode = settings.value_mode;
  const valueOfPlay = (p: PlayerPlay) => (mode === "phi" ? p.phi : p.z);
  const zipfValue = (slot: string, pk: string): number | null => (slotStats.get(slot)?.rated ? 1 / adjPlacement.get(slot)!.get(pk)! : null);
  let neutral: number;
  if (mode === "phi") neutral = 0.5;
  else if (mode === "z") neutral = 0;
  else {
    // Zipf: a "phantom average slot" is worth the field's mean 1/placement over every rated slot
    const all: number[] = [];
    for (const [slot, m] of bestBy) for (const pk of m.keys()) {
      const v = zipfValue(slot, pk);
      if (v !== null) all.push(v);
    }
    neutral = mean(all) ?? 0;
  }
  /** Contribution of one slot to a player's tiebreak (per-slot mean of play values, or 1/placement). */
  const slotValue = (slot: string, pk: string, b: Best): number | null => {
    if (mode === "zipf") return zipfValue(slot, pk);
    const vs = b.plays.filter((p) => p.rated).map((p) => valueOfPlay(p)!);
    return vs.length ? mean(vs) : null;
  };
  const tiebreakLabel = mode === "zipf" ? "Zipf placement average" : mode === "phi" ? "Φ(z) average" : "z average";

  // -- per player --
  const rowsByPlayer = new Map<string, PlacementRow>();
  for (const p of players.values()) {
    rowsByPlayer.set(p.key, {
      rank: 0,
      player: p,
      points: 0,
      matches: 0,
      wins: 0,
      losses: 0,
      forfeit_wins: 0,
      forfeit_losses: 0,
      performance: null,
      avg_value: null,
      avg_phi: null,
      avg_z: null,
      rated_plays: 0,
      counted_plays: 0,
      unique_maps: 0,
      map_wins: 0,
      map_losses: 0,
      map_ties: 0,
      buchholz: 0,
      avg_score: null,
      avg_acc: null,
      best: null,
      top_scores: 0,
      avg_placement: null,
      slots_total: slots.size,
      stages: [],
    });
  }
  for (const m of matches) {
    const sides: [PlayerRef, PlayerRef, number, number, "red" | "blue"][] = [
      [m.red, m.blue, m.points[0], m.points[1], "red"],
      [m.blue, m.red, m.points[1], m.points[0], "blue"],
    ];
    for (const [me, opp, myPts, oppPts, side] of sides) {
      const row = rowsByPlayer.get(me.key)!;
      if (m.outcome === "unplayed") continue;
      row.matches++;
      row.points += myPts;
      const ff = m.forfeit;
      let result: StageResult["result"] = "—";
      if (ff === "both") result = "FF";
      else if (ff && ff !== side) {
        result = "FFW";
        row.forfeit_wins++;
      } else if (ff === side) {
        result = "FFL";
        row.forfeit_losses++;
      } else if (m.outcome === "tie") result = "T";
      else if (myPts > oppPts) {
        result = "W";
        row.wins++;
      } else {
        result = "L";
        row.losses++;
      }
      const sc = m.sheet_score;
      const mine = sc ? (side === "red" ? sc[0] : sc[1]) : null;
      const theirs = sc ? (side === "red" ? sc[1] : sc[0]) : null;
      row.stages.push({ stage: m.stage, opponent: opp, result, score: sc ? fmtScore(mine!, theirs!) : ff ? "FF" : "—", match_id: m.match_id });
    }
  }
  // Buchholz needs final points
  for (const m of matches) {
    if (m.outcome === "unplayed") continue;
    rowsByPlayer.get(m.red.key)!.buchholz += rowsByPlayer.get(m.blue.key)!.points;
    rowsByPlayer.get(m.blue.key)!.buchholz += rowsByPlayer.get(m.red.key)!.points;
  }
  const playsByPlayer = new Map<string, PlayerPlay[]>();
  for (const p of plays) {
    if (!playsByPlayer.has(p.player_key)) playsByPlayer.set(p.player_key, []);
    playsByPlayer.get(p.player_key)!.push(p);
  }
  for (const row of rowsByPlayer.values()) {
    const pk = row.player.key;
    const ps = playsByPlayer.get(pk) ?? [];
    row.counted_plays = ps.length;
    const mySlots = [...bestBy.entries()].filter(([, m]) => m.has(pk)).map(([slot]) => slot);
    row.unique_maps = mySlots.length;
    row.map_wins = ps.filter((p) => p.won === true).length;
    row.map_losses = ps.filter((p) => p.won === false).length;
    row.map_ties = ps.filter((p) => p.won === null).length;
    row.avg_score = mean(ps.map((p) => p.score));
    row.avg_acc = mean(ps.map((p) => p.accuracy));
    const best = ps.reduce<PlayerPlay | null>((b, p) => (!b || p.score > b.score ? p : b), null);
    row.best = best ? { beatmap_id: best.beatmap_id, label: best.label, score: best.score, match_id: best.match_id, room_id: best.room_id, room_kind: best.room_kind } : null;
    const placements = mySlots.map((slot) => (hidden.has(pk) ? rawPlacement : visPlacement).get(slot)!.get(pk)!);
    row.top_scores = placements.filter((x) => x === 1).length;
    row.avg_placement = mean(placements);
    const rated = ps.filter((p) => p.rated);
    row.rated_plays = rated.length;
    row.avg_phi = mean(rated.map((p) => p.phi!));
    row.avg_z = mean(rated.map((p) => p.z!));
    let values: number[];
    if (mode === "zipf" || settings.map_weighting === "per_map") {
      values = mySlots.map((slot) => slotValue(slot, pk, bestBy.get(slot)!.get(pk)!)).filter((v): v is number => v !== null);
    } else values = rated.map((p) => valueOfPlay(p)!);
    if (values.length) {
      const sum = values.reduce((a, b) => a + b, 0);
      row.avg_value = sum / values.length;
      row.performance = (sum + k * neutral) / (values.length + k);
    }
  }
  const sortedRows = [...rowsByPlayer.values()].sort(
    (a, b) =>
      b.points - a.points ||
      (b.performance ?? -Infinity) - (a.performance ?? -Infinity) ||
      (b.avg_value ?? -Infinity) - (a.avg_value ?? -Infinity) ||
      a.player.name.localeCompare(b.player.name, undefined, { sensitivity: "base" })
  );
  const placements = sortedRows.filter((r) => !hidden.has(r.player.key));
  const hiddenRows = sortedRows.filter((r) => hidden.has(r.player.key));
  placements.forEach((p, i) => (p.rank = i + 1));
  hiddenRows.forEach((p) => (p.rank = 0));
  if (hiddenRows.length) notes.push(`${hiddenRows.length} player(s) hidden from every ranking; their scores still count toward map averages and everyone else's tiebreak.`);
  const isVisible = (p: PlayerPlay) => !hidden.has(p.player_key);

  // -- slot rows (raw), leaderboards (raw), grid (raw + tiebreak detail) --
  const playerByKey = new Map([...players.values()].map((p) => [p.key, p]));
  const toBest = (p: PlayerPlay): BestScore => ({
    player: playerByKey.get(p.player_key)!,
    score: p.score,
    raw_score: p.raw_score,
    score_multiplier: p.score_multiplier,
    beatmap_id: p.beatmap_id,
    tier: p.tier,
    accuracy: p.accuracy,
    max_combo: p.max_combo,
    mods: p.mods,
    passed: p.passed,
    match_id: p.match_id,
    stage: p.stage,
    room_id: p.room_id,
    room_kind: p.room_kind,
  });
  const bestRaw = (ps: PlayerPlay[]) => ps.reduce<PlayerPlay | null>((b, p) => (!b || p.score > b.score ? p : b), null);
  const maps: MapStatRow[] = [...slots.entries()].map(([key, ms]) => {
    const ps = bySlot.get(key) ?? [];
    const st = slotStats.get(key);
    const upper = ms.find((m) => m.tier === 0) ?? ms[0]!;
    const best = bestRaw(ps.filter(isVisible));
    return {
      key,
      beatmap_id: upper.beatmap_id,
      label: upper.label,
      title: mapTitle(meta.get(upper.beatmap_id), upper.beatmap_id),
      url: `https://osu.ppy.sh/b/${upper.beatmap_id}`,
      beatmaps: ms.map((m) => {
        const dps = ps.filter((p) => p.beatmap_id === m.beatmap_id);
        const db = bestRaw(dps.filter(isVisible));
        return {
          beatmap_id: m.beatmap_id,
          title: mapTitle(meta.get(m.beatmap_id), m.beatmap_id),
          url: `https://osu.ppy.sh/b/${m.beatmap_id}`,
          tier: m.tier,
          multiplier: m.tier > 0 ? lowerMult : 1,
          score_multipliers: describeMultipliers(scoreRules, stages, m.label, m.tier),
          difficulty_rating: meta.get(m.beatmap_id)?.difficulty_rating ?? null,
          plays: dps.length,
          mean: mean(dps.map((p) => p.score)),
          median: median(dps.map((p) => p.score)),
          avg_acc: mean(dps.map((p) => p.accuracy)),
          best: db ? toBest(db) : null,
        };
      }),
      plays: ps.length,
      players: bestBy.get(key)?.size ?? 0,
      mean: mean(ps.map((p) => p.score)),
      median: median(ps.map((p) => p.score)),
      avg_acc: mean(ps.map((p) => p.accuracy)),
      best: best ? toBest(best) : null,
      tiebreak: { rated: st?.rated ?? false, mean_adj: st?.mean ?? null, stdev_adj: st?.stdev ?? null },
    };
  });
  const leaderboards: Record<string, LeaderboardEntry[]> = {};
  for (const m of maps) {
    const ps = [...(bySlot.get(m.key) ?? [])].filter(isVisible).sort((a, b) => b.score - a.score || b.accuracy - a.accuracy);
    const scores = ps.map((p) => p.score);
    leaderboards[m.key] = ps.map((p) => ({
      rank: 1 + scores.filter((s) => s > p.score).length,
      player: playerByKey.get(p.player_key)!,
      score: p.score,
      raw_score: p.raw_score,
      score_multiplier: p.score_multiplier,
      beatmap_id: p.beatmap_id,
      tier: p.tier,
      accuracy: p.accuracy,
      max_combo: p.max_combo,
      mods: p.mods,
      passed: p.passed,
      match_id: p.match_id,
      stage: p.stage,
      room_id: p.room_id,
      room_kind: p.room_kind,
    }));
  }
  const gridCells: Record<string, Record<string, GridCell | null>> = {};
  for (const row of sortedRows) gridCells[row.player.key] = {};
  for (const m of maps) {
    const bests = bestBy.get(m.key) ?? new Map<string, Best>();
    for (const row of sortedRows) {
      const b = bests.get(row.player.key);
      const plc = hidden.has(row.player.key) ? rawPlacement : visPlacement;
      gridCells[row.player.key]![m.key] = b
        ? {
            score: b.raw.score,
            beatmap_id: b.raw.beatmap_id,
            tier: b.raw.tier,
            placement: plc.get(m.key)!.get(row.player.key)!,
            plays: b.plays.length,
            tiebreak: {
              adjusted: b.adj.adjusted,
              placement: adjPlacement.get(m.key)!.get(row.player.key)!,
              value: slotValue(m.key, row.player.key, b),
            },
          }
        : null;
    }
  }

  const unresolved = [...players.values()].filter((p) => p.user_id === null);
  if (unresolved.length) notes.push(`${unresolved.length} player(s) never appeared in a readable lobby and are listed by sheet name: ${unresolved.map((p) => p.name).join(", ")}.`);
  const discrepancies = matches.filter((m) => m.notes.some((n) => n.startsWith("Sheet says")));
  if (discrepancies.length) notes.push(`${discrepancies.length} match(es) have fewer countable lobby maps than the sheet score implies — see the Matches tab.`);

  const { pool_text: _omit, schedule_rows: _rows, ...settingsOut } = settings;
  void _omit;
  void _rows;
  const pooled = hasTiers && lowerMult !== 1 ? `both tiers together, lower-tier scores × ${lowerMult} for this step only — no visible stat uses it` : hasTiers ? "both tiers together, no tier multiplier" : "one difficulty per slot";
  const tiebreakText =
    mode === "zipf"
      ? `Zipf placement average — on each slot every player's best score is ranked (${pooled}) and is worth 1/placement (#1 = 1, #2 = 0.5, #3 = 0.33…); a player's tiebreak is (Σ value + ${k}·${neutral.toFixed(3)}) / (slots played + ${k}), where ${neutral.toFixed(3)} is the field's average value and the ${k} phantom slots keep a 3-slot sample from beating a 20-slot one on luck.`
      : `${tiebreakLabel} — z = (score − slot mean) / slot stdev over every counted play of the slot (${pooled}), value = ${mode === "phi" ? "Φ(z)" : "z"}${settings.map_weighting === "per_map" ? " averaged per slot first" : " per play"}; tiebreak = (Σ value + ${k}·${neutral}) / (n + ${k}).`;
  const normText = scoreRules.length
    ? `Every score is first normalized with ${scoreRules.length} score-multiplier rule(s) (raw × multiplier for the difficulty and mods played); leaderboards, mappool stats, averages, map winners and the tiebreak all use normalized scores.`
    : "No score multipliers set — raw scores are used everywhere.";
  const formula = [
    `Primary sort: points from the referee sheet (1 per win, forfeit wins included).`,
    `Tiebreak: ${tiebreakText}`,
    `Then: unshrunk average value, then name. Slots need ≥ ${minPlays} counted plays (and a non-zero spread) to count toward the tiebreak. Averages, not sums, so playing more maps neither helps nor hurts.`,
    `Counted plays: completed pool maps where both scheduled players posted a score, in lobby order, up to the number of maps the sheet score implies; tiebreakers only as the deciding map of an (ft, ft−1) match${
      settings.count_failed ? "; failed scores count" : "; failed scores are dropped"
    }${settings.forfeit_lobby_maps ? "; maps played before a forfeit count" : "; forfeit lobbies are ignored"}.`,
    normText,
  ];

  return {
    generated_at: new Date().toISOString(),
    title: settings.title || "Final placements",
    settings: settingsOut,
    stages,
    formula,
    placements,
    hidden_placements: hiddenRows,
    maps,
    leaderboards,
    grid: { players: placements.map((p) => p.player), cells: gridCells },
    matches,
    plays,
    notes,
    counts: { matches: matches.length, rooms: roomsUsed, games_counted: gamesCounted, games_excluded: gamesExcluded, players: placements.length, hidden: hiddenRows.length },
    tiebreak_label: tiebreakLabel,
    score_rules: scoreRules,
  };
}
