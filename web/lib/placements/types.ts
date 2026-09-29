/**
 * Final-placements generator — shared types.
 *
 * Client bundles import this file, so it must stay free of node/redis/exceljs
 * imports. Everything the engine, the job runner, the API and the panel agree
 * on lives here.
 */

/** Tiebreak: Φ(z) average (consistency), raw z average, or Zipf placement average (1/rank of the best adjusted score per slot). */
export type ValueMode = "phi" | "z" | "zipf";
export type MapWeighting = "per_play" | "per_map";

export interface PlacementsSettings {
  /** Tournament name used in titles / the workbook. */
  title: string;
  /** Link-viewable Google Sheet (the referee sheet). */
  sheet_url: string;
  /** Tab that holds the chronological schedule (mp links, stage, first-to). */
  sheet_tab: string;
  /** Uploaded instead of linked: the schedule tab as a string table (read server-side from the .xlsx). */
  schedule_rows: string[][] | null;
  /** File name of the upload, for display. */
  schedule_file: string | null;
  /** Manual mappool input — see lib/placements/pool.ts for the format. */
  pool_text: string;
  /** Score multipliers (normalization, e.g. DA/EZ) — see lib/placements/multipliers.ts. Applied to every stat. */
  multipliers_text: string;
  /** Stage names (as written in the sheet) to include; empty = every stage with a played match. */
  stages: string[];
  /** k in ZAdj = (Σ value + k·neutral) / (n + k). 0 = plain average. */
  prior_maps: number;
  /** A map needs at least this many counted plays (and a non-zero spread) before its plays are rated. */
  min_plays: number;
  /** Tiebreak value: Φ(z) or z per play, or Zipf 1/placement per slot (best adjusted score). */
  value_mode: ValueMode;
  /** Φ(z)/z only: average over every counted play, or average per unique map first (Zipf is always per map). */
  map_weighting: MapWeighting;
  /** Include failed scores (lazer submits them with passed=false). */
  count_failed: boolean;
  /** Count maps played inside the lobby of a match the sheet records as a forfeit. */
  forfeit_lobby_maps: boolean;
  /** Playlist-item / game ids to ignore (typed after reviewing the Games tab). */
  excluded_items: number[];
  /**
   * Multiplier applied to scores set on a lower-tier difficulty (2nd+ id on a pool line) INSIDE the
   * tiebreak only (AEROLS: 0.95). Every visible stat — leaderboards, mappool stats, grids — uses raw scores.
   */
  lower_multiplier: number;
}

export const DEFAULT_PLACEMENTS_SETTINGS: PlacementsSettings = {
  title: "",
  sheet_url: "",
  sheet_tab: "Chrono Schedule",
  schedule_rows: null,
  schedule_file: null,
  pool_text: "",
  multipliers_text: "",
  stages: [],
  prior_maps: 2,
  min_plays: 3,
  value_mode: "phi",
  map_weighting: "per_play",
  count_failed: true,
  forfeit_lobby_maps: true,
  excluded_items: [],
  lower_multiplier: 0.95,
};

// ---- schedule (parsed from the sheet) --------------------------------------

export type RoomKind = "lazer" | "legacy";

export interface RoomRef {
  kind: RoomKind;
  id: number;
  url: string;
}

export type SheetOutcome = "red" | "blue" | "tie" | "double_forfeit" | "unplayed";

export interface ScheduleRow {
  row: number; // 1-based row in the tab, for error messages
  match_id: string; // the sheet's own match number, if any
  stage: string;
  date: string | null;
  red: string;
  blue: string;
  /** osu! user ids from profile links on the name cells, when the sheet has them — preferred over name matching. */
  red_id: number | null;
  blue_id: number | null;
  red_score: number | null; // -1 = forfeit
  blue_score: number | null;
  first_to: number | null;
  rooms: RoomRef[];
  outcome: SheetOutcome;
  forfeit: "red" | "blue" | "both" | null;
}

export interface ScheduleParse {
  rows: ScheduleRow[];
  header_row: number;
  columns: Record<string, number>;
  warnings: string[];
}

// ---- score multipliers (manual input) ---------------------------------------

export interface MultRule {
  stage: string | null; // null = every stage
  label: string | null; // null = every slot ("*")
  tier: number | null; // 0 = T1, 1 = T2; null = any difficulty
  mods: string[]; // required mods (sorted), e.g. ["EZ"]
  factor: number;
  line: number;
  text: string;
}

// ---- pool (manual input) ----------------------------------------------------

export interface PoolMap {
  beatmap_id: number;
  label: string; // slot label, e.g. "NM1", "HD2", "TB" — may repeat (tiers/freestyle)
  stage: string | null; // null = every stage
  is_tb: boolean;
  order: number;
  /** 0 = the first id on the line (upper / Tier 1 difficulty); 1+ = lower tiers, in the order listed. */
  tier: number;
  /** Slot key: "<stage or *>|<label>" — every tier of a slot shares it. */
  slot: string;
}

export interface PoolParse {
  maps: PoolMap[];
  warnings: string[];
}

// ---- room data (normalized from the osu! API, cached in Redis) -------------

export interface RoomScore {
  user_id: number;
  beatmap_id: number; // the difficulty this user actually played (freestyle)
  score: number;
  accuracy: number; // 0..1
  max_combo: number | null;
  mods: string[];
  passed: boolean;
}

export interface RoomGame {
  item_id: number; // playlist item id (lazer) or game id (legacy)
  order: number; // 0-based position in the room
  beatmap_id: number; // host-selected difficulty
  completed: boolean;
  aborted: boolean;
  started_at: string | null;
  ended_at: string | null;
  mods: string[]; // required mods of the item
  freestyle: boolean;
  scores: RoomScore[];
}

export interface BeatmapMeta {
  id: number;
  beatmapset_id: number | null;
  artist: string | null;
  title: string | null;
  version: string | null;
  creator: string | null;
  difficulty_rating: number | null;
}

export interface RoomData {
  kind: RoomKind;
  id: number;
  url: string;
  name: string;
  started_at: string | null;
  ended_at: string | null;
  users: Record<string, { id: number; username: string; country_code: string | null }>;
  games: RoomGame[];
  beatmaps: Record<string, BeatmapMeta>;
  fetched_at: string;
}

// ---- engine output ----------------------------------------------------------

export interface PlayerRef {
  key: string; // "u:<id>" or "n:<normalized name>"
  user_id: number | null;
  name: string;
}

export type GameStatus = "counted" | "excluded";

export interface MatchGame {
  room_id: number;
  room_kind: RoomKind;
  item_id: number;
  order: number; // 1-based across the match
  beatmap_id: number; // item (host-selected)
  label: string | null; // pool slot label, if in pool
  red: RoomScore | null; // raw, as the lobby recorded it
  blue: RoomScore | null;
  red_norm: number | null; // score × score multiplier
  blue_norm: number | null;
  raw_winner: "red" | "blue" | "tie" | null; // by normalized score
  status: GameStatus;
  reason: string | null;
  score_after: [number, number] | null; // running lobby score after this game (raw comparison)
}

export interface MatchResult {
  match_id: string;
  stage: string;
  date: string | null;
  first_to: number | null;
  red: PlayerRef;
  blue: PlayerRef;
  sheet_score: [number, number] | null;
  outcome: SheetOutcome;
  forfeit: "red" | "blue" | "both" | null;
  points: [number, number];
  rooms: { ref: RoomRef; ok: boolean; error: string | null; name: string | null }[];
  games: MatchGame[];
  counted: number;
  lobby_score: [number, number] | null; // raw-score reconstruction of the counted games
  notes: string[];
}

export interface PlayerPlay {
  player_key: string;
  beatmap_id: number;
  label: string;
  /** Slot key — the distribution the play is rated in (tiers pooled). */
  map_key: string;
  tier: number;
  multiplier: number;
  /** score × multiplier — used by the tiebreak only. */
  adjusted: number;
  /** Normalized score (raw × score multiplier) — what every stat uses. */
  score: number;
  raw_score: number;
  score_multiplier: number;
  accuracy: number;
  max_combo: number | null;
  mods: string[];
  passed: boolean;
  match_id: string;
  stage: string;
  opponent_key: string;
  room_id: number;
  room_kind: RoomKind;
  item_id: number;
  won: boolean | null; // raw comparison vs opponent (null = tie)
  rated: boolean;
  z: number | null;
  phi: number | null;
}

export interface BestScore {
  player: PlayerRef;
  score: number; // normalized
  raw_score: number;
  score_multiplier: number;
  beatmap_id: number;
  tier: number;
  accuracy: number;
  max_combo: number | null;
  mods: string[];
  passed: boolean;
  match_id: string;
  stage: string;
  room_id: number;
  room_kind: RoomKind;
}

/** One difficulty of a slot, with its own raw stats (the Mappool Stats rows). */
export interface MapDifficulty {
  beatmap_id: number;
  title: string; // "Artist - Title [Diff]" or "#id"
  url: string;
  tier: number; // 0 = upper (T1), 1+ = lower
  multiplier: number; // what the tiebreak applies to this difficulty's scores
  /** Score multipliers that apply to this difficulty, e.g. "×1.176 · EZ ×1.25" ("" = none). */
  score_multipliers: string;
  difficulty_rating: number | null;
  plays: number;
  mean: number | null; // raw
  median: number | null; // raw
  avg_acc: number | null;
  best: BestScore | null; // raw
}

/** One row per pool slot (every tier pooled). All visible stats are raw; the tiebreak block is adjusted. */
export interface MapStatRow {
  key: string;
  beatmap_id: number; // the upper (tier 0) difficulty, for links
  label: string;
  title: string; // upper difficulty's title (see beatmaps for every tier)
  url: string;
  beatmaps: MapDifficulty[];
  plays: number;
  players: number; // distinct players with a counted play
  mean: number | null; // raw, over every counted play in the slot
  median: number | null;
  avg_acc: number | null;
  best: BestScore | null; // raw, across the slot
  /** Tiebreak distribution (adjusted scores): rated when the slot has ≥ min_plays counted plays and non-zero spread. */
  tiebreak: { rated: boolean; mean_adj: number | null; stdev_adj: number | null };
}

export interface StageResult {
  stage: string;
  opponent: PlayerRef | null;
  result: "W" | "L" | "T" | "FFW" | "FFL" | "FF" | "—";
  score: string; // "4–2", "FF", ...
  match_id: string;
}

export interface PlacementRow {
  rank: number;
  player: PlayerRef;
  points: number;
  matches: number; // matches with a sheet result (including forfeits)
  wins: number;
  losses: number;
  forfeit_wins: number;
  forfeit_losses: number;
  performance: number | null; // ZAdj (the tiebreak)
  avg_value: number | null; // unshrunk average of the chosen value
  avg_phi: number | null;
  avg_z: number | null;
  rated_plays: number;
  counted_plays: number;
  unique_maps: number;
  map_wins: number;
  map_losses: number;
  map_ties: number;
  buchholz: number; // sum of opponents' points
  avg_score: number | null;
  avg_acc: number | null;
  best: { beatmap_id: number; label: string; score: number; match_id: string; room_id: number; room_kind: RoomKind } | null; // raw
  /** Slots where the player's best raw score is #1 (ties count). */
  top_scores: number;
  /** Average raw placement over the slots the player played. */
  avg_placement: number | null;
  /** Total number of slots in scope (for "played / total"). */
  slots_total: number;
  stages: StageResult[];
}

export interface LeaderboardEntry {
  rank: number; // by normalized score (ties share)
  player: PlayerRef;
  score: number; // normalized
  raw_score: number;
  score_multiplier: number;
  beatmap_id: number;
  tier: number;
  accuracy: number;
  max_combo: number | null;
  mods: string[];
  passed: boolean;
  match_id: string;
  stage: string;
  room_id: number;
  room_kind: RoomKind;
}

/** Best play of a player on a slot. Visible part is raw; the tiebreak part is what the ranking used. */
export interface GridCell {
  score: number; // best raw score
  beatmap_id: number;
  tier: number;
  placement: number; // rank among every player's best RAW score on the slot (ties share)
  plays: number;
  tiebreak: {
    adjusted: number; // best adjusted score
    placement: number; // rank among best ADJUSTED scores (Zipf uses this)
    value: number | null; // this slot's contribution to the player's tiebreak (null when the slot is unrated)
  };
}

export interface PlacementsResult {
  generated_at: string;
  title: string;
  settings: Omit<PlacementsSettings, "pool_text" | "schedule_rows">;
  stages: string[];
  formula: string[];
  placements: PlacementRow[];
  maps: MapStatRow[];
  leaderboards: Record<string, LeaderboardEntry[]>; // slot key -> plays sorted by raw score
  grid: { players: PlayerRef[]; cells: Record<string, Record<string, GridCell | null>> }; // player key -> slot key -> cell
  /** Human-readable name of the tiebreak in use ("Zipf placement average", …). */
  tiebreak_label: string;
  /** Parsed score-multiplier rules in effect. */
  score_rules: MultRule[];
  matches: MatchResult[];
  plays: PlayerPlay[];
  notes: string[];
  counts: { matches: number; rooms: number; games_counted: number; games_excluded: number; players: number };
}

// ---- job ---------------------------------------------------------------------

export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface JobProgress {
  phase: string;
  done: number;
  total: number;
  message: string;
}

export interface PlacementsJob {
  id: string;
  status: JobStatus;
  title: string;
  requested_by: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
  progress: JobProgress;
  settings: PlacementsSettings;
  error: string | null;
  has_result: boolean;
}

export interface JobSummary {
  id: string;
  status: JobStatus;
  title: string;
  created_at: string;
  finished_at: string | null;
  progress: JobProgress;
  error: string | null;
}

export interface PreviewResponse {
  schedule: {
    header_row: number;
    stages: { stage: string; matches: number; played: number; forfeits: number; unplayed: number; with_rooms: number; first_to: number[] }[];
    total_rows: number;
    rooms: number;
    lazer_rooms: number;
    legacy_matches: number;
    warnings: string[];
  };
  pool: { maps: PoolMap[]; warnings: string[] };
  multipliers: { rules: MultRule[]; warnings: string[] };
}
