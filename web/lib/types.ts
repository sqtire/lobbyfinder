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

export interface GameScore {
  user_id: number;
  score: number;
  accuracy: number; // 0..1
  mods: string[];
  passed: boolean;
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
  scores?: GameScore[]; // absent on hits stored before score capture was added
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

// ---- team roster (synced from a mainsheet) + Teams grid ----

export interface RosterPlayer {
  name: string;
  user_id: number | null; // null => matched by username against scraped data
}
export interface RosterTeam {
  name: string;
  players: RosterPlayer[];
}
export interface Roster {
  source_url: string;
  sheet_name: string;
  synced_at: string;
  teams: RosterTeam[];
}

export interface CellScore {
  score: number;
  accuracy: number; // 0..1
  mods: string[];
  passed: boolean;
  played_at: string | null;
  match_id: number;
  match_url: string;
}
export interface GridPlayer {
  name: string;
  user_id: number | null;
  matched: boolean; // resolved to a scraped user (by id or by name)
  by_name: boolean; // matched via username rather than a pinned id
  cells: (CellScore[] | null)[]; // aligned to maps[]; null/empty => Not Played
}
export interface GridTeam {
  name: string;
  players: GridPlayer[];
}
export interface TeamsGridData {
  maps: { beatmap_id: number; title: string | null; version: string | null; url: string }[];
  teams: GridTeam[];
  roster_synced_at: string | null;
  roster_source_url: string | null;
  generated_at: string;
}
