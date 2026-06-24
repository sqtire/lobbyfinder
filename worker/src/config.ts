/**
 * All worker tuning is env-driven so the same image runs unchanged on Railway.
 * NOTE: the target beatmap pool is NOT here — it lives in Redis (`mpf:config`)
 * and is edited live from the web control panel.
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

  // --- Dual-front budget split (matches processed per front per loop cycle) ---
  // Equal values => ~50/50. They share the single rate limiter, so total stays
  // <=1 req/sec regardless. Raise LIVE_BATCH to favour fresh lobbies.
  liveBatch: num("LIVE_BATCH", 4),
  rescanBatch: num("RESCAN_BATCH", 4),

  // --- Open-lobby re-checking (a lobby plays its maps AFTER it opens) ---
  watchOpenMatches: bool("WATCH_OPEN_MATCHES", true),
  watchRecheckEverySec: num("WATCH_RECHECK_EVERY_SEC", 120),
  watchTtlSec: num("WATCH_TTL_SEC", 2 * 60 * 60),
  watchMax: num("WATCH_MAX", 200),
  watchBatch: num("WATCH_BATCH", 10), // open lobbies re-checked per due cycle

  // --- Cadences ---
  configRefreshMs: num("CONFIG_REFRESH_MS", 15000), // re-read pool/enabled
  statusWriteMs: num("STATUS_WRITE_EVERY_MS", 15000), // batched status flush
  idleMs: num("LOOP_IDLE_MS", 5000), // wait when paused / fully caught up

  // --- Networking ---
  requestTimeoutMs: num("REQUEST_TIMEOUT_MS", 20000),
  maxRetries: num("MAX_RETRIES", 5),
};

export type Config = typeof config;
