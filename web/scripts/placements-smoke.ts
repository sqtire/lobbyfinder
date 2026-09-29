/**
 * Offline check of the placements engine (no Redis, no osu! API):
 *   npx tsx scripts/placements-smoke.ts [path/to/chrono.csv]
 *
 * Parses a Chrono Schedule CSV (a synthetic one is generated when no path is
 * given), fabricates a lobby for every match that has an mp link, salts the
 * lobbies with the situations the rules must handle, runs the engine and
 * asserts the outcomes. Writes the workbook to /tmp/placements-smoke.xlsx.
 */

import fs from "fs";
import { computePlacements, roomKey } from "../lib/placements/engine";
import { parsePool } from "../lib/placements/pool";
import { parseSchedule } from "../lib/placements/schedule";
import { placementsWorkbook } from "../lib/placements/workbook";
import { DEFAULT_PLACEMENTS_SETTINGS, type PlacementsSettings, type RoomData, type RoomGame, type RoomScore, type ScheduleRow } from "../lib/placements/types";

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const fail = (msg: string) => {
  console.error("FAIL:", msg);
  process.exitCode = 1;
};
const ok = (msg: string) => console.log("ok  ", msg);

// ---- inputs -----------------------------------------------------------------

const csvPath = process.argv[2];
const csv = csvPath
  ? fs.readFileSync(csvPath, "utf8")
  : [
      ",sheet,,stage,bracket,date,time,referee,red availability,team red,Score,,team blue,blue availability,streamer,comm 1,comm 2,hyperlink,mp link,mp link 2,mp link 3,mp link 4,protects,bans,first to",
      ",1,1,Round 1,Winner,2026-09-04,15:00,ref,,Alpha,4,2,Bravo,,,,,mp link,https://osu.ppy.sh/multiplayer/rooms/1001,,,,,,4",
      ",2,2,Round 1,Winner,2026-09-04,16:00,ref,,Charlie,4,3,Delta,,,,,mp link,https://osu.ppy.sh/multiplayer/rooms/1002,,,,,,4",
      ",3,3,Round 1,Winner,2026-09-04,17:00,ref,,Echo,4,-1,Foxtrot,,,,,,,,,,,,4",
      ",4,4,Round 1,Winner,2026-09-04,18:00,ref,,Golf,1,4,Hotel,,,,,mp link,https://osu.ppy.sh/multiplayer/rooms/1004,,,,,,4",
      ",5,5,Round 2,Winner,2026-09-11,15:00,ref,,Alpha,5,1,Charlie,,,,,mp link,https://osu.ppy.sh/multiplayer/rooms/2001,,,,,,5",
      ",6,6,Round 2,Winner,2026-09-11,16:00,ref,,Bravo,3,5,Hotel,,,,,mp link,https://osu.ppy.sh/multiplayer/rooms/2002,https://osu.ppy.sh/multiplayer/rooms/2003,,,,,5",
      ",7,7,Round 2,Winner,2026-09-11,17:00,ref,,Delta,5,-1,Golf,,,,,mp link,https://osu.ppy.sh/multiplayer/rooms/2004,,,,,,5",
      ",8,8,Round 2,Winner,2026-09-11,18:00,ref,,Echo,,,Foxtrot,,,,,,,,,,,,5",
      ",9,9,Round 3,Winner,2026-09-18,15:00,ref,,Alpha,5,4,Hotel,,,,,mp link,https://osu.ppy.sh/multiplayer/rooms/3001,,,,,,5",
      ",10,10,Round 3,Winner,2026-09-18,16:00,ref,,Bravo,5,0,Delta,,,,,mp link,https://osu.ppy.sh/multiplayer/rooms/3002,,,,,,5",
    ].join("\n");

const schedule = parseSchedule(csv);
console.log(`schedule: ${schedule.rows.length} rows, header row ${schedule.header_row}, warnings: ${schedule.warnings.join("; ") || "none"}`);
const stages = [...new Set(schedule.rows.map((r) => r.stage))];
console.log("stages:", stages.join(", "));

const POOL = `
NM1 100001 100002
NM2 100003 100004
NM3 100005 100006
HD1 100007 100008
HD2 100009 100010
HR1 100011 100012
HR2 100013 100014
DT1 100015 100016
DT2 100017 100018
FM1 100019 100020
TB  100099 100098
`;
const pool = parsePool(POOL);
if (pool.warnings.length) console.log("pool warnings:", pool.warnings);
const slots = pool.maps.filter((m) => !m.is_tb);
const tb = pool.maps.find((m) => m.is_tb)!;

// ---- synthetic lobbies ----------------------------------------------------------

const userIds = new Map<string, number>();
const uidOf = (name: string) => {
  let id = userIds.get(name.toLowerCase());
  if (!id) userIds.set(name.toLowerCase(), (id = 50000 + userIds.size));
  return id;
};
const tierOf = (uid: number) => (uid % 2 === 0 ? 0 : 1); // even ids play T1 (first id of a slot), odd play T2
const skill = new Map<number, number>();
const skillOf = (uid: number) => {
  if (!skill.has(uid)) skill.set(uid, 0.55 + rnd() * 0.4);
  return skill.get(uid)!;
};
const score = (uid: number, mult = 1): RoomScore => ({
  user_id: uid,
  beatmap_id: 0,
  score: Math.round(1_000_000 * skillOf(uid) * (0.85 + rnd() * 0.3) * mult),
  accuracy: 0.9 + rnd() * 0.09,
  max_combo: 500,
  mods: [],
  passed: true,
});
let itemSeq = 900000;
function game(bidRed: number, bidBlue: number, itemBid: number, red: number | null, blue: number | null, opts?: Partial<RoomGame> & { redMult?: number; blueMult?: number }): RoomGame {
  const scores: RoomScore[] = [];
  if (red !== null) scores.push({ ...score(red, opts?.redMult), beatmap_id: bidRed });
  if (blue !== null) scores.push({ ...score(blue, opts?.blueMult), beatmap_id: bidBlue });
  return { item_id: itemSeq++, order: 0, beatmap_id: itemBid, completed: true, aborted: false, started_at: null, ended_at: null, mods: [], freestyle: true, scores, ...opts };
}
/** A pool slot for both players (each on their tier's difficulty). */
function pick(i: number, red: number, blue: number | null, opts?: Parameters<typeof game>[5]) {
  const slot = slots[i % slots.length]!;
  const ids = pool.maps.filter((m) => m.label === slot.label).map((m) => m.beatmap_id);
  const r = ids[tierOf(red)] ?? ids[0]!;
  const b = blue === null ? r : (ids[tierOf(blue)] ?? ids[0]!);
  return game(r, b, r, red, blue, opts);
}

const rooms = new Map<string, RoomData>();
const roomErrors = new Map<string, string>();
const scenario = new Map<string, string>();
let roomsBuilt = 0;
for (const row of schedule.rows) {
  if (!row.rooms.length) continue;
  const red = uidOf(row.red);
  const blue = uidOf(row.blue);
  const rs = row.red_score ?? 0;
  const bs = row.blue_score ?? 0;
  const ft = row.first_to ?? Math.max(rs, bs);
  const games: RoomGame[] = [];
  const n = roomsBuilt++;
  const first = row.rooms[0]!;

  // warmup: a non-pool map for both players
  games.push(game(555555, 555555, 555555, red, blue));
  if (row.forfeit) {
    // forfeit with a lobby: two real maps before the forfeit
    games.push(pick(0, red, blue), pick(1, red, blue));
    scenario.set(row.match_id, "forfeit-with-maps");
  } else if (rs >= 0 && bs >= 0) {
    const total = rs + bs;
    const decidedOnTb = Math.max(rs, bs) === ft && Math.min(rs, bs) === ft - 1;
    // force the raw winners to match the sheet score so lobby_score == sheet_score
    const seq: ("red" | "blue")[] = [];
    let a = 0;
    let b = 0;
    while (a + b < total) {
      const redNext = a < rs && (b >= bs || rnd() < 0.5);
      if (redNext) {
        a++;
        seq.push("red");
      } else {
        b++;
        seq.push("blue");
      }
    }
    seq.forEach((w, i) => {
      const last = i === total - 1;
      const useTb = decidedOnTb && last;
      const mult = { redMult: w === "red" ? 1.8 : 0.6, blueMult: w === "blue" ? 1.8 : 0.6 };
      if (useTb) games.push(game(tb.beatmap_id, tb.beatmap_id, tb.beatmap_id, red, blue, mult));
      else games.push(pick(i + n, red, blue, mult));
    });
    if (n % 3 === 0) {
      games.push(game(555556, 555556, 555556, red, blue)); // random after-match map, not in pool
      games.push(pick(5, red, blue)); // for-fun pool map after the match ended
      scenario.set(row.match_id, "for-fun-after");
    }
    if (n % 5 === 1) {
      games.splice(2, 0, game(tb.beatmap_id, tb.beatmap_id, tb.beatmap_id, red, blue)); // TB at the wrong time
      scenario.set(row.match_id, "early-tb");
    }
    if (n % 7 === 2) {
      games.splice(1, 0, pick(3, red, blue, { completed: false, aborted: true })); // aborted game
      scenario.set(row.match_id, "aborted");
    }
    if (n % 4 === 3) {
      games.splice(1, 0, pick(4, red, null)); // only red played (blue DC'd) — not counted
      scenario.set(row.match_id, "solo-play");
    }
  }
  const users: RoomData["users"] = {};
  for (const [name, id] of [
    [row.red, red],
    [row.blue, blue],
  ] as const) {
    // every 6th lobby the red player renamed since the sheet was filled
    users[String(id)] = { id, username: n % 6 === 0 && id === red ? `${name}_renamed` : name, country_code: "US" };
  }
  users["1"] = { id: 1, username: "referee", country_code: "US" };
  if (n % 6 === 0) scenario.set(row.match_id, (scenario.get(row.match_id) ?? "") + " renamed-red");
  // second lobby of the same match (crash → new room): split the games
  if (row.rooms.length > 1) {
    const half = Math.ceil(games.length / 2);
    rooms.set(roomKey(first), mk(first.id, users, games.slice(0, half), "2026-09-01T10:00:00Z"));
    rooms.set(roomKey(row.rooms[1]!), mk(row.rooms[1]!.id, users, games.slice(half), "2026-09-01T11:00:00Z"));
  } else rooms.set(roomKey(first), mk(first.id, users, games, "2026-09-01T10:00:00Z"));
  if (n % 9 === 8) {
    rooms.delete(roomKey(first));
    roomErrors.set(roomKey(first), "not found (404)");
    scenario.set(row.match_id, "unreadable-lobby");
  }
}
function mk(id: number, users: RoomData["users"], games: RoomGame[], started: string): RoomData {
  games.forEach((g, i) => (g.order = i));
  return { kind: "lazer", id, url: `https://osu.ppy.sh/multiplayer/rooms/${id}`, name: "AEROLS: (x) vs (y)", started_at: started, ended_at: "2026-09-01T12:00:00Z", users, games, beatmaps: {}, fetched_at: new Date().toISOString() };
}

// ---- run ------------------------------------------------------------------------

const settings: PlacementsSettings = {
  ...DEFAULT_PLACEMENTS_SETTINGS,
  title: "Smoke",
  sheet_url: "https://docs.google.com/spreadsheets/d/x",
  pool_text: POOL,
  stages: stages.slice(0, 4),
  value_mode: (["phi", "z", "zipf"].includes(process.env.SMOKE_MODE ?? "") ? process.env.SMOKE_MODE : DEFAULT_PLACEMENTS_SETTINGS.value_mode) as PlacementsSettings["value_mode"],
};
const res = computePlacements({ settings, schedule: schedule.rows, pool: pool.maps, rooms, roomErrors, beatmaps: new Map() });

console.log(`\ncounts: ${JSON.stringify(res.counts)}`);
console.log("notes:\n  " + res.notes.join("\n  "));
console.log("\ntop 8:");
for (const p of res.placements.slice(0, 8)) {
  console.log(
    `  ${String(p.rank).padStart(2)} ${p.player.name.padEnd(20)} pts=${p.points} ZAdj=${p.performance?.toFixed(4) ?? "—"} avgΦ=${p.avg_phi?.toFixed(3) ?? "—"} rated=${p.rated_plays}/${p.counted_plays} W-L ${p.wins}-${p.losses} ff ${p.forfeit_wins}/${p.forfeit_losses} bh=${p.buchholz}`
  );
}

// ---- assertions -------------------------------------------------------------------

const byId = new Map(res.matches.map((m) => [m.match_id, m]));
for (const [mid, sc] of scenario) {
  const m = byId.get(mid);
  if (!m) continue;
  const reasons = m.games.filter((g) => g.status === "excluded").map((g) => g.reason ?? "");
  const has = (frag: string) => reasons.some((r) => r.includes(frag));
  const readable = m.rooms.some((r) => r.ok);
  if (readable && !has("not a pool map")) fail(`match ${mid}: warmup should be excluded as not a pool map`);
  if (sc.includes("for-fun-after") && !has("for fun")) fail(`match ${mid}: for-fun pool map after the match should be excluded`);
  if (sc.includes("early-tb") && !has("tiebreaker")) fail(`match ${mid}: early TB should be excluded`);
  if (sc.includes("aborted") && !has("aborted")) fail(`match ${mid}: aborted game should be excluded`);
  if (sc.includes("solo-play") && !has("posted a score")) fail(`match ${mid}: one-player game should be excluded`);
  if (sc.includes("forfeit-with-maps") && m.counted !== 2) fail(`match ${mid}: forfeit lobby should count its 2 played maps (got ${m.counted})`);
  if (sc.includes("renamed-red") && m.red.user_id === null) fail(`match ${mid}: renamed red player should still resolve by activity`);
  if (sc.includes("unreadable-lobby") && m.rooms[0]?.ok) fail(`match ${mid}: unreadable lobby should be reported`);
}
for (const m of res.matches) {
  if (m.sheet_score && m.rooms.some((r) => r.ok)) {
    const total = m.sheet_score[0] + m.sheet_score[1];
    if (m.counted !== total) fail(`match ${m.match_id}: counted ${m.counted} but sheet implies ${total}`);
    if (m.lobby_score && (m.lobby_score[0] !== m.sheet_score[0] || m.lobby_score[1] !== m.sheet_score[1])) fail(`match ${m.match_id}: raw lobby score ${m.lobby_score} ≠ sheet ${m.sheet_score}`);
    const decidedOnTb = m.first_to && Math.max(...m.sheet_score) === m.first_to && Math.min(...m.sheet_score) === m.first_to - 1;
    const countedTb = m.games.filter((g) => g.status === "counted" && g.label === "TB").length;
    if (decidedOnTb && countedTb !== 1) fail(`match ${m.match_id}: decided on TB but counted ${countedTb} TB games`);
    if (!decidedOnTb && countedTb !== 0) fail(`match ${m.match_id}: not decided on TB but counted a TB`);
  }
  const pts = m.points[0] + m.points[1];
  if (m.outcome === "red" || m.outcome === "blue") {
    if (pts !== 1) fail(`match ${m.match_id}: exactly one point should be awarded`);
  } else if (pts !== 0) fail(`match ${m.match_id}: no point should be awarded for ${m.outcome}`);
}
// ordering: points desc, then performance desc
for (let i = 1; i < res.placements.length; i++) {
  const a = res.placements[i - 1]!;
  const b = res.placements[i]!;
  if (b.points > a.points) fail("placements not sorted by points");
  if (b.points === a.points && (b.performance ?? -Infinity) > (a.performance ?? -Infinity) + 1e-12) fail("tie not broken by performance");
}
// tiebreak sanity: (Σ value + k·neutral)/(n + k) with neutral = field mean value (Zipf) — recomputed from the grid
{
  const k = settings.prior_maps;
  const all: number[] = [];
  for (const cells of Object.values(res.grid.cells)) for (const c of Object.values(cells)) if (c && c.tiebreak.value !== null) all.push(c.tiebreak.value);
  const neutral = settings.value_mode === "phi" ? 0.5 : settings.value_mode === "z" ? 0 : all.reduce((a, b) => a + b, 0) / all.length;
  for (const p of res.placements) {
    const vals = Object.values(res.grid.cells[p.player.key] ?? {}).map((c) => c?.tiebreak.value ?? null).filter((v): v is number => v !== null);
    if (settings.value_mode === "zipf") {
      if (!vals.length) {
        if (p.performance !== null) fail(`${p.player.name}: performance without rated slots`);
        continue;
      }
      const sum = vals.reduce((a, b) => a + b, 0);
      const expect = (sum + k * neutral) / (vals.length + k);
      if (p.performance === null || Math.abs(expect - p.performance) > 1e-9) fail(`${p.player.name}: tiebreak ${p.performance} ≠ ${expect}`);
      if (Math.abs(sum / vals.length - (p.avg_value ?? NaN)) > 1e-9) fail(`${p.player.name}: avg_value mismatch`);
    }
  }
  ok(`tiebreak = ${res.tiebreak_label}, neutral ${neutral.toFixed(4)}, ${all.length} (player, slot) values`);
}
// every counted play on a rated slot has z/phi (computed on ADJUSTED scores); each slot's mean z ≈ 0
const byMap = new Map<string, number[]>();
for (const p of res.plays) {
  if (!p.rated) continue;
  if (p.z === null || p.phi === null) fail("rated play without z");
  byMap.set(p.map_key, [...(byMap.get(p.map_key) ?? []), p.z!]);
}
for (const [key, zs] of byMap) {
  const m = zs.reduce((a, b) => a + b, 0) / zs.length;
  if (Math.abs(m) > 1e-9) fail(`slot ${key}: mean z = ${m}`);
}
ok(`${res.matches.length} matches audited, ${res.plays.length} plays, ${byMap.size} rated slots`);

// ---- raw vs adjusted: visible stats are raw; the 0.95× lower-tier multiplier lives only in the tiebreak ----
{
  const slots = new Set(pool.maps.map((m) => m.slot)).size;
  if (res.maps.length !== slots) fail(`expected ${slots} slot rows, got ${res.maps.length}`);
  let lowerPlays = 0;
  for (const p of res.plays) {
    const pm = pool.maps.find((m) => m.beatmap_id === p.beatmap_id)!;
    const expectMult = pm.tier > 0 ? settings.lower_multiplier : 1;
    if (p.multiplier !== expectMult) fail(`play on ${p.label} #${p.beatmap_id}: multiplier ${p.multiplier}, expected ${expectMult}`);
    if (Math.abs(p.adjusted - p.score * expectMult) > 1e-6) fail(`play on ${p.label}: adjusted ${p.adjusted} ≠ ${p.score} × ${expectMult}`);
    if (p.map_key !== pm.slot) fail(`play on ${p.label}: map_key ${p.map_key} ≠ slot ${pm.slot}`);
    if (pm.tier > 0) lowerPlays++;
  }
  if (lowerPlays === 0) fail("synthetic lobbies produced no lower-tier plays — multiplier untested");
  for (const m of res.maps) {
    const lb = res.leaderboards[m.key] ?? [];
    for (let i = 1; i < lb.length; i++) if (lb[i]!.score > lb[i - 1]!.score) fail(`leaderboard ${m.label}: not sorted by raw score`);
    for (const e of lb) if (e.rank !== 1 + lb.filter((x) => x.score > e.score).length) fail(`leaderboard ${m.label}: rank of ${e.player.name} is wrong`);
    const perDiff = m.beatmaps.reduce((a, b) => a + b.plays, 0);
    if (perDiff !== m.plays) fail(`${m.label}: per-difficulty plays ${perDiff} ≠ slot plays ${m.plays}`);
    for (const b of m.beatmaps) {
      const plays = lb.filter((e) => e.beatmap_id === b.beatmap_id);
      const best = plays.reduce<number>((x, e) => Math.max(x, e.score), -1);
      if (plays.length && (!b.best || b.best.score !== best)) fail(`${m.label} ${b.beatmap_id}: best ${b.best?.score} ≠ ${best}`);
    }
    // raw placements come from raw bests; adjusted placements from adjusted bests
    const cells = res.placements.map((p) => res.grid.cells[p.player.key]?.[m.key] ?? null).filter((c): c is NonNullable<typeof c> => !!c);
    for (const c of cells) {
      if (c.placement !== 1 + cells.filter((o) => o.score > c.score).length) fail(`${m.label}: raw placement wrong`);
      if (c.tiebreak.placement !== 1 + cells.filter((o) => o.tiebreak.adjusted > c.tiebreak.adjusted).length) fail(`${m.label}: adjusted placement wrong`);
      if (settings.value_mode === "zipf" && m.tiebreak.rated && Math.abs((c.tiebreak.value ?? -1) - 1 / c.tiebreak.placement) > 1e-9) fail(`${m.label}: zipf value ≠ 1/placement`);
      if (settings.value_mode === "zipf" && !m.tiebreak.rated && c.tiebreak.value !== null) fail(`${m.label}: unrated slot has a value`);
    }
  }
  for (const p of res.placements) {
    const cells = Object.values(res.grid.cells[p.player.key] ?? {}).filter((c): c is NonNullable<typeof c> => !!c);
    if (p.top_scores !== cells.filter((c) => c.placement === 1).length) fail(`${p.player.name}: top_scores mismatch`);
    if (cells.length && Math.abs((p.avg_placement ?? NaN) - cells.reduce((a, c) => a + c.placement, 0) / cells.length) > 1e-9) fail(`${p.player.name}: avg_placement mismatch`);
    if (p.unique_maps !== cells.length) fail(`${p.player.name}: unique_maps ${p.unique_maps} ≠ ${cells.length}`);
  }
  // with the multiplier at 1, adjusted placements must equal raw placements everywhere
  const flat = computePlacements({ settings: { ...settings, lower_multiplier: 1 }, schedule: schedule.rows, pool: pool.maps, rooms, roomErrors, beatmaps: new Map() });
  for (const [pk, cells] of Object.entries(flat.grid.cells)) for (const [slot, c] of Object.entries(cells)) if (c && c.placement !== c.tiebreak.placement) fail(`×1: adjusted placement ≠ raw placement (${pk} ${slot})`);
  // and at 0.95 the tiebreak moves some lower-tier player down while every raw stat stays identical
  let moved = 0;
  for (const a of res.placements) {
    const b = flat.placements.find((x) => x.player.key === a.player.key)!;
    const lower = res.plays.some((p) => p.player_key === a.player.key && p.tier > 0);
    if (a.performance !== null && b.performance !== null && lower && a.performance < b.performance - 1e-9) moved++;
    if (a.top_scores !== b.top_scores || a.avg_placement !== b.avg_placement || a.avg_score !== b.avg_score) fail(`${a.player.name}: a raw stat changed with the multiplier`);
  }
  if (moved === 0) fail("the 0.95 multiplier changed nobody's tiebreak");
  for (const m of res.maps) {
    const other = flat.maps.find((x) => x.key === m.key)!;
    if (JSON.stringify(m.beatmaps.map((b) => [b.plays, b.mean, b.best?.score])) !== JSON.stringify(other.beatmaps.map((b) => [b.plays, b.mean, b.best?.score]))) fail(`${m.label}: mappool stats changed with the multiplier`);
    if (JSON.stringify(res.leaderboards[m.key]) !== JSON.stringify(flat.leaderboards[m.key])) fail(`${m.label}: leaderboard changed with the multiplier`);
  }
  ok(`multiplier: ${lowerPlays} lower-tier plays ×${settings.lower_multiplier} inside the tiebreak only; ${moved} lower-tier player(s) moved down; leaderboards/mappool stats unchanged`);
}

if (process.env.DEBUG_MATCH) {
  const dm = res.matches.find((m) => m.match_id === process.env.DEBUG_MATCH);
  for (const g of dm?.games ?? []) console.log("  g", g.order, g.label, g.red?.score, g.blue?.score, g.raw_winner, g.status, g.reason ?? "", g.score_after ?? "");
}
placementsWorkbook(res).then((buf) => {
  fs.writeFileSync("/tmp/placements-smoke.xlsx", buf);
  ok(`workbook written (${(buf.length / 1024).toFixed(0)} KB) → /tmp/placements-smoke.xlsx`);
  console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE PASSED");
});
