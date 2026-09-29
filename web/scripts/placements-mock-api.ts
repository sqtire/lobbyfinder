/**
 * Local stand-in for Google Sheets + the osu! API v2, so a full placements run
 * can be exercised against `next start` without network access:
 *
 *   PLACEMENTS_SHEETS_BASE=http://127.0.0.1:3222 \
 *   PLACEMENTS_OSU_OAUTH_URL=http://127.0.0.1:3222/oauth/token \
 *   PLACEMENTS_OSU_API_BASE=http://127.0.0.1:3222/api/v2 \
 *   PLACEMENTS_OSU_INTERVAL_MS=20 npx next start
 *
 * Usage: tsx --tsconfig tsconfig.json scripts/placements-mock-api.ts <schedule.csv> [port]
 *
 * Every lazer room linked from the schedule is synthesised from the sheet row
 * it belongs to: one warmup (non-pool map), the counted maps in lobby order
 * (winner chosen so the reconstructed score matches the sheet), a TB when the
 * sheet says so, and — for every third match — a "for fun" pool map after the
 * match has ended. Scores are deterministic per (user, map).
 */

import http from "node:http";
import fs from "node:fs";
import { parseSchedule, parseScheduleTable } from "../lib/placements/schedule";
import { parsePool } from "../lib/placements/pool";
import { normalizeName } from "../lib/rosterParse";

const csvPath = process.argv[2];
const port = Number(process.argv[3] ?? 3222);
const xlsxPath = process.argv[4]; // optional: served at /spreadsheets/d/<id>/export (the real referee sheet)
if (!csvPath) {
  console.error("usage: placements-mock-api.ts <schedule.csv | table.json> [port] [sheet.xlsx]");
  process.exit(2);
}
const csv = fs.readFileSync(csvPath, "utf8");
const schedule = csvPath.endsWith(".json") ? parseScheduleTable(JSON.parse(csv) as string[][]) : parseSchedule(csv);
const xlsx = xlsxPath ? fs.readFileSync(xlsxPath) : null;

// A synthetic pool: 6 slots × 2 tiers + TB (2 tiers). Exposed on /pool.txt.
export const POOL_TEXT = [
  "NM1 5000001 5000002",
  "NM2 5000003 5000004",
  "HD1 5000005 5000006",
  "HR1 5000007 5000008",
  "DT1 5000009 5000010",
  "FM1 5000011 5000012",
  "TB 5000013 5000014",
].join("\n");
const pool = parsePool(POOL_TEXT);
const slots = [...new Set(pool.maps.map((m) => m.label))];
const WARMUP_ID = 4999999;
const ALL_MAP_IDS = [...pool.maps.map((m) => m.beatmap_id), WARMUP_ID];

// players: sheet name -> synthetic user id
const userIds = new Map<string, number>();
function uid(name: string, sheetId: number | null = null): number {
  if (sheetId) return sheetId;
  const k = normalizeName(name);
  let id = userIds.get(k);
  if (!id) userIds.set(k, (id = 7000000 + userIds.size + 1));
  return id;
}
const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
};
const tierOf = (id: number) => id % 2; // arbitrary: odd/even users on tier 1/2
const skill = (id: number) => 0.6 + hash(`skill:${id}`) * 0.4;
function rawScore(user: number, map: number) {
  return Math.round(1_000_000 * skill(user) * (0.7 + 0.3 * hash(`s:${user}:${map}`)));
}

interface Item {
  id: number;
  beatmap_id: number;
  freestyle: boolean;
  scores: any[];
  completed: boolean;
  aborted: boolean;
}

function scoreObj(user: number, map: number, override?: number) {
  return {
    user_id: user,
    beatmap_id: map,
    total_score: override ?? rawScore(user, map),
    accuracy: 0.9 + hash(`a:${user}:${map}`) * 0.1,
    max_combo: 500 + Math.round(hash(`c:${user}:${map}`) * 900),
    passed: hash(`p:${user}:${map}`) > 0.03,
    mods: [{ acronym: "NF" }],
    playlist_item_id: 0,
  };
}

const rooms = new Map<number, any>();
let itemSeq = 800000;
let evSeq = 9000000;

function buildRoom(roomId: number, row: (typeof schedule.rows)[number], roomIdx: number) {
  const red = uid(row.red, row.red_id);
  const blue = uid(row.blue, row.blue_id);
  const items: Item[] = [];
  const events: any[] = [];
  const pushGame = (beatmap: number, scores: any[], opts: { aborted?: boolean } = {}) => {
    const it: Item = { id: ++itemSeq, beatmap_id: beatmap, freestyle: true, scores, completed: !opts.aborted, aborted: !!opts.aborted };
    for (const s of scores) s.playlist_item_id = it.id;
    items.push(it);
    events.push({ id: ++evSeq, event_type: "game_started", playlist_item_id: it.id, user_id: null, created_at: new Date().toISOString() });
    events.push({ id: ++evSeq, event_type: opts.aborted ? "game_aborted" : "game_completed", playlist_item_id: it.id, user_id: null, created_at: new Date().toISOString() });
  };
  const slotGame = (slotIdx: number, winner: "red" | "blue" | null, opts: { aborted?: boolean; only?: "red" | "blue" } = {}) => {
    const label = slots[slotIdx % slots.length]!;
    const ids = pool.maps.filter((m) => m.label === label).map((m) => m.beatmap_id);
    const rMap = ids[tierOf(red)] ?? ids[0]!;
    const bMap = ids[tierOf(blue)] ?? ids[0]!;
    const rs = scoreObj(red, rMap);
    const bs = scoreObj(blue, bMap);
    if (winner === "red" && rs.total_score <= bs.total_score) rs.total_score = bs.total_score + 1000;
    if (winner === "blue" && bs.total_score <= rs.total_score) bs.total_score = rs.total_score + 1000;
    if (winner === null) bs.total_score = rs.total_score;
    const scores = opts.only === "red" ? [rs] : opts.only === "blue" ? [bs] : [rs, bs];
    pushGame(rMap, scores, opts);
  };

  // only the first room of a split match gets the warmup; the second continues
  if (roomIdx === 0) pushGame(WARMUP_ID, [scoreObj(red, WARMUP_ID), scoreObj(blue, WARMUP_ID)]);

  const ft = row.first_to ?? 4;
  let redW = row.forfeit ? (row.forfeit === "red" ? 0 : 1) : Math.max(0, row.red_score ?? 0);
  let blueW = row.forfeit ? (row.forfeit === "blue" ? 0 : 1) : Math.max(0, row.blue_score ?? 0);
  if (row.forfeit === "both") redW = blueW = 0;
  // sequence of winners: alternate until one side runs out
  const seq: ("red" | "blue")[] = [];
  let r = redW;
  let b = blueW;
  while (r > 0 || b > 0) {
    if (r >= b && r > 0) {
      seq.push("red");
      r--;
    } else if (b > 0) {
      seq.push("blue");
      b--;
    }
  }
  // move the decider last so TB (if any) is the deciding game
  const total = seq.length;
  let slotIdx = 0;
  const half = roomIdx === 0 ? seq : [];
  const perRoom = row.rooms.length > 1 ? Math.ceil(total / row.rooms.length) : total;
  const mySeq = row.rooms.length > 1 ? seq.slice(roomIdx * perRoom, (roomIdx + 1) * perRoom) : half;
  const base = row.rooms.length > 1 ? roomIdx * perRoom : 0;
  mySeq.forEach((w, i) => {
    const gameNo = base + i + 1;
    const isTb = redW === ft && blueW === ft - 1 && gameNo === total;
    const isTbBlue = blueW === ft && redW === ft - 1 && gameNo === total;
    if (isTb || isTbBlue) {
      const tbIdx = slots.indexOf("TB");
      slotGame(tbIdx, w);
    } else {
      if (slots[slotIdx % slots.length] === "TB") slotIdx++;
      slotGame(slotIdx++, w);
    }
    // sprinkle an aborted game / a solo play into some lobbies
    if (gameNo === 2 && roomId % 5 === 0) slotGame(slotIdx, null, { aborted: true });
    if (gameNo === 1 && roomId % 7 === 0) slotGame(slotIdx, null, { only: "red" });
  });
  // "for fun" pool map after the match in every third match
  if (roomIdx === row.rooms.length - 1 && total > 0 && roomId % 3 === 0) {
    if (slots[slotIdx % slots.length] === "TB") slotIdx++;
    slotGame(slotIdx, null);
  }

  const playlist_items = items.map((it, i) => ({
    id: it.id,
    beatmap_id: it.beatmap_id,
    playlist_order: i,
    freestyle: it.freestyle,
    required_mods: [],
    expired: true,
    created_at: new Date().toISOString(),
    played_at: it.aborted ? null : new Date().toISOString(),
    details: { room_type: "head_to_head", started_at: new Date().toISOString() },
    scores: it.scores,
  }));
  const bmIds = new Set(items.map((i) => i.beatmap_id));
  for (const it of items) for (const s of it.scores) bmIds.add(s.beatmap_id);
  return {
    beatmaps: [...bmIds].map((id) => ({ id, beatmapset_id: 100000 + (id % 1000), version: `Tier ${1 + (id % 2)}`, difficulty_rating: 5 + (id % 3) })),
    beatmapsets: [...bmIds].map((id) => ({ id: 100000 + (id % 1000), artist: "Artist", title: `Song ${id}`, creator: "mapper" })),
    events,
    first_event_id: events[0]?.id ?? 0,
    last_event_id: events[events.length - 1]?.id ?? 0,
    playlist_items,
    room: { id: roomId, name: `AEROLS: (${row.red}) vs (${row.blue})`, starts_at: new Date().toISOString(), ends_at: new Date().toISOString() },
    users: [
      { id: red, username: row.red, country_code: "XX" },
      { id: blue, username: row.blue, country_code: "XX" },
    ],
  };
}

for (const row of schedule.rows) {
  row.rooms.forEach((ref, i) => {
    if (ref.kind === "lazer" && !rooms.has(ref.id)) rooms.set(ref.id, buildRoom(ref.id, row, i));
  });
}
console.log(`mock: ${schedule.rows.length} rows, ${rooms.size} lazer rooms synthesised, ${userIds.size} players`);

let requests = 0;
const server = http.createServer((req, res) => {
  requests++;
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const send = (status: number, body: unknown, type = "application/json") => {
    res.writeHead(status, { "content-type": type });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  if (url.pathname === "/pool.txt") return send(200, POOL_TEXT, "text/plain");
  if (url.pathname === "/stats") return send(200, { requests, rooms: rooms.size });
  if (url.pathname.startsWith("/spreadsheets/d/") && url.pathname.endsWith("/export") && url.searchParams.get("format") === "xlsx") {
    if (!xlsx) return send(404, "no xlsx configured", "text/plain");
    res.writeHead(200, { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    return res.end(xlsx);
  }
  if (url.pathname.startsWith("/spreadsheets/d/")) {
    if (url.pathname.endsWith("/gviz/tq")) {
      if (url.searchParams.get("sheet") !== "Chrono Schedule") return send(200, "", "text/csv"); // wrong tab -> empty
      return send(200, csv, "text/csv");
    }
    return send(200, csv, "text/csv");
  }
  if (url.pathname === "/oauth/token") return send(200, { access_token: "mock-token", expires_in: 86400, token_type: "Bearer" });
  if (!req.headers.authorization?.startsWith("Bearer ")) return send(401, { error: "unauthorized" });
  const m = url.pathname.match(/^\/api\/v2\/rooms\/(\d+)\/events$/);
  if (m) {
    const room = rooms.get(Number(m[1]));
    if (!room) return send(404, { error: "not found" });
    // paging: honour `before` by returning nothing older (single page fits)
    const before = url.searchParams.get("before");
    if (before && Number(before) <= room.first_event_id) return send(200, { ...room, events: [] });
    return send(200, room);
  }
  if (url.pathname === "/api/v2/beatmaps") {
    const ids = url.searchParams.getAll("ids[]").map(Number);
    return send(200, {
      beatmaps: ids
        .filter((id) => ALL_MAP_IDS.includes(id))
        .map((id) => ({
          id,
          beatmapset_id: 100000 + (id % 1000),
          version: `Tier ${1 + (id % 2)}`,
          difficulty_rating: 5 + (id % 3),
          beatmapset: { id: 100000 + (id % 1000), artist: "Artist", title: `Song ${id}`, creator: "mapper" },
        })),
    });
  }
  const lm = url.pathname.match(/^\/api\/v2\/matches\/(\d+)$/);
  if (lm) return send(404, { error: "not found" });
  send(404, { error: `no mock for ${url.pathname}` });
});
server.listen(port, () => console.log(`mock api on http://127.0.0.1:${port}`));
