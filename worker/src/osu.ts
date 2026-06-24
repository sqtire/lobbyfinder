import { config } from "./config.js";
import { RateLimiter, sleep } from "./ratelimit.js";
import type { MatchInfo, MatchGame, MatchDetail } from "./types.js";

const OAUTH_URL = "https://osu.ppy.sh/oauth/token";
const API_BASE = "https://osu.ppy.sh/api/v2";

const limiter = new RateLimiter(config.minIntervalMs);
let token: { value: string; expiresAt: number } | null = null;

export function tokenExpiresAtIso(): string | null {
  return token ? new Date(token.expiresAt).toISOString() : null;
}

async function fetchToken(): Promise<void> {
  await limiter.acquire();
  const body = new URLSearchParams({
    client_id: config.osuClientId,
    client_secret: config.osuClientSecret,
    grant_type: "client_credentials",
    scope: "public",
  });
  const res = await withTimeout((signal) =>
    fetch(OAUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      signal,
    })
  );
  if (!res.ok) throw new Error(`OAuth token failed: ${res.status} ${await safeText(res)}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000 };
}

async function getToken(): Promise<string> {
  if (!token || Date.now() >= token.expiresAt) await fetchToken();
  return token!.value;
}

async function apiGet<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(API_BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));

  let attempt = 0;
  let refreshed401 = false;
  while (true) {
    attempt++;
    await limiter.acquire();
    const bearer = await getToken();

    let res: Response;
    try {
      res = await withTimeout((signal) =>
        fetch(url, {
          headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json", "Content-Type": "application/json" },
          signal,
        })
      );
    } catch (err) {
      if (attempt > config.maxRetries) throw err;
      await sleep(backoff(attempt));
      continue;
    }

    if (res.ok) return (await res.json()) as T;

    if (res.status === 401 && !refreshed401) {
      refreshed401 = true;
      token = null;
      continue;
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff(attempt));
      if (attempt > config.maxRetries + 3) throw new Error(`Persistent 429 on ${path}`);
      continue;
    }
    if (res.status >= 500 && attempt <= config.maxRetries) {
      await sleep(backoff(attempt));
      continue;
    }
    throw new Error(`GET ${path} failed: ${res.status} ${await safeText(res)}`);
  }
}

function backoff(attempt: number): number {
  const base = Math.min(30000, 1000 * 2 ** (attempt - 1));
  return base / 2 + Math.random() * (base / 2);
}
async function withTimeout(fn: (s: AbortSignal) => Promise<Response>): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), config.requestTimeoutMs);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}
async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<no body>";
  }
}

// ---------------------------------------------------------------------------
// Feed: GET /matches  (we page ASCENDING from a cursor so the live/rescan
// fronts can walk forward by id and advance their watermark monotonically.)
//
// NOTE TO VERIFY AGAINST LIVE API: the matches endpoint is documented only via
// wrappers. We request sort=id_asc with cursor[match_id]=<id> and read the
// returned cursor for continuation, falling back to max(id) of the page. Range
// filtering by the caller keeps correctness even if cursor semantics differ.
// ---------------------------------------------------------------------------

export interface FeedPage {
  matches: MatchInfo[]; // ascending by id
  nextCursor: number | null; // pass back as cursorMatchId to continue
}

function parseMatch(m: any): MatchInfo {
  return {
    id: m.id,
    name: typeof m.name === "string" ? m.name : "",
    start_time: m.start_time ?? null,
    end_time: m.end_time ?? null,
  };
}

/** One ascending page of matches with id strictly greater than `cursorMatchId`. */
export async function feedPageAsc(cursorMatchId: number): Promise<FeedPage> {
  const raw = await apiGet<any>("/matches", {
    sort: "id_asc",
    limit: config.feedLimit,
    "cursor[match_id]": cursorMatchId,
  });
  const matches: MatchInfo[] = Array.isArray(raw?.matches)
    ? raw.matches.filter((m: any) => m && typeof m.id === "number").map(parseMatch)
    : [];
  matches.sort((a, b) => a.id - b.id);

  let nextCursor: number | null = null;
  if (raw?.cursor && typeof raw.cursor.match_id === "number") nextCursor = raw.cursor.match_id;
  else if (matches.length > 0) nextCursor = matches[matches.length - 1]!.id;
  if (matches.length === 0) nextCursor = null;

  return { matches, nextCursor };
}

/** The current newest match id (used to seed the live watermark on first run). */
export async function newestMatchId(): Promise<number | null> {
  const raw = await apiGet<any>("/matches", { sort: "id_desc", limit: 1 });
  const m = Array.isArray(raw?.matches) ? raw.matches.find((x: any) => typeof x?.id === "number") : null;
  return m ? m.id : null;
}

// ---------------------------------------------------------------------------
// Detail: GET /matches/{id}  — read EVERY game by paging events with before=.
// ---------------------------------------------------------------------------

export async function getMatchDetail(matchId: number): Promise<MatchDetail> {
  const seen = new Set<number>();
  const games = new Map<number, MatchGame>();
  let info: MatchInfo | null = null;
  let before: number | undefined;

  for (let page = 0; page < config.maxEventPages; page++) {
    const raw = await apiGet<any>(`/matches/${matchId}`, { limit: config.eventsPageLimit, before });
    if (!info && raw?.match) info = parseMatch(raw.match);

    const events: any[] = Array.isArray(raw?.events) ? raw.events : [];
    if (events.length === 0) break;

    let progressed = false;
    let minId = Infinity;
    for (const ev of events) {
      if (typeof ev?.id === "number") {
        minId = Math.min(minId, ev.id);
        if (!seen.has(ev.id)) {
          seen.add(ev.id);
          progressed = true;
        }
      }
      const g = ev?.game;
      if (g && typeof g.id === "number" && typeof g.beatmap_id === "number") games.set(g.id, normalizeGame(g));
    }

    if (!progressed) break;
    const firstEventId = typeof raw?.first_event_id === "number" ? raw.first_event_id : null;
    if (firstEventId !== null && minId <= firstEventId) break;
    if (!Number.isFinite(minId)) break;
    before = minId;
  }

  if (!info) info = { id: matchId, name: "", start_time: null, end_time: null };
  return { match: info, games: [...games.values()] };
}

function normalizeGame(g: any): MatchGame {
  const bm = g.beatmap ?? {};
  const set = bm.beatmapset ?? {};
  return {
    id: g.id,
    beatmap_id: g.beatmap_id,
    beatmapset_id: bm.beatmapset_id ?? set.id ?? null,
    title: set.title ?? null,
    version: bm.version ?? null,
    mode: g.mode ?? g.ruleset ?? null,
    scoring_type: g.scoring_type ?? null,
    team_type: g.team_type ?? null,
    mods: Array.isArray(g.mods)
      ? g.mods.map((m: any) => (typeof m === "string" ? m : m?.acronym)).filter((x: any): x is string => typeof x === "string")
      : [],
    start_time: g.start_time ?? null,
    end_time: g.end_time ?? null,
    scores_count: Array.isArray(g.scores) ? g.scores.length : 0,
  };
}
