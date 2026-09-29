/**
 * Redis keys for the placements feature. Everything lives under
 * `<prefix>:plc:*` so it never collides with the scanner's data.
 *
 *   plc:room:<kind>:<id>   JSON RoomData      (closed lobbies are immutable → cached 60 days)
 *   plc:bm:<id>            JSON BeatmapMeta   (90 days)
 *   plc:job:<id>           JSON PlacementsJob (14 days)
 *   plc:job:<id>:result    JSON PlacementsResult (14 days)
 *   plc:jobs               LIST of job ids, newest first (capped)
 *   plc:active             STRING job id currently running (TTL = heartbeat)
 */

import { KEY_PREFIX, redisClient } from "@/lib/redis";
import type { BeatmapMeta, JobSummary, PlacementsJob, PlacementsResult, RoomData, RoomKind } from "./types";

const P = `${KEY_PREFIX}:plc`;
export const PK = {
  room: (kind: RoomKind, id: number) => `${P}:room:${kind}:${id}`,
  beatmap: (id: number) => `${P}:bm:${id}`,
  job: (id: string) => `${P}:job:${id}`,
  result: (id: string) => `${P}:job:${id}:result`,
  jobs: `${P}:jobs`,
  active: `${P}:active`,
};

const ROOM_TTL_S = 60 * 24 * 3600;
const BM_TTL_S = 90 * 24 * 3600;
const JOB_TTL_S = 14 * 24 * 3600;
const JOBS_KEEP = 30;
export const ACTIVE_TTL_S = 90; // a running job refreshes this on every progress write

async function getJson<T>(key: string): Promise<T | null> {
  const raw = await redisClient().get(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ---- caches -----------------------------------------------------------------

export async function getCachedRoom(kind: RoomKind, id: number): Promise<RoomData | null> {
  return getJson<RoomData>(PK.room(kind, id));
}
export async function cacheRoom(room: RoomData): Promise<void> {
  await redisClient().set(PK.room(room.kind, room.id), JSON.stringify(room), "EX", ROOM_TTL_S);
}
export async function dropCachedRoom(kind: RoomKind, id: number): Promise<void> {
  await redisClient().del(PK.room(kind, id));
}

export async function getCachedBeatmaps(ids: number[]): Promise<Map<number, BeatmapMeta>> {
  const out = new Map<number, BeatmapMeta>();
  if (ids.length === 0) return out;
  const raws = await redisClient().mget(...ids.map((id) => PK.beatmap(id)));
  raws.forEach((raw, i) => {
    if (!raw) return;
    try {
      out.set(ids[i]!, JSON.parse(raw) as BeatmapMeta);
    } catch {
      /* ignore */
    }
  });
  return out;
}
export async function cacheBeatmaps(metas: BeatmapMeta[]): Promise<void> {
  if (metas.length === 0) return;
  const pipe = redisClient().pipeline();
  for (const m of metas) pipe.set(PK.beatmap(m.id), JSON.stringify(m), "EX", BM_TTL_S);
  await pipe.exec();
}

// ---- jobs -------------------------------------------------------------------

export async function saveJob(job: PlacementsJob): Promise<void> {
  await redisClient().set(PK.job(job.id), JSON.stringify(job), "EX", JOB_TTL_S);
}
export async function getJob(id: string): Promise<PlacementsJob | null> {
  return getJson<PlacementsJob>(PK.job(id));
}
export async function registerJob(id: string): Promise<void> {
  const r = redisClient();
  await r.lpush(PK.jobs, id);
  await r.ltrim(PK.jobs, 0, JOBS_KEEP - 1);
}
export async function listJobs(): Promise<JobSummary[]> {
  const ids = await redisClient().lrange(PK.jobs, 0, JOBS_KEEP - 1);
  if (ids.length === 0) return [];
  const raws = await redisClient().mget(...ids.map((id) => PK.job(id)));
  const out: JobSummary[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    try {
      const j = JSON.parse(raw) as PlacementsJob;
      out.push({ id: j.id, status: j.status, title: j.title, created_at: j.created_at, finished_at: j.finished_at, progress: j.progress, error: j.error });
    } catch {
      /* ignore */
    }
  }
  return out;
}
export async function saveResult(id: string, result: PlacementsResult): Promise<void> {
  await redisClient().set(PK.result(id), JSON.stringify(result), "EX", JOB_TTL_S);
}
export async function getResult(id: string): Promise<PlacementsResult | null> {
  return getJson<PlacementsResult>(PK.result(id));
}

/** Claim the single runner slot. Returns the id of the job that holds it when busy. */
export async function claimActive(id: string): Promise<string | null> {
  const r = redisClient();
  const ok = await r.set(PK.active, id, "EX", ACTIVE_TTL_S, "NX");
  if (ok === "OK") return null;
  const holder = await r.get(PK.active);
  return holder ?? "unknown";
}
export async function touchActive(id: string): Promise<void> {
  const r = redisClient();
  const holder = await r.get(PK.active);
  if (holder === id) await r.expire(PK.active, ACTIVE_TTL_S);
}
export async function releaseActive(id: string): Promise<void> {
  const r = redisClient();
  const holder = await r.get(PK.active);
  if (holder === id) await r.del(PK.active);
}
export async function activeJobId(): Promise<string | null> {
  return redisClient().get(PK.active);
}
