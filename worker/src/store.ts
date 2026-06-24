import { Redis } from "ioredis";
import { config } from "./config.js";
import type { AppConfig, LiveState, RescanState, Hit, HitGame, Status, MatchDetail, MatchGame } from "./types.js";

const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null, // let ioredis keep retrying transient blips
  lazyConnect: false,
});
redis.on("error", (e: Error) => console.error("[redis]", e.message));

const K = {
  config: `${config.keyPrefix}:config`,
  live: `${config.keyPrefix}:live`,
  rescan: `${config.keyPrefix}:rescan`,
  status: `${config.keyPrefix}:status`,
  hits: `${config.keyPrefix}:hits`, // HASH matchId -> Hit (JSON)
  hitsIdx: `${config.keyPrefix}:hits:idx`, // ZSET matchId scored by start_time epoch
  watch: `${config.keyPrefix}:watch`, // HASH matchId -> firstSeen epoch
};

const beatmapUrl = (id: number) => `https://osu.ppy.sh/b/${id}`;
const matchUrl = (id: number) => `https://osu.ppy.sh/community/matches/${id}`;
const epoch = (iso: string | null | undefined): number => {
  if (!iso) return Date.now();
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Date.now();
};

async function getJson<T>(key: string): Promise<T | null> {
  const raw = await redis.get(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
async function setJson(key: string, value: unknown): Promise<void> {
  await redis.set(key, JSON.stringify(value));
}

// ---- config (read-only here; the web app writes it) ----

export async function loadConfig(): Promise<AppConfig> {
  const c = await getJson<AppConfig>(K.config);
  if (!c) return { target_beatmap_ids: [], enabled: false, updated_at: new Date(0).toISOString() };
  return {
    target_beatmap_ids: Array.isArray(c.target_beatmap_ids) ? c.target_beatmap_ids.filter((n) => Number.isInteger(n)) : [],
    enabled: !!c.enabled,
    updated_at: c.updated_at ?? new Date(0).toISOString(),
  };
}

// ---- live state ----

export async function loadLiveState(): Promise<LiveState | null> {
  return getJson<LiveState>(K.live);
}
export async function saveLiveState(s: LiveState): Promise<void> {
  await setJson(K.live, s);
}

// ---- rescan state ----

export async function loadRescan(): Promise<RescanState | null> {
  return getJson<RescanState>(K.rescan);
}
export async function saveRescan(s: RescanState): Promise<void> {
  await setJson(K.rescan, s);
}

// ---- hits ----

export async function upsertHit(detail: MatchDetail, hitGames: MatchGame[], source: "live" | "rescan"): Promise<void> {
  const m = detail.match;
  const games: HitGame[] = hitGames.map((g) => ({
    game_id: g.id,
    beatmap_id: g.beatmap_id,
    beatmap_url: beatmapUrl(g.beatmap_id),
    title: g.title ?? null,
    version: g.version ?? null,
    mods: g.mods,
    mode: g.mode ?? null,
    scoring_type: g.scoring_type ?? null,
    team_type: g.team_type ?? null,
    played_at: g.start_time ?? null,
    scores_count: g.scores_count,
  }));
  const hit: Hit = {
    match_id: m.id,
    match_name: m.name,
    match_url: matchUrl(m.id),
    start_time: m.start_time,
    end_time: m.end_time,
    still_open: m.end_time === null,
    found_at: new Date().toISOString(),
    source,
    games,
  };
  await redis.hset(K.hits, String(m.id), JSON.stringify(hit));
  await redis.zadd(K.hitsIdx, epoch(m.start_time), String(m.id));
}

export async function hitsCount(): Promise<number> {
  return redis.zcard(K.hitsIdx);
}

// ---- open-lobby watchlist ----

export async function watchAdd(matchId: number): Promise<void> {
  if (!config.watchOpenMatches) return;
  await redis.hset(K.watch, String(matchId), Date.now());
}
export async function watchRemove(matchId: number): Promise<void> {
  await redis.hdel(K.watch, String(matchId));
}
export async function watchCount(): Promise<number> {
  return redis.hlen(K.watch);
}
/** Prune aged/over-cap entries; return the ids still worth re-checking (newest first). */
export async function watchDue(): Promise<number[]> {
  if (!config.watchOpenMatches) return [];
  const all = (await redis.hgetall(K.watch)) as Record<string, string>;
  const now = Date.now();
  const ttlMs = config.watchTtlSec * 1000;
  const entries = Object.entries(all)
    .map(([id, ts]) => ({ id: Number(id), firstSeen: Number(ts) }))
    .sort((a, b) => b.firstSeen - a.firstSeen);

  const keep: number[] = [];
  const drop: string[] = [];
  entries.forEach((e, i) => {
    if (now - e.firstSeen > ttlMs || i >= config.watchMax) drop.push(String(e.id));
    else keep.push(e.id);
  });
  if (drop.length) await redis.hdel(K.watch, ...drop);
  return keep;
}

// ---- status ----

export async function writeStatus(s: Status): Promise<void> {
  await setJson(K.status, s);
}

export async function disconnect(): Promise<void> {
  await redis.quit();
}
