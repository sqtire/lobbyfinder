import { Redis } from "ioredis";
import { config } from "./config.js";
import type { AppConfig, RollState, RescanState, Hit, HitGame, Status, MatchDetail, MatchGame } from "./types.js";

const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null, // let ioredis keep retrying transient blips
  lazyConnect: false,
});
redis.on("error", (e: Error) => console.error("[redis]", e.message));

const K = {
  config: `${config.keyPrefix}:config`,
  roll: `${config.keyPrefix}:roll`, // rolling-sweep cursor (replaces the old :live)
  rescan: `${config.keyPrefix}:rescan`,
  status: `${config.keyPrefix}:status`,
  hits: `${config.keyPrefix}:hits`, // HASH matchId -> Hit (JSON)
  hitsIdx: `${config.keyPrefix}:hits:idx`, // ZSET matchId scored by start_time epoch
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

// ---- rolling-sweep state ----

export async function loadRollState(): Promise<RollState | null> {
  return getJson<RollState>(K.roll);
}
export async function saveRollState(s: RollState): Promise<void> {
  await setJson(K.roll, s);
}

// ---- rescan state ----

export async function loadRescan(): Promise<RescanState | null> {
  return getJson<RescanState>(K.rescan);
}
export async function saveRescan(s: RescanState): Promise<void> {
  await setJson(K.rescan, s);
}

// ---- hits ----

export async function upsertHit(
  detail: MatchDetail,
  hitGames: MatchGame[],
  source: "auto" | "rescan",
  partial: boolean
): Promise<void> {
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
    partial,
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

// ---- status ----

export async function writeStatus(s: Status): Promise<void> {
  await setJson(K.status, s);
}

export async function disconnect(): Promise<void> {
  await redis.quit();
}
