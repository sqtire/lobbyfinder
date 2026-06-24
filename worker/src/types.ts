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
  player_ids: number[]; // user_ids that posted a score on this game
}

export interface MatchDetail {
  match: MatchInfo;
  games: MatchGame[];
  users: Record<number, string>; // user_id -> username, for the whole match
}

// ---- our records (Redis) ----

/** Live-editable, written by the web app, read by the worker. */
export interface AppConfig {
  target_beatmap_ids: number[];
  enabled: boolean;
  updated_at: string;
}

export interface RescanState {
  from_id: number;
  to_id: number; // snapshot of the rolling cursor when the rescan was requested
  cursor: number; // highest id processed so far (starts at from_id - 1)
  status: "running" | "done" | "cancelled";
  processed: number;
  requested_at: string;
  finished_at: string | null;
}

/**
 * Rolling-sweep position, persisted so restarts auto-resume. The cursor trails
 * the live edge by ~rollDelaySec: every match with id <= cursor has been read
 * once (at which point it had almost always already closed).
 */
export interface RollState {
  cursor: number; // highest match id processed by the rolling sweep
  initialized: boolean;
  started_at: string;
}

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
  source: "auto" | "rescan"; // auto = rolling sweep, rescan = on-demand
  games: HitGame[]; // only the games whose beatmap_id is in the pool
  players: PlayerStat[]; // everyone active in the lobby (all maps), most-active first
}

/** Telemetry for the public health panel. */
export interface Status {
  updated_at: string;
  enabled: boolean;
  pool_size: number;
  roll_cursor: number; // match id the rolling sweep has processed up to
  newest_seen_id: number | null; // live edge (periodic probe)
  cursor_start_time: string | null; // start_time of the match at the cursor
  coverage_delay_seconds: number | null; // age of the lobby at the cursor (~target delay when healthy)
  target_delay_seconds: number; // configured rollDelaySec
  behind_seconds: number | null; // how far the cursor lags BEHIND the target boundary (0 = on schedule)
  parked: boolean; // sweep is sitting at the boundary, waiting for lobbies to age/close
  on_schedule: boolean; // coverage delay is at/near target (not falling further behind)
  processed_total: number;
  hits_total: number;
  token_expires_at: string | null;
  rescan: {
    active: boolean;
    status: RescanState["status"] | "idle";
    from_id: number | null;
    to_id: number | null;
    cursor: number | null;
    processed: number;
    remaining: number;
  };
  last_error: string | null;
}
