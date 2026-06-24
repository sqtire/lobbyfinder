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
  roll_cursor: number;
  newest_seen_id: number | null;
  cursor_start_time: string | null;
  coverage_delay_seconds: number | null;
  target_delay_seconds: number;
  behind_seconds: number | null;
  parked: boolean;
  on_schedule: boolean;
  processed_total: number;
  hits_total: number;
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

export interface PlayerStat {
  user_id: number;
  username: string;
  maps_played: number;
}

export interface Hit {
  match_id: number;
  match_name: string;
  match_url: string;
  start_time: string | null;
  end_time: string | null;
  still_open: boolean;
  partial?: boolean;
  found_at: string;
  source: "auto" | "rescan" | "live"; // "live" kept for hits stored before the rolling rewrite
  games: HitGame[];
  players?: PlayerStat[]; // absent on hits stored before player capture was added
}

export interface DataResponse {
  status: Status | null;
  config: AppConfig;
  hits: Hit[];
  authed: boolean;
  hidden_count: number;
}

export const MAX_POOL = 30;
