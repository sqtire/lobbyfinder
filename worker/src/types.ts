/**
 * Loose types for the osu!api v2 fields we read (parsed defensively) plus our
 * own persisted records. These shapes are mirrored in web/lib/types.ts.
 */

// ---- osu! API ----

export interface MatchInfo {
  id: number;
  name: string;
  start_time: string | null;
  end_time: string | null; // null => lobby still open
}

export interface GameScore {
  user_id: number;
  score: number;
  accuracy: number; // 0..1 as returned by the API
  mods: string[];
  passed: boolean;
}

export interface MatchGame {
  id: number;
  beatmap_id: number;
  beatmapset_id?: number | null;
  title?: string | null;
  version?: string | null;
  mode?: string | null;
  scoring_type?: string | null;
  team_type?: string | null;
  mods: string[];
  start_time?: string | null;
  end_time?: string | null;
  scores_count: number;
  scores: GameScore[]; // one entry per score posted on this game
}

export interface MatchDetail {
  match: MatchInfo;
  games: MatchGame[];
  users: Record<number, string>; // user_id -> username, for the whole match
}

// ---- tenants (tournaments) — written by the web app, read by the worker ----

export interface Tenant {
  slug: string;
  name: string;
  owner_id: number; // osu! user id of the tournament owner
  pool: number[]; // beatmap (difficulty) ids
  enabled: boolean; // participate in live matching (union pool)
  start_day: string; // YYYY-MM-DD, default backfill start
  created_at: string;
  updated_at: string;
}

/** Site-wide switch (owner-only). Missing key => enabled. */
export interface GlobalConfig {
  enabled: boolean;
  updated_at: string;
}

// ---- owner-only API walks (the old "rescan") ----

export interface WalkState {
  id: string;
  from_id: number;
  to_id: number; // snapshot of the rolling cursor when requested
  cursor: number; // highest id processed so far (starts at from_id - 1)
  status: "queued" | "running" | "done" | "cancelled";
  processed: number;
  requested_at: string;
  requested_by: number | null; // osu! user id
  finished_at: string | null;
}

// ---- tenant backfills (index scan + detail fetch for hits) ----

export interface BackfillState {
  status: "queued" | "scanning" | "fetching" | "done" | "cancelled" | "error";
  from_day: string; // YYYY-MM-DD inclusive
  to_day: string; // YYYY-MM-DD inclusive
  requested_at: string;
  requested_by: number | null;
  started_at: string | null;
  finished_at: string | null;
  candidates: number; // index rows whose maps intersect the pool
  linked: number; // already-stored hits referenced without an API call
  to_fetch: number; // lobbies that needed a detail read
  fetched: number; // detail reads done so far
  tombstoned: number; // skipped because the tenant removed them
  uncovered_days: string[]; // days in range with no index bucket
  error: string | null;
}

// ---- rolling sweep ----

/**
 * Rolling-sweep position, persisted so restarts auto-resume. The cursor trails
 * the live edge by ~rollDelaySec: every match with id <= cursor has been read
 * once (at which point it had almost always already closed).
 */
export interface RollState {
  cursor: number; // highest match id processed by the rolling sweep
  initialized: boolean;
  started_at: string;
  index_from: number | null; // first match id the sweep indexed (coverage tracking)
  cursor_start: string | null; // start_time of the match at the cursor (survives restarts)
}

// ---- match index (global) ----

export interface DayStat {
  n: number; // indexed matches that day
  min_id: number;
  max_id: number;
}

export interface CoverageRange {
  from: number;
  to: number;
}

// ---- stored hits (global detail store; tenants hold references) ----

export interface HitGame {
  game_id: number;
  beatmap_id: number;
  beatmap_url: string;
  title: string | null;
  version: string | null;
  mods: string[];
  mode: string | null;
  scoring_type: string | null;
  team_type: string | null;
  played_at: string | null;
  scores_count: number;
  scores: GameScore[]; // per-player scores on this map (drives the Teams grid)
}

export interface PlayerStat {
  user_id: number;
  username: string;
  maps_played: number; // games in this lobby where the player posted a score
}

export interface Hit {
  match_id: number;
  match_name: string;
  match_url: string;
  start_time: string | null;
  end_time: string | null;
  still_open: boolean;
  partial: boolean; // true => lobby was still open when read (history may be incomplete)
  found_at: string;
  source: "auto" | "rescan" | "walk" | "backfill";
  all_games: boolean; // true => games holds EVERY game (tenants filter to their pool at read time)
  games: HitGame[];
  players: PlayerStat[]; // everyone active in the lobby (all maps), most-active first
}

/** Telemetry for the public health panel. */
export interface Status {
  updated_at: string;
  enabled: boolean; // global switch
  tenants_total: number;
  tenants_enabled: number;
  union_pool_size: number;
  roll_cursor: number; // match id the rolling sweep has processed up to
  newest_seen_id: number | null; // live edge (periodic probe)
  cursor_start_time: string | null; // start_time of the match at the cursor
  coverage_delay_seconds: number | null; // age of the lobby at the cursor (~target delay when healthy)
  target_delay_seconds: number; // configured rollDelaySec
  behind_seconds: number | null; // how far the cursor lags BEHIND the target boundary (0 = on schedule)
  parked: boolean; // sweep is sitting at the boundary, waiting for lobbies to age/close
  on_schedule: boolean; // coverage delay is at/near target (not falling further behind)
  processed_total: number;
  hits_total: number; // stored hits (global)
  token_expires_at: string | null;
  index: {
    retention_days: number;
    days: number; // day buckets present
    oldest_day: string | null;
    newest_day: string | null;
    matches: number; // indexed matches across all buckets
    coverage: CoverageRange[]; // match-id ranges the index covers
  };
  walk: {
    active: boolean;
    status: WalkState["status"] | "idle";
    id: string | null;
    from_id: number | null;
    to_id: number | null;
    cursor: number | null;
    processed: number;
    remaining: number;
    queued: number; // walks waiting behind the active one
  };
  backfill: {
    active_slug: string | null;
    status: BackfillState["status"] | "idle";
    fetched: number;
    to_fetch: number;
    queued: number; // tenants waiting
  };
  last_error: string | null;
}
