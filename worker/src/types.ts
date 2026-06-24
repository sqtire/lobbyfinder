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
}

export interface MatchDetail {
  match: MatchInfo;
  games: MatchGame[];
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
  to_id: number; // snapshot of live watermark when the rescan was requested
  cursor: number; // highest id processed so far (starts at from_id - 1)
  status: "running" | "done" | "cancelled";
  processed: number;
  requested_at: string;
  finished_at: string | null;
}

/** Live forward-scan position, persisted so restarts auto-resume. */
export interface LiveState {
  watermark: number; // highest match id fully processed by the live front
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

export interface Hit {
  match_id: number;
  match_name: string;
  match_url: string;
  start_time: string | null;
  end_time: string | null;
  still_open: boolean;
  found_at: string;
  source: "live" | "rescan";
  games: HitGame[]; // only the games whose beatmap_id is in the pool
}

/** Telemetry for the public health panel (watermark + health merged). */
export interface Status {
  updated_at: string;
  enabled: boolean;
  pool_size: number;
  live_watermark: number;
  newest_seen_id: number | null;
  last_processed_start_time: string | null;
  lag_seconds: number | null;
  caught_up: boolean;
  processed_total: number;
  hits_total: number;
  open_watched: number;
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
