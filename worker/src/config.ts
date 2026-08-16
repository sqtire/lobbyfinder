/**
 * All worker tuning is env-driven so the same image runs unchanged on Railway.
 * NOTE: beatmap pools are NOT here — every tenant (tournament) keeps its own
 * pool in Redis (`mpf:t:<slug>`), edited live from the web app; the worker
 * matches every lobby against the UNION of enabled tenants' pools.
 */

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") throw new Error(`Missing required env var: ${name}`);
  return v.trim();
}
function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number, got "${v}"`);
  return n;
}
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

export const config = {
  // --- Storage: Railway Redis (the Redis plugin exposes REDIS_URL) ---
  redisUrl: req("REDIS_URL"),
  keyPrefix: process.env.KEY_PREFIX?.trim() || "mpf",

  // --- osu! API (register at https://osu.ppy.sh/home/account/edit#oauth) ---
  osuClientId: req("OSU_CLIENT_ID"),
  osuClientSecret: req("OSU_CLIENT_SECRET"),

  // --- Rate limiting (osu! ToU: <=1 req/sec, ALL requests, ALL fronts) ---
  minIntervalMs: num("OSU_MIN_INTERVAL_MS", 1100),

  // --- Pagination ---
  feedLimit: num("FEED_LIMIT", 50), // /matches page size used for discovery
  eventsPageLimit: num("EVENTS_PAGE_LIMIT", 100),
  maxEventPages: num("MAX_EVENT_PAGES", 50), // safety cap for huge auto-host lobbies

  // --- Rolling sweep (the primary scanner) ---------------------------------
  // Instead of scanning the live edge and re-polling open lobbies, we walk
  // forward but only PROCESS a match once it is at least this old. By then a
  // normal tournament lobby has closed, so a single read returns its full game
  // history. Results therefore lag real time by ~rollDelaySec (the tradeoff).
  rollDelaySec: num("ROLL_DELAY_SEC", 4 * 60 * 60), // 4h default
  // If a lobby is STILL open when it crosses the delay boundary (auto-host
  // rooms, or a freak >delay match): by default read it once and flag the hit
  // `partial`. Set ROLL_SKIP_OPEN=true to skip still-open lobbies entirely
  // (zero auto-host reads, but fully misses the rare >delay tournament lobby).
  rollSkipOpen: bool("ROLL_SKIP_OPEN", false),
  // On a cold start with no saved cursor, seed it this many match IDs behind the
  // live edge so the sweep immediately has a closed backlog to process. IDs are
  // ~sequential by creation, so this is roughly rollDelaySec worth of lobbies;
  // the age gate makes the exact value non-critical (it self-corrects).
  rollSeedLookback: num("ROLL_SEED_LOOKBACK", 12000),

  // --- Budget split (matches processed per front per loop cycle) -----------
  // The rolling sweep always goes first. Background fronts (tenant backfill
  // detail fetches, then owner API walks) get a batch sized by how the sweep
  // is doing: full when parked at the boundary, moderate when on schedule,
  // minimal when it has fallen behind. Everything shares the single limiter.
  rollBatch: num("ROLL_BATCH", 4),
  bgBatchParked: num("BG_BATCH_PARKED", 8),
  bgBatchOnSchedule: num("BG_BATCH_ON_SCHEDULE", 4),
  bgBatchBehind: num("BG_BATCH_BEHIND", 1),

  // --- Match index (every match the sweep/walks read: id -> maps played) ---
  // Day buckets older than this are pruned; tenant backfills can only reach
  // back this far. ~1 MB/day at typical osu! multiplayer volume.
  indexRetentionDays: num("INDEX_RETENTION_DAYS", 90),
  pruneEveryMs: num("INDEX_PRUNE_EVERY_MS", 60 * 60 * 1000),

  // --- Cadences ---
  edgeProbeMs: num("EDGE_PROBE_MS", 60000), // how often to refresh the live-edge id
  parkIdleMs: num("ROLL_PARK_IDLE_MS", 30000), // wait when sweep is parked at the boundary
  configRefreshMs: num("CONFIG_REFRESH_MS", 15000), // re-read pool/enabled
  statusWriteMs: num("STATUS_WRITE_EVERY_MS", 15000), // batched status flush
  idleMs: num("LOOP_IDLE_MS", 5000), // wait when paused

  // --- Networking ---
  requestTimeoutMs: num("REQUEST_TIMEOUT_MS", 20000),
  maxRetries: num("MAX_RETRIES", 5),
};

export type Config = typeof config;
