/**
 * osu! API v2 access for the placements generator (web service side).
 *
 * The scanner worker keeps the site's one ≤1 req/s limiter; this module is a
 * second, slower client (default one request every 1.5 s, PLACEMENTS_OSU_INTERVAL_MS)
 * used only by an owner-started job, and every closed lobby it reads is cached
 * in Redis so a re-run never touches the API for the same room again.
 *
 * Lazer rooms: `GET /rooms/{id}/events` (realtime rooms only) returns the
 * playlist items *with their scores* — one request per ~100 events, so a whole
 * 1v1 match is usually a single request. Scores carry their own beatmap_id,
 * which is how freestyle/tier picks are resolved.
 * Legacy lobbies: `GET /matches/{id}` paged with `before`, as the worker does.
 */

import type { BeatmapMeta, RoomData, RoomGame, RoomKind, RoomScore } from "./types";
import { cacheBeatmaps, cacheRoom, getCachedBeatmaps, getCachedRoom } from "./store";

// PLACEMENTS_OSU_* overrides exist for local testing against a mock API only.
const OAUTH_URL = process.env.PLACEMENTS_OSU_OAUTH_URL || "https://osu.ppy.sh/oauth/token";
const API_BASE = process.env.PLACEMENTS_OSU_API_BASE || "https://osu.ppy.sh/api/v2";
const API_VERSION = "20240529"; // ≥ 20220705 → non-legacy score format (total_score, mods as {acronym})
const TIMEOUT_MS = 20000;
const MAX_RETRIES = 4;
const MAX_PAGES = 60;

// ---- pacing -----------------------------------------------------------------

class RateLimiter {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly minIntervalMs: number) {}
  acquire(): Promise<void> {
    const wait = this.chain.then(async () => {
      const delay = this.minIntervalMs - (Date.now() - this.last);
      if (delay > 0) await sleep(delay);
      this.last = Date.now();
    });
    this.chain = wait.then(
      () => undefined,
      () => undefined
    );
    return wait;
  }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const g = globalThis as unknown as { __plcLimiter?: RateLimiter; __plcToken?: { value: string; expiresAt: number } | null };
function limiter(): RateLimiter {
  if (!g.__plcLimiter) g.__plcLimiter = new RateLimiter(Number(process.env.PLACEMENTS_OSU_INTERVAL_MS) || 1500);
  return g.__plcLimiter;
}

export class OsuApiError extends Error {
  constructor(message: string, public readonly status: number | null) {
    super(message);
  }
}

// ---- auth -------------------------------------------------------------------

function creds(): { id: string; secret: string } {
  const id = process.env.OSU_CLIENT_ID;
  const secret = process.env.OSU_CLIENT_SECRET;
  if (!id || !secret) throw new OsuApiError("OSU_CLIENT_ID / OSU_CLIENT_SECRET are not set on the web service", null);
  return { id, secret };
}

async function fetchToken(): Promise<void> {
  const { id, secret } = creds();
  await limiter().acquire();
  const body = new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials", scope: "public" });
  const res = await withTimeout((signal) =>
    fetch(OAUTH_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body, signal })
  );
  if (!res.ok) throw new OsuApiError(`osu! OAuth token failed (${res.status})`, res.status);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  g.__plcToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000 };
}
async function token(): Promise<string> {
  if (!g.__plcToken || Date.now() >= g.__plcToken.expiresAt) await fetchToken();
  return g.__plcToken!.value;
}

async function withTimeout(fn: (s: AbortSignal) => Promise<Response>): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

type Query = Record<string, string | number | undefined | (string | number)[]>;
async function apiGet<T>(path: string, query?: Query): Promise<T> {
  const url = new URL(API_BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x));
      else url.searchParams.set(k, String(v));
    }
  }
  let attempt = 0;
  let refreshed = false;
  while (true) {
    attempt++;
    await limiter().acquire();
    const bearer = await token();
    let res: Response;
    try {
      res = await withTimeout((signal) =>
        fetch(url, { headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json", "x-api-version": API_VERSION }, signal })
      );
    } catch (err) {
      if (attempt > MAX_RETRIES) throw new OsuApiError(`osu! request failed: ${(err as Error).message}`, null);
      await sleep(backoff(attempt));
      continue;
    }
    if (res.ok) return (await res.json()) as T;
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      g.__plcToken = null;
      continue;
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff(attempt));
      if (attempt > MAX_RETRIES + 3) throw new OsuApiError("osu! keeps rate-limiting the request (429)", 429);
      continue;
    }
    if (res.status >= 500 && attempt <= MAX_RETRIES) {
      await sleep(backoff(attempt));
      continue;
    }
    if (res.status === 404) throw new OsuApiError("not found (404)", 404);
    throw new OsuApiError(`osu! returned ${res.status}`, res.status);
  }
}
const backoff = (attempt: number) => {
  const base = Math.min(20000, 1000 * 2 ** (attempt - 1));
  return base / 2 + Math.random() * (base / 2);
};

// ---- normalization helpers ----------------------------------------------------

function modAcronyms(mods: unknown): string[] {
  if (!Array.isArray(mods)) return [];
  return mods.map((m: any) => (typeof m === "string" ? m : m?.acronym)).filter((x: unknown): x is string => typeof x === "string");
}

function normalizeScore(s: any, fallbackBeatmap: number): RoomScore | null {
  if (!s || typeof s.user_id !== "number") return null;
  const score = typeof s.total_score === "number" ? s.total_score : typeof s.score === "number" ? s.score : 0;
  const passed = typeof s.passed === "boolean" ? s.passed : typeof s?.match?.pass === "boolean" ? s.match.pass : true;
  return {
    user_id: s.user_id,
    beatmap_id: typeof s.beatmap_id === "number" && s.beatmap_id > 0 ? s.beatmap_id : fallbackBeatmap,
    score,
    accuracy: typeof s.accuracy === "number" ? s.accuracy : 0,
    max_combo: typeof s.max_combo === "number" ? s.max_combo : null,
    mods: modAcronyms(s.mods),
    passed,
  };
}

function metaFromBeatmap(b: any, set: any): BeatmapMeta | null {
  if (!b || typeof b.id !== "number") return null;
  const s = set ?? b.beatmapset ?? {};
  return {
    id: b.id,
    beatmapset_id: typeof b.beatmapset_id === "number" ? b.beatmapset_id : typeof s.id === "number" ? s.id : null,
    artist: typeof s.artist === "string" ? s.artist : null,
    title: typeof s.title === "string" ? s.title : null,
    version: typeof b.version === "string" ? b.version : null,
    creator: typeof s.creator === "string" ? s.creator : null,
    difficulty_rating: typeof b.difficulty_rating === "number" ? b.difficulty_rating : null,
  };
}

// ---- lazer rooms ---------------------------------------------------------------

async function fetchLazerRoom(id: number): Promise<RoomData> {
  const items = new Map<number, any>();
  const users = new Map<number, { id: number; username: string; country_code: string | null }>();
  const beatmaps = new Map<number, any>();
  const beatmapsets = new Map<number, any>();
  const completed = new Set<number>();
  const aborted = new Set<number>();
  const firstEvent = new Map<number, number>(); // item id -> smallest event id that referenced it
  const seenEvents = new Set<number>();
  let room: any = null;
  let before: number | undefined;
  let firstEventId: number | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const raw = await apiGet<any>(`/rooms/${id}/events`, { limit: 101, before });
    if (!room && raw?.room) room = raw.room;
    if (typeof raw?.first_event_id === "number") firstEventId = raw.first_event_id;
    for (const u of raw?.users ?? []) if (u && typeof u.id === "number") users.set(u.id, { id: u.id, username: String(u.username ?? `user ${u.id}`), country_code: u.country_code ?? null });
    for (const b of raw?.beatmaps ?? []) if (b && typeof b.id === "number") beatmaps.set(b.id, b);
    for (const s of raw?.beatmapsets ?? []) if (s && typeof s.id === "number") beatmapsets.set(s.id, s);
    for (const it of raw?.playlist_items ?? []) if (it && typeof it.id === "number" && !items.has(it.id)) items.set(it.id, it);

    const events: any[] = Array.isArray(raw?.events) ? raw.events : [];
    if (events.length === 0) break;
    let minId = Infinity;
    let progressed = false;
    for (const ev of events) {
      if (typeof ev?.id !== "number") continue;
      minId = Math.min(minId, ev.id);
      if (seenEvents.has(ev.id)) continue;
      seenEvents.add(ev.id);
      progressed = true;
      const pid = ev.playlist_item_id;
      if (typeof pid === "number") {
        if (ev.event_type === "game_completed") completed.add(pid);
        if (ev.event_type === "game_aborted") aborted.add(pid);
        if (ev.event_type === "game_started" || ev.event_type === "game_completed" || ev.event_type === "game_aborted") {
          const cur = firstEvent.get(pid);
          if (cur === undefined || ev.id < cur) firstEvent.set(pid, ev.id);
        }
      }
    }
    if (!progressed || !Number.isFinite(minId)) break;
    if (firstEventId !== null && minId <= firstEventId) break;
    before = minId;
  }

  if (!room) throw new OsuApiError("room has no data (is it a realtime lobby?)", null);

  const games: RoomGame[] = [...items.values()]
    .map((it) => ({
      item: it,
      key: firstEvent.get(it.id) ?? Number.MAX_SAFE_INTEGER,
      order: typeof it.playlist_order === "number" ? it.playlist_order : 0,
    }))
    .sort((a, b) => a.key - b.key || a.order - b.order || a.item.id - b.item.id)
    .map(({ item }, i) => {
      const bid = typeof item.beatmap_id === "number" ? item.beatmap_id : 0;
      const byUser = new Map<number, RoomScore>();
      for (const s of item.scores ?? []) {
        const n = normalizeScore(s, bid);
        if (n) byUser.set(n.user_id, n); // last one wins (one score per user per item in realtime)
      }
      return {
        item_id: item.id,
        order: i,
        beatmap_id: bid,
        completed: completed.has(item.id) || (byUser.size > 0 && item.expired === true && !aborted.has(item.id)),
        aborted: aborted.has(item.id),
        started_at: item?.details?.started_at ?? item.created_at ?? null,
        ended_at: item.played_at ?? null,
        mods: modAcronyms(item.required_mods),
        freestyle: !!item.freestyle,
        scores: [...byUser.values()],
      };
    });

  const metas: Record<string, BeatmapMeta> = {};
  for (const b of beatmaps.values()) {
    const m = metaFromBeatmap(b, beatmapsets.get(b.beatmapset_id));
    if (m) metas[String(m.id)] = m;
  }
  return {
    kind: "lazer",
    id,
    url: `https://osu.ppy.sh/multiplayer/rooms/${id}`,
    name: String(room.name ?? ""),
    started_at: room.starts_at ?? null,
    ended_at: room.ends_at ?? null,
    users: Object.fromEntries([...users.values()].map((u) => [String(u.id), u])),
    games,
    beatmaps: metas,
    fetched_at: new Date().toISOString(),
  };
}

// ---- legacy matches ------------------------------------------------------------

async function fetchLegacyMatch(id: number): Promise<RoomData> {
  const games = new Map<number, RoomGame>();
  const users = new Map<number, { id: number; username: string; country_code: string | null }>();
  const metas: Record<string, BeatmapMeta> = {};
  const seen = new Set<number>();
  let info: any = null;
  let before: number | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const raw = await apiGet<any>(`/matches/${id}`, { limit: 100, before });
    if (!info && raw?.match) info = raw.match;
    for (const u of raw?.users ?? []) if (u && typeof u.id === "number") users.set(u.id, { id: u.id, username: String(u.username ?? `user ${u.id}`), country_code: u.country_code ?? null });
    const events: any[] = Array.isArray(raw?.events) ? raw.events : [];
    if (events.length === 0) break;
    let minId = Infinity;
    let progressed = false;
    for (const ev of events) {
      if (typeof ev?.id === "number") {
        minId = Math.min(minId, ev.id);
        if (!seen.has(ev.id)) {
          seen.add(ev.id);
          progressed = true;
        }
      }
      const gm = ev?.game;
      if (gm && typeof gm.id === "number" && typeof gm.beatmap_id === "number") {
        const byUser = new Map<number, RoomScore>();
        for (const s of gm.scores ?? []) {
          const n = normalizeScore(s, gm.beatmap_id);
          if (n) byUser.set(n.user_id, n);
        }
        games.set(gm.id, {
          item_id: gm.id,
          order: 0,
          beatmap_id: gm.beatmap_id,
          completed: gm.end_time != null,
          aborted: gm.end_time == null,
          started_at: gm.start_time ?? null,
          ended_at: gm.end_time ?? null,
          mods: modAcronyms(gm.mods),
          freestyle: false,
          scores: [...byUser.values()],
        });
        const m = metaFromBeatmap({ ...(gm.beatmap ?? {}), id: gm.beatmap_id }, gm.beatmap?.beatmapset);
        if (m) metas[String(m.id)] = m;
      }
    }
    if (!progressed || !Number.isFinite(minId)) break;
    const first = typeof raw?.first_event_id === "number" ? raw.first_event_id : null;
    if (first !== null && minId <= first) break;
    before = minId;
  }
  const ordered = [...games.values()].sort((a, b) => a.item_id - b.item_id).map((g, i) => ({ ...g, order: i }));
  return {
    kind: "legacy",
    id,
    url: `https://osu.ppy.sh/community/matches/${id}`,
    name: String(info?.name ?? ""),
    started_at: info?.start_time ?? null,
    ended_at: info?.end_time ?? null,
    users: Object.fromEntries([...users.values()].map((u) => [String(u.id), u])),
    games: ordered,
    beatmaps: metas,
    fetched_at: new Date().toISOString(),
  };
}

// ---- public API -------------------------------------------------------------------

/** Read one lobby (Redis cache first). Open lobbies are returned but not cached. */
export async function loadRoom(kind: RoomKind, id: number, opts?: { force?: boolean }): Promise<{ room: RoomData; cached: boolean }> {
  if (!opts?.force) {
    const cached = await getCachedRoom(kind, id);
    if (cached) return { room: cached, cached: true };
  }
  const room = kind === "lazer" ? await fetchLazerRoom(id) : await fetchLegacyMatch(id);
  if (room.ended_at) await cacheRoom(room);
  return { room, cached: false };
}

/** Beatmap metadata for ids we haven't seen inside any lobby (Redis cache, then /beatmaps?ids[]). */
export async function loadBeatmaps(ids: number[]): Promise<Map<number, BeatmapMeta>> {
  const unique = [...new Set(ids)];
  const out = await getCachedBeatmaps(unique);
  const missing = unique.filter((id) => !out.has(id));
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    let raw: any;
    try {
      raw = await apiGet<any>("/beatmaps", { "ids[]": chunk });
    } catch (e) {
      console.warn("[placements] beatmap lookup failed:", (e as Error).message);
      continue;
    }
    const metas: BeatmapMeta[] = [];
    for (const b of raw?.beatmaps ?? []) {
      const m = metaFromBeatmap(b, b?.beatmapset);
      if (m) {
        out.set(m.id, m);
        metas.push(m);
      }
    }
    await cacheBeatmaps(metas);
  }
  return out;
}
