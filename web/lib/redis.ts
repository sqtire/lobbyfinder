import { Redis } from "ioredis";
import type { AppConfig, Status, Hit, RescanStatus } from "./types";
import { MAX_POOL } from "./types";

const PREFIX = process.env.KEY_PREFIX?.trim() || "mpf";
const K = {
  config: `${PREFIX}:config`,
  roll: `${PREFIX}:roll`,
  rescan: `${PREFIX}:rescan`,
  status: `${PREFIX}:status`,
  hits: `${PREFIX}:hits`,
  hitsIdx: `${PREFIX}:hits:idx`,
};

// Reuse one connection across hot reloads / lambda invocations.
const g = globalThis as unknown as { __mpfRedis?: Redis };
function client(): Redis {
  if (!g.__mpfRedis) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is not set");
    g.__mpfRedis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
    g.__mpfRedis.on("error", (e: Error) => console.error("[web:redis]", e.message));
  }
  return g.__mpfRedis;
}

async function getJson<T>(key: string): Promise<T | null> {
  const raw = await client().get(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function getConfig(): Promise<AppConfig> {
  const c = await getJson<AppConfig>(K.config);
  if (!c) return { target_beatmap_ids: [], enabled: false, updated_at: new Date(0).toISOString() };
  return {
    target_beatmap_ids: Array.isArray(c.target_beatmap_ids) ? c.target_beatmap_ids : [],
    enabled: !!c.enabled,
    updated_at: c.updated_at ?? new Date(0).toISOString(),
  };
}

export async function getStatus(): Promise<Status | null> {
  return getJson<Status>(K.status);
}

export async function getHits(limit = 200): Promise<Hit[]> {
  const c = client();
  const ids = await c.zrevrange(K.hitsIdx, 0, limit - 1);
  if (ids.length === 0) return [];
  const raws = await c.hmget(K.hits, ...ids);
  const out: Hit[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw) as Hit);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/** Sanitize a user-submitted pool: ints, positive, deduped, capped. */
export function sanitizePool(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const v of input) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isInteger(n) && n > 0 && !seen.has(n)) {
      seen.add(n);
      out.push(n);
      if (out.length >= MAX_POOL) break;
    }
  }
  return out;
}

export async function saveConfig(patch: { target_beatmap_ids?: unknown; enabled?: boolean }): Promise<AppConfig> {
  const cur = await getConfig();
  const next: AppConfig = {
    target_beatmap_ids: patch.target_beatmap_ids !== undefined ? sanitizePool(patch.target_beatmap_ids) : cur.target_beatmap_ids,
    enabled: patch.enabled !== undefined ? !!patch.enabled : cur.enabled,
    updated_at: new Date().toISOString(),
  };
  await client().set(K.config, JSON.stringify(next));
  return next;
}

export async function liveWatermark(): Promise<number> {
  const roll = await getJson<{ cursor: number }>(K.roll);
  return roll?.cursor ?? 0;
}

export type StartRescanResult = { ok: true; from_id: number; to_id: number; gap: number } | { ok: false; error: string };

export async function startRescan(fromId: number): Promise<StartRescanResult> {
  if (!Number.isInteger(fromId) || fromId <= 0) return { ok: false, error: "from_id must be a positive integer match ID" };
  const toId = await liveWatermark();
  if (toId <= 0) return { ok: false, error: "live scanner has no watermark yet — let it run once, then rescan" };
  if (fromId > toId) return { ok: false, error: `from_id (${fromId}) is ahead of the live position (${toId}); nothing to rescan` };

  const record = {
    from_id: fromId,
    to_id: toId,
    cursor: fromId - 1,
    status: "running" as const,
    processed: 0,
    requested_at: new Date().toISOString(),
    finished_at: null,
  };
  await client().set(K.rescan, JSON.stringify(record));
  return { ok: true, from_id: fromId, to_id: toId, gap: toId - fromId + 1 };
}

export async function cancelRescan(): Promise<boolean> {
  const rec = await getJson<{ status: string }>(K.rescan);
  if (!rec || rec.status !== "running") return false;
  await client().set(K.rescan, JSON.stringify({ ...rec, status: "cancelled", finished_at: new Date().toISOString() }));
  return true;
}

export async function clearHits(): Promise<void> {
  const c = client();
  await c.del(K.hits, K.hitsIdx);
}
