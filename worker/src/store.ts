import { Redis } from "ioredis";
import { config } from "./config.js";
import type {
  BackfillState,
  CoverageRange,
  DayStat,
  GlobalConfig,
  Hit,
  HitGame,
  MatchDetail,
  PlayerStat,
  RollState,
  Status,
  Tenant,
  WalkState,
} from "./types.js";

const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null, // let ioredis keep retrying transient blips
  lazyConnect: false,
});
redis.on("error", (e: Error) => console.error("[redis]", e.message));

const P = config.keyPrefix;
/** Key layout — mirrored in web/lib/redis.ts. Keep the two in sync. */
export const K = {
  global: `${P}:global`, // JSON GlobalConfig (site-wide switch)
  tenants: `${P}:tenants`, // SET of slugs
  tenant: (s: string) => `${P}:t:${s}`, // JSON Tenant
  tHits: (s: string) => `${P}:t:${s}:hits`, // ZSET match_id scored by start epoch (references into :hits)
  tHidden: (s: string) => `${P}:t:${s}:hidden`, // SET of tombstoned match ids
  tBackfill: (s: string) => `${P}:t:${s}:backfill`, // JSON BackfillState
  tBackfillPending: (s: string) => `${P}:t:${s}:backfill:pending`, // LIST of match ids awaiting a detail read
  backfillQueue: `${P}:backfill:queue`, // LIST of slugs waiting
  backfillActive: `${P}:backfill:active`, // STRING slug currently being served
  coverageReq: `${P}:coverage:req`, // HASH slug -> JSON (tenant asked for days the index lacks)
  roll: `${P}:roll`, // JSON RollState
  walk: `${P}:walk`, // JSON WalkState (active)
  walkQueue: `${P}:walk:queue`, // LIST of JSON WalkState (queued)
  status: `${P}:status`, // JSON Status
  hits: `${P}:hits`, // HASH match_id -> Hit JSON (GLOBAL detail store)
  hitsIdx: `${P}:hits:idx`, // ZSET match_id scored by start epoch (global)
  idxDay: (day: string) => `${P}:idx:${day}`, // HASH match_id -> "<bm36>,<bm36>|flags"
  idxDays: `${P}:idx:days`, // HASH day -> DayStat JSON
  idxCov: `${P}:idx:cov`, // JSON { intervals: CoverageRange[] }
};

const beatmapUrl = (id: number) => `https://osu.ppy.sh/b/${id}`;
const matchUrl = (id: number) => `https://osu.ppy.sh/community/matches/${id}`;
export const epoch = (iso: string | null | undefined): number => {
  if (!iso) return Date.now();
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Date.now();
};

/** UTC calendar day (YYYY-MM-DD) of an ISO timestamp; today when missing/invalid. */
export function dayOf(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  const d = Number.isFinite(t) ? new Date(t) : new Date();
  return d.toISOString().slice(0, 10);
}
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
export function addDays(day: string, n: number): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}
export const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

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

// ---- global switch + tenants (written by the web app; read-only here) ----

export async function loadGlobal(): Promise<GlobalConfig> {
  const g = await getJson<GlobalConfig>(K.global);
  if (!g) return { enabled: true, updated_at: new Date(0).toISOString() };
  return { enabled: g.enabled !== false, updated_at: g.updated_at ?? new Date(0).toISOString() };
}

export async function loadTenants(): Promise<Tenant[]> {
  const slugs = await redis.smembers(K.tenants);
  if (slugs.length === 0) return [];
  const raws = await redis.mget(...slugs.map(K.tenant));
  const out: Tenant[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    try {
      const t = JSON.parse(raw) as Tenant;
      if (!t || typeof t.slug !== "string") continue;
      out.push({
        slug: t.slug,
        name: typeof t.name === "string" ? t.name : t.slug,
        owner_id: Number.isInteger(t.owner_id) ? t.owner_id : 0,
        pool: Array.isArray(t.pool) ? t.pool.filter((n) => Number.isInteger(n) && n > 0) : [],
        enabled: t.enabled !== false,
        start_id: Number.isInteger(t.start_id) && (t.start_id as number) > 0 ? (t.start_id as number) : null,
        created_at: t.created_at ?? new Date(0).toISOString(),
        updated_at: t.updated_at ?? new Date(0).toISOString(),
      });
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

export async function loadTenant(slug: string): Promise<Tenant | null> {
  const list = await loadTenants();
  return list.find((t) => t.slug === slug) ?? null;
}

// ---- rolling-sweep state ----

export async function loadRollState(): Promise<RollState | null> {
  const s = await getJson<RollState>(K.roll);
  if (!s) return null;
  return {
    ...s,
    index_from: Number.isInteger(s.index_from) ? s.index_from : null,
    cursor_start: typeof s.cursor_start === "string" ? s.cursor_start : null,
  };
}
export async function saveRollState(s: RollState): Promise<void> {
  await setJson(K.roll, s);
}

// ---- owner walks (queue + active) ----

export async function loadWalk(): Promise<WalkState | null> {
  return getJson<WalkState>(K.walk);
}
export async function saveWalk(w: WalkState): Promise<void> {
  await setJson(K.walk, w);
}
export async function walkQueueLength(): Promise<number> {
  return redis.llen(K.walkQueue);
}
/** Promote the next queued walk to active. Returns it, or null when the queue is empty. */
export async function popNextWalk(): Promise<WalkState | null> {
  while (true) {
    const raw = await redis.lpop(K.walkQueue);
    if (!raw) return null;
    try {
      const w = JSON.parse(raw) as WalkState;
      if (w.status !== "queued") continue; // cancelled while queued
      w.status = "running";
      await saveWalk(w);
      return w;
    } catch {
      continue;
    }
  }
}

// ---- tenant backfills (queue + per-tenant state) ----

export async function backfillQueueLength(): Promise<number> {
  return redis.llen(K.backfillQueue);
}
export async function loadBackfillActive(): Promise<string | null> {
  return redis.get(K.backfillActive);
}
export async function setBackfillActive(slug: string | null): Promise<void> {
  if (slug) await redis.set(K.backfillActive, slug);
  else await redis.del(K.backfillActive);
}
export async function popNextBackfill(): Promise<string | null> {
  return redis.lpop(K.backfillQueue);
}
export async function loadBackfill(slug: string): Promise<BackfillState | null> {
  return getJson<BackfillState>(K.tBackfill(slug));
}
export async function saveBackfill(slug: string, s: BackfillState): Promise<void> {
  await setJson(K.tBackfill(slug), s);
}
export async function pushPending(slug: string, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  // chunk to keep single commands reasonable
  for (let i = 0; i < ids.length; i += 1000) await redis.rpush(K.tBackfillPending(slug), ...ids.slice(i, i + 1000).map(String));
}
export async function popPending(slug: string): Promise<number | null> {
  const raw = await redis.lpop(K.tBackfillPending(slug));
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}
export async function pendingLength(slug: string): Promise<number> {
  return redis.llen(K.tBackfillPending(slug));
}
export async function clearPending(slug: string): Promise<void> {
  await redis.del(K.tBackfillPending(slug));
}
export async function setCoverageRequest(
  slug: string,
  req: { from_id: number; to_id: number; uncovered: CoverageRange[]; uncovered_ids: number; at: string }
): Promise<void> {
  await redis.hset(K.coverageReq, slug, JSON.stringify(req));
}

// ---- match index -----------------------------------------------------------
//
// One HASH per UTC day (of the lobby's start_time): match_id -> "a1b,2c3|p"
// where the maps are base36 beatmap ids and "|p" flags a lobby that was still
// open when read. Matches with zero games are not indexed (nothing to match).
// Day stats + coverage ranges live in memory and are flushed with the status.

const dayStats = new Map<string, DayStat>();
const dirtyDays = new Set<string>();
let coverage: CoverageRange[] = [];
let coverageDirty = false;
let indexLoaded = false;

export function encodeMaps(beatmapIds: number[], partial: boolean): string {
  const uniq = [...new Set(beatmapIds)].map((n) => n.toString(36));
  return uniq.join(",") + (partial ? "|p" : "");
}
export function decodeMaps(v: string): { maps: number[]; partial: boolean } {
  const [ids, flags] = v.split("|");
  const maps = (ids ?? "")
    .split(",")
    .filter(Boolean)
    .map((s) => parseInt(s, 36))
    .filter((n) => Number.isInteger(n) && n > 0);
  return { maps, partial: (flags ?? "").includes("p") };
}

export async function loadIndexMeta(): Promise<void> {
  const raw = await redis.hgetall(K.idxDays);
  dayStats.clear();
  for (const [day, json] of Object.entries(raw)) {
    try {
      const s = JSON.parse(json) as DayStat;
      if (isDay(day) && s && Number.isFinite(s.n)) dayStats.set(day, { n: s.n, min_id: s.min_id, max_id: s.max_id });
    } catch {
      /* skip */
    }
  }
  const cov = await getJson<{ intervals: CoverageRange[] }>(K.idxCov);
  coverage = Array.isArray(cov?.intervals) ? cov!.intervals.filter((r) => Number.isInteger(r.from) && Number.isInteger(r.to)) : [];
  indexLoaded = true;
}

/** Index one read match. Returns true when it was written (had >= 1 game). */
export async function indexMatch(detail: MatchDetail): Promise<boolean> {
  if (!indexLoaded) throw new Error("index meta not loaded");
  const m = detail.match;
  if (detail.games.length === 0) return false;
  const day = dayOf(m.start_time);
  const value = encodeMaps(
    detail.games.map((g) => g.beatmap_id),
    m.end_time === null
  );
  const ttl = (config.indexRetentionDays + 7) * 86400;
  await redis
    .multi()
    .hset(K.idxDay(day), String(m.id), value)
    .expire(K.idxDay(day), ttl)
    .exec();
  const s = dayStats.get(day);
  if (s) {
    s.n += 1;
    s.min_id = Math.min(s.min_id, m.id);
    s.max_id = Math.max(s.max_id, m.id);
  } else dayStats.set(day, { n: 1, min_id: m.id, max_id: m.id });
  dirtyDays.add(day);
  return true;
}

/** Record that [from, to] has been read (sweep or walk); merges adjacent/overlapping ranges. */
export function addCoverage(from: number, to: number): void {
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) return;
  const merged: CoverageRange[] = [];
  let cur: CoverageRange = { from, to };
  const all = [...coverage, cur].sort((a, b) => a.from - b.from);
  cur = all[0]!;
  for (let i = 1; i < all.length; i++) {
    const r = all[i]!;
    if (r.from <= cur.to + 1) cur = { from: cur.from, to: Math.max(cur.to, r.to) };
    else {
      merged.push(cur);
      cur = r;
    }
  }
  merged.push(cur);
  const changed = JSON.stringify(merged) !== JSON.stringify(coverage);
  coverage = merged;
  if (changed) coverageDirty = true;
}
export function getCoverage(): CoverageRange[] {
  return coverage.map((r) => ({ ...r }));
}
export function indexSummary(): { days: number; oldest_day: string | null; newest_day: string | null; matches: number } {
  const days = [...dayStats.keys()].sort();
  let matches = 0;
  for (const s of dayStats.values()) matches += s.n;
  return { days: days.length, oldest_day: days[0] ?? null, newest_day: days[days.length - 1] ?? null, matches };
}
export function hasDay(day: string): boolean {
  return dayStats.has(day);
}
export function oldestDay(): string | null {
  const days = [...dayStats.keys()].sort();
  return days[0] ?? null;
}

export async function flushIndexMeta(): Promise<void> {
  if (dirtyDays.size > 0) {
    const args: string[] = [];
    for (const day of dirtyDays) {
      const s = dayStats.get(day);
      if (s) args.push(day, JSON.stringify(s));
    }
    dirtyDays.clear();
    if (args.length) await redis.hset(K.idxDays, ...args);
  }
  if (coverageDirty) {
    coverageDirty = false;
    await setJson(K.idxCov, { intervals: coverage });
  }
}

/** Drop day buckets older than the retention window and clip coverage accordingly. */
export async function pruneIndex(): Promise<number> {
  const cutoff = addDays(todayUtc(), -config.indexRetentionDays);
  const stale = [...dayStats.keys()].filter((d) => d < cutoff);
  if (stale.length === 0) return 0;
  const multi = redis.multi();
  for (const d of stale) {
    multi.del(K.idxDay(d));
    multi.hdel(K.idxDays, d);
    dayStats.delete(d);
    dirtyDays.delete(d);
  }
  await multi.exec();
  // coverage below the oldest remaining indexed id is no longer backed by data
  let minId = Infinity;
  for (const s of dayStats.values()) minId = Math.min(minId, s.min_id);
  if (Number.isFinite(minId)) {
    const clipped = coverage.filter((r) => r.to >= minId).map((r) => ({ from: Math.max(r.from, minId), to: r.to }));
    if (JSON.stringify(clipped) !== JSON.stringify(coverage)) {
      coverage = clipped;
      coverageDirty = true;
    }
  } else if (coverage.length) {
    coverage = [];
    coverageDirty = true;
  }
  await flushIndexMeta();
  return stale.length;
}

export interface IndexCandidate {
  match_id: number;
  day: string;
  partial: boolean;
}

/**
 * Scan the index for lobbies in [fromId, toId] that played any map in `pool`.
 * Only day buckets whose id span intersects the range are opened (day stats
 * carry min/max id), so cost is bounded by retention, not by the range size.
 */
export async function scanIndex(fromId: number, toId: number, pool: Set<number>): Promise<IndexCandidate[]> {
  const candidates: IndexCandidate[] = [];
  if (pool.size === 0 || fromId > toId) return candidates;
  const days = [...dayStats.entries()].filter(([, s]) => s.max_id >= fromId && s.min_id <= toId).map(([d]) => d);
  for (const day of days) {
    let cursor = "0";
    do {
      const [next, kv] = await redis.hscan(K.idxDay(day), cursor, "COUNT", 2000);
      cursor = next;
      for (let i = 0; i + 1 < kv.length; i += 2) {
        const id = Number(kv[i]);
        if (!Number.isInteger(id) || id < fromId || id > toId) continue;
        const { maps, partial } = decodeMaps(kv[i + 1]!);
        if (maps.some((b) => pool.has(b))) candidates.push({ match_id: id, day, partial });
      }
    } while (cursor !== "0");
  }
  candidates.sort((a, b) => a.match_id - b.match_id);
  return candidates;
}

/** Parts of [fromId, toId] that no sweep or walk has ever read (i.e. not backed by the index). */
export function uncoveredRanges(fromId: number, toId: number): CoverageRange[] {
  const gaps: CoverageRange[] = [];
  if (fromId > toId) return gaps;
  let cur = fromId;
  for (const r of [...coverage].sort((a, b) => a.from - b.from)) {
    if (r.to < cur) continue;
    if (r.from > toId) break;
    if (r.from > cur) gaps.push({ from: cur, to: r.from - 1 });
    cur = Math.max(cur, r.to + 1);
    if (cur > toId) break;
  }
  if (cur <= toId) gaps.push({ from: cur, to: toId });
  return gaps;
}
export const rangeSize = (rs: CoverageRange[]): number => rs.reduce((n, r) => n + (r.to - r.from + 1), 0);

// ---- global hit store + tenant references ----------------------------------

export function buildHit(detail: MatchDetail, source: Hit["source"], partial: boolean): Hit {
  const m = detail.match;
  const games: HitGame[] = detail.games.map((g) => ({
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
    scores: g.scores,
  }));
  return {
    match_id: m.id,
    match_name: m.name,
    match_url: matchUrl(m.id),
    start_time: m.start_time,
    end_time: m.end_time,
    still_open: m.end_time === null,
    partial,
    found_at: new Date().toISOString(),
    source,
    all_games: true,
    games,
    players: aggregatePlayers(detail),
  };
}

/** Count, per user, how many games in the whole lobby they posted a score on. */
function aggregatePlayers(detail: MatchDetail): PlayerStat[] {
  const counts = new Map<number, number>();
  for (const g of detail.games) {
    for (const s of g.scores) counts.set(s.user_id, (counts.get(s.user_id) ?? 0) + 1);
  }
  const out: PlayerStat[] = [];
  for (const [user_id, maps_played] of counts) {
    out.push({ user_id, username: detail.users[user_id] ?? `User ${user_id}`, maps_played });
  }
  out.sort((a, b) => b.maps_played - a.maps_played || a.username.localeCompare(b.username));
  return out;
}

/** Store (or refresh) the full detail of a lobby in the global store. */
export async function storeHit(hit: Hit): Promise<void> {
  await redis
    .multi()
    .hset(K.hits, String(hit.match_id), JSON.stringify(hit))
    .zadd(K.hitsIdx, epoch(hit.start_time), String(hit.match_id))
    .exec();
}
export async function getHit(matchId: number): Promise<Hit | null> {
  const raw = await redis.hget(K.hits, String(matchId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Hit;
  } catch {
    return null;
  }
}
export async function hitExists(matchId: number): Promise<boolean> {
  return (await redis.hexists(K.hits, String(matchId))) === 1;
}
export async function hitsCount(): Promise<number> {
  return redis.zcard(K.hitsIdx);
}

export async function isHidden(slug: string, matchId: number): Promise<boolean> {
  return (await redis.sismember(K.tHidden(slug), String(matchId))) === 1;
}

/** Add a reference for one tenant. Honors the tenant's tombstones. Returns true when linked. */
export async function linkHitToTenant(slug: string, matchId: number, startTime: string | null): Promise<boolean> {
  if (await redis.sismember(K.tHidden(slug), String(matchId))) return false;
  await redis.zadd(K.tHits(slug), epoch(startTime), String(matchId));
  return true;
}

// ---- status ----

export async function writeStatus(s: Status): Promise<void> {
  await setJson(K.status, s);
}

export async function disconnect(): Promise<void> {
  await redis.quit();
}
