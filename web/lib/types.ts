export interface AppConfig {
  target_beatmap_ids: number[];
  enabled: boolean;
  updated_at: string;
}

export interface RescanStatus {
  active: boolean;
  status: "running" | "done" | "cancelled" | "idle";
  from_id: number | null;
  to_id: number | null;
  cursor: number | null;
  processed: number;
  remaining: number;
}

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
  rescan: RescanStatus;
  last_error: string | null;
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
  games: HitGame[];
}

export interface DataResponse {
  status: Status | null;
  config: AppConfig;
  hits: Hit[];
  authed: boolean;
}

export const MAX_POOL = 30;
