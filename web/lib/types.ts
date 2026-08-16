// Shapes shared with the worker (worker/src/types.ts) — keep in sync.

export interface Tenant {
  slug: string;
  name: string;
  owner_id: number; // osu! user id
  pool: number[]; // beatmap (difficulty) ids
  enabled: boolean; // participates in live matching
  start_day: string; // YYYY-MM-DD — default backfill start
  created_at: string;
  updated_at: string;
}

export interface GlobalConfig {
  enabled: boolean;
  updated_at: string;
}

export interface WalkState {
  id: string;
  from_id: number;
  to_id: number;
  cursor: number;
  status: "queued" | "running" | "done" | "cancelled";
  processed: number;
  requested_at: string;
  requested_by: number | null;
  finished_at: string | null;
}

export interface BackfillState {
  status: "queued" | "scanning" | "fetching" | "done" | "cancelled" | "error";
  from_day: string;
  to_day: string;
  requested_at: string;
  requested_by: number | null;
  started_at: string | null;
  finished_at: string | null;
  candidates: number;
  linked: number;
  to_fetch: number;
  fetched: number;
  tombstoned: number;
  uncovered_days: string[];
  error: string | null;
}

export interface CoverageRange {
  from: number;
  to: number;
}

export interface Status {
  updated_at: string;
  enabled: boolean;
  tenants_total: number;
  tenants_enabled: number;
  union_pool_size: number;
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
  index: {
    retention_days: number;
    days: number;
    oldest_day: string | null;
    newest_day: string | null;
    matches: number;
    coverage: CoverageRange[];
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
    queued: number;
  };
  backfill: {
    active_slug: string | null;
    status: BackfillState["status"] | "idle";
    fetched: number;
    to_fetch: number;
    queued: number;
  };
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
  source: "auto" | "rescan" | "walk" | "backfill" | "live";
  all_games?: boolean; // absent/false on legacy hits (games already filtered to the pool of the time)
  games: HitGame[]; // in tenant responses: only games on that tenant's current pool
  players?: PlayerStat[];
}

export const MAX_POOL = 30;

// ---- users, sessions, membership ----

export interface OsuUser {
  osu_id: number;
  username: string;
  avatar_url: string | null;
  country_code: string | null;
  first_login: string;
  last_login: string;
}

export type TenantRole = "owner" | "staff";

export interface SessionUser {
  osu_id: number;
  username: string;
  avatar_url: string | null;
  is_site_owner: boolean;
}

export interface TenantAccess {
  user: SessionUser | null;
  role: TenantRole | null; // explicit membership role
  can_edit: boolean; // pool, backfill, roster, lobby removal
  can_manage: boolean; // members, rename, delete
  is_site_owner: boolean;
}

export interface TenantSummary {
  slug: string;
  name: string;
  owner_id: number;
  owner_name: string | null;
  enabled: boolean;
  pool_size: number;
  hits: number;
  start_day: string;
  created_at: string;
  updated_at: string;
}

export interface MeResponse {
  user: SessionUser | null;
  memberships: { slug: string; name: string; role: TenantRole }[];
}

export interface TenantDataResponse {
  tenant: Tenant;
  status: Status | null;
  hits: Hit[];
  hits_total: number;
  hidden_count: number;
  backfill: BackfillState | null;
  backfill_position: number | null; // 1-based place in the queue while queued
  access: TenantAccess;
}

export interface OwnerStatusResponse {
  status: Status | null;
  global: GlobalConfig;
  walk: WalkState | null;
  walk_queue: WalkState[];
  coverage_requests: { slug: string; from_day: string; to_day: string; uncovered_days: string[]; at: string }[];
  tenants: TenantSummary[];
  legacy: { present: boolean; adopted_into: string | null };
}

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
