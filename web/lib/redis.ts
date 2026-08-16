import { Redis } from "ioredis";
import crypto from "crypto";
import type {
  BackfillState,
  GlobalConfig,
  Hit,
  OsuUser,
  Roster,
  Status,
  Tenant,
  TenantRole,
  TenantSummary,
  WalkState,
} from "./types";
import { MAX_POOL } from "./types";

const PREFIX = process.env.KEY_PREFIX?.trim() || "mpf";
/** Key layout — mirrored in worker/src/store.ts. Keep the two in sync. */
export const K = {
  global: `${PREFIX}:global`,
  tenants: `${PREFIX}:tenants`,
  tenant: (s: string) => `${PREFIX}:t:${s}`,
  tHits: (s: string) => `${PREFIX}:t:${s}:hits`,
  tHidden: (s: string) => `${PREFIX}:t:${s}:hidden`,
  tRoster: (s: string) => `${PREFIX}:t:${s}:roster`,
  tMembers: (s: string) => `${PREFIX}:t:${s}:members`, // HASH osu_id -> role
  tBackfill: (s: string) => `${PREFIX}:t:${s}:backfill`,
  tBackfillPending: (s: string) => `${PREFIX}:t:${s}:backfill:pending`,
  backfillQueue: `${PREFIX}:backfill:queue`,
  backfillActive: `${PREFIX}:backfill:active`,
  coverageReq: `${PREFIX}:coverage:req`,
  roll: `${PREFIX}:roll`,
  walk: `${PREFIX}:walk`,
  walkQueue: `${PREFIX}:walk:queue`,
  status: `${PREFIX}:status`,
  hits: `${PREFIX}:hits`,
  hitsIdx: `${PREFIX}:hits:idx`,
  idxDays: `${PREFIX}:idx:days`,
  user: (id: number) => `${PREFIX}:user:${id}`, // JSON OsuUser
  userTenants: (id: number) => `${PREFIX}:user:${id}:t`, // SET of slugs the user is a member of
  sess: (sid: string) => `${PREFIX}:sess:${sid}`, // JSON { osu_id, created_at }
  migrated: `${PREFIX}:migrated`, // STRING slug the legacy single-tenant data was adopted into
  // legacy single-tenant keys (read-only, for adoption)
  legacyConfig: `${PREFIX}:config`,
  legacyRoster: `${PREFIX}:roster`,
  legacyHidden: `${PREFIX}:hits:hidden`,
};

const SESSION_TTL_S = 30 * 24 * 60 * 60;

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
const parseJson = <T>(raw: string | null | undefined): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`));
export const todayUtc = () => new Date().toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// ---- global switch + status ----

export async function getGlobal(): Promise<GlobalConfig> {
  const gc = await getJson<GlobalConfig>(K.global);
  return { enabled: gc ? gc.enabled !== false : true, updated_at: gc?.updated_at ?? new Date(0).toISOString() };
}
export async function setGlobal(enabled: boolean): Promise<GlobalConfig> {
  const next: GlobalConfig = { enabled: !!enabled, updated_at: new Date().toISOString() };
  await client().set(K.global, JSON.stringify(next));
  return next;
}
export async function getStatus(): Promise<Status | null> {
  return getJson<Status>(K.status);
}
export async function liveWatermark(): Promise<number> {
  const roll = await getJson<{ cursor: number }>(K.roll);
  return roll?.cursor ?? 0;
}

// ---- tenants ----

import { slugify, validSlug } from "./slug";
export { slugify, validSlug };

function sanitizeTenant(t: Partial<Tenant> & { slug: string }): Tenant {
  return {
    slug: t.slug,
    name: typeof t.name === "string" && t.name.trim() ? t.name.trim().slice(0, 60) : t.slug,
    owner_id: Number.isInteger(t.owner_id) ? (t.owner_id as number) : 0,
    pool: sanitizePool(t.pool),
    enabled: t.enabled !== false,
    start_day: isDay(t.start_day) ? t.start_day : (t.created_at ?? new Date().toISOString()).slice(0, 10),
    created_at: t.created_at ?? new Date().toISOString(),
    updated_at: t.updated_at ?? new Date().toISOString(),
  };
}

export async function getTenant(slug: string): Promise<Tenant | null> {
  if (!validSlug(slug)) return null;
  const t = await getJson<Tenant>(K.tenant(slug));
  return t ? sanitizeTenant({ ...t, slug }) : null;
}
export async function listTenants(): Promise<Tenant[]> {
  const c = client();
  const slugs = await c.smembers(K.tenants);
  if (slugs.length === 0) return [];
  const raws = await c.mget(...slugs.map(K.tenant));
  const out: Tenant[] = [];
  raws.forEach((raw, i) => {
    const t = parseJson<Tenant>(raw);
    if (t) out.push(sanitizeTenant({ ...t, slug: slugs[i]! }));
  });
  out.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return out;
}

export async function tenantSummaries(): Promise<TenantSummary[]> {
  const tenants = await listTenants();
  if (tenants.length === 0) return [];
  const c = client();
  const counts = await Promise.all(tenants.map((t) => c.zcard(K.tHits(t.slug))));
  const owners = await getUsers([...new Set(tenants.map((t) => t.owner_id))]);
  return tenants.map((t, i) => ({
    slug: t.slug,
    name: t.name,
    owner_id: t.owner_id,
    owner_name: owners.get(t.owner_id)?.username ?? null,
    enabled: t.enabled,
    pool_size: t.pool.length,
    hits: counts[i] ?? 0,
    start_day: t.start_day,
    created_at: t.created_at,
    updated_at: t.updated_at,
  }));
}

export async function createTenant(input: { slug: string; name: string; owner_id: number }): Promise<{ ok: true; tenant: Tenant } | { ok: false; error: string }> {
  const slug = input.slug;
  if (!validSlug(slug)) return { ok: false, error: "slug must be 3–32 chars of a-z, 0-9 and hyphens" };
  const c = client();
  const now = new Date().toISOString();
  const tenant = sanitizeTenant({ slug, name: input.name, owner_id: input.owner_id, pool: [], enabled: true, start_day: now.slice(0, 10), created_at: now, updated_at: now });
  const created = await c.set(K.tenant(slug), JSON.stringify(tenant), "NX");
  if (created !== "OK") return { ok: false, error: "that slug is taken" };
  await c
    .multi()
    .sadd(K.tenants, slug)
    .hset(K.tMembers(slug), String(input.owner_id), "owner")
    .sadd(K.userTenants(input.owner_id), slug)
    .exec();
  return { ok: true, tenant };
}

export async function updateTenant(
  slug: string,
  patch: { name?: unknown; pool?: unknown; enabled?: unknown; start_day?: unknown }
): Promise<Tenant | null> {
  const cur = await getTenant(slug);
  if (!cur) return null;
  const next: Tenant = {
    ...cur,
    name: typeof patch.name === "string" && patch.name.trim() ? patch.name.trim().slice(0, 60) : cur.name,
    pool: patch.pool !== undefined ? sanitizePool(patch.pool) : cur.pool,
    enabled: patch.enabled !== undefined ? !!patch.enabled : cur.enabled,
    start_day: isDay(patch.start_day) ? patch.start_day : cur.start_day,
    updated_at: new Date().toISOString(),
  };
  await client().set(K.tenant(slug), JSON.stringify(next));
  return next;
}

export async function deleteTenant(slug: string): Promise<boolean> {
  const t = await getTenant(slug);
  if (!t) return false;
  const c = client();
  const members = await c.hkeys(K.tMembers(slug));
  const multi = c
    .multi()
    .srem(K.tenants, slug)
    .del(K.tenant(slug), K.tHits(slug), K.tHidden(slug), K.tRoster(slug), K.tMembers(slug), K.tBackfill(slug), K.tBackfillPending(slug))
    .lrem(K.backfillQueue, 0, slug)
    .hdel(K.coverageReq, slug);
  for (const m of members) multi.srem(K.userTenants(Number(m)), slug);
  await multi.exec();
  return true;
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

// ---- members ----

export async function getRole(slug: string, osuId: number): Promise<TenantRole | null> {
  const r = await client().hget(K.tMembers(slug), String(osuId));
  return r === "owner" || r === "staff" ? r : null;
}
export async function listMembers(slug: string): Promise<{ osu_id: number; role: TenantRole; username: string | null; avatar_url: string | null }[]> {
  const raw = await client().hgetall(K.tMembers(slug));
  const ids = Object.keys(raw).map(Number).filter(Number.isInteger);
  const users = await getUsers(ids);
  return ids
    .map((id) => ({
      osu_id: id,
      role: (raw[String(id)] === "owner" ? "owner" : "staff") as TenantRole,
      username: users.get(id)?.username ?? null,
      avatar_url: users.get(id)?.avatar_url ?? null,
    }))
    .sort((a, b) => (a.role === b.role ? a.osu_id - b.osu_id : a.role === "owner" ? -1 : 1));
}
export async function setMember(slug: string, osuId: number, role: TenantRole): Promise<void> {
  await client().multi().hset(K.tMembers(slug), String(osuId), role).sadd(K.userTenants(osuId), slug).exec();
}
export async function removeMember(slug: string, osuId: number): Promise<void> {
  await client().multi().hdel(K.tMembers(slug), String(osuId)).srem(K.userTenants(osuId), slug).exec();
}
export async function userMemberships(osuId: number): Promise<{ slug: string; name: string; role: TenantRole }[]> {
  const c = client();
  const slugs = await c.smembers(K.userTenants(osuId));
  if (slugs.length === 0) return [];
  const [raws, roles] = await Promise.all([c.mget(...slugs.map(K.tenant)), Promise.all(slugs.map((s) => c.hget(K.tMembers(s), String(osuId))))]);
  const out: { slug: string; name: string; role: TenantRole }[] = [];
  slugs.forEach((slug, i) => {
    const t = parseJson<Tenant>(raws[i]);
    const r = roles[i];
    if (t && (r === "owner" || r === "staff")) out.push({ slug, name: t.name ?? slug, role: r });
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- users + sessions ----

export async function upsertUser(u: { osu_id: number; username: string; avatar_url: string | null; country_code: string | null }): Promise<OsuUser> {
  const c = client();
  const prev = await getJson<OsuUser>(K.user(u.osu_id));
  const now = new Date().toISOString();
  const next: OsuUser = {
    osu_id: u.osu_id,
    username: u.username,
    avatar_url: u.avatar_url,
    country_code: u.country_code,
    first_login: prev?.first_login ?? now,
    last_login: now,
  };
  await c.set(K.user(u.osu_id), JSON.stringify(next));
  return next;
}
export async function getUser(osuId: number): Promise<OsuUser | null> {
  return getJson<OsuUser>(K.user(osuId));
}
export async function getUsers(ids: number[]): Promise<Map<number, OsuUser>> {
  const out = new Map<number, OsuUser>();
  if (ids.length === 0) return out;
  const raws = await client().mget(...ids.map(K.user));
  raws.forEach((raw, i) => {
    const u = parseJson<OsuUser>(raw);
    if (u) out.set(ids[i]!, u);
  });
  return out;
}

export async function createSession(osuId: number): Promise<string> {
  const sid = crypto.randomBytes(24).toString("base64url");
  await client().set(K.sess(sid), JSON.stringify({ osu_id: osuId, created_at: new Date().toISOString() }), "EX", SESSION_TTL_S);
  return sid;
}
export async function getSessionOsuId(sid: string): Promise<number | null> {
  const s = await getJson<{ osu_id: number }>(K.sess(sid));
  if (!s || !Number.isInteger(s.osu_id)) return null;
  // sliding expiry
  await client().expire(K.sess(sid), SESSION_TTL_S);
  return s.osu_id;
}
export async function deleteSession(sid: string): Promise<void> {
  await client().del(K.sess(sid));
}

// ---- tenant hits (references into the global store) ----

/** Filter a stored hit's games to the tenant's current pool. Legacy (pool-filtered) hits are filtered again — harmless. */
function projectHit(h: Hit, pool: Set<number>): Hit | null {
  const games = h.games.filter((gm) => pool.has(gm.beatmap_id));
  if (games.length === 0) return null;
  return { ...h, games };
}

async function fetchTenantHits(slug: string, pool: number[], limit: number): Promise<Hit[]> {
  const c = client();
  const ids = await c.zrevrange(K.tHits(slug), 0, limit < 0 ? -1 : limit - 1);
  if (ids.length === 0) return [];
  const raws = await c.hmget(K.hits, ...ids);
  const poolSet = new Set(pool);
  const out: Hit[] = [];
  const dangling: string[] = [];
  raws.forEach((raw, i) => {
    const h = parseJson<Hit>(raw);
    if (!h) {
      dangling.push(ids[i]!);
      return;
    }
    const p = projectHit(h, poolSet);
    if (p) out.push(p);
  });
  if (dangling.length) await c.zrem(K.tHits(slug), ...dangling); // reference to a hit that no longer exists
  return out;
}
export async function getTenantHits(slug: string, pool: number[], limit = 200): Promise<Hit[]> {
  return fetchTenantHits(slug, pool, limit);
}
export async function getAllTenantHits(slug: string, pool: number[]): Promise<Hit[]> {
  return fetchTenantHits(slug, pool, -1);
}
export async function tenantHitsCount(slug: string): Promise<number> {
  return client().zcard(K.tHits(slug));
}
export async function tenantHiddenCount(slug: string): Promise<number> {
  return client().scard(K.tHidden(slug));
}
/** Tombstone match ids for this tenant (never re-linked, even by backfill) and drop the references. */
export async function removeTenantHits(slug: string, ids: number[]): Promise<number> {
  const clean = Array.from(new Set(ids.filter((n) => Number.isInteger(n) && n > 0)));
  if (clean.length === 0) return 0;
  const members = clean.map(String);
  // hide FIRST so a worker mid-link loses the race
  await client().multi().sadd(K.tHidden(slug), ...members).zrem(K.tHits(slug), ...members).exec();
  return clean.length;
}
export async function resetTenantHidden(slug: string): Promise<number> {
  const c = client();
  const n = await c.scard(K.tHidden(slug));
  await c.del(K.tHidden(slug));
  return n;
}
export async function clearTenantHits(slug: string): Promise<void> {
  await client().del(K.tHits(slug));
}

// ---- roster ----

export async function getRoster(slug: string): Promise<Roster | null> {
  return getJson<Roster>(K.tRoster(slug));
}
export async function saveRoster(slug: string, r: Roster): Promise<void> {
  await client().set(K.tRoster(slug), JSON.stringify(r));
}
export async function clearRoster(slug: string): Promise<void> {
  await client().del(K.tRoster(slug));
}

// ---- backfill (tenant) ----

export async function getBackfill(slug: string): Promise<BackfillState | null> {
  return getJson<BackfillState>(K.tBackfill(slug));
}
export async function backfillQueuePosition(slug: string): Promise<number | null> {
  const list = await client().lrange(K.backfillQueue, 0, -1);
  const i = list.indexOf(slug);
  return i >= 0 ? i + 1 : null;
}
export type EnqueueResult = { ok: true; state: BackfillState; position: number } | { ok: false; error: string };
export async function enqueueBackfill(slug: string, fromDay: string, toDay: string, requestedBy: number | null): Promise<EnqueueResult> {
  if (!isDay(fromDay) || !isDay(toDay)) return { ok: false, error: "dates must be YYYY-MM-DD" };
  const today = todayUtc();
  if (toDay > today) toDay = today;
  if (fromDay > toDay) return { ok: false, error: "from must be on or before to (and not in the future)" };
  const span = (Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86400000 + 1;
  if (span > 366) return { ok: false, error: "range too large (max 366 days)" };
  const cur = await getBackfill(slug);
  if (cur && (cur.status === "queued" || cur.status === "scanning" || cur.status === "fetching")) {
    return { ok: false, error: `a backfill is already ${cur.status}` };
  }
  const state: BackfillState = {
    status: "queued",
    from_day: fromDay,
    to_day: toDay,
    requested_at: new Date().toISOString(),
    requested_by: requestedBy,
    started_at: null,
    finished_at: null,
    candidates: 0,
    linked: 0,
    to_fetch: 0,
    fetched: 0,
    tombstoned: 0,
    uncovered_days: [],
    error: null,
  };
  const c = client();
  await c.multi().set(K.tBackfill(slug), JSON.stringify(state)).lrem(K.backfillQueue, 0, slug).rpush(K.backfillQueue, slug).exec();
  const position = (await backfillQueuePosition(slug)) ?? 1;
  return { ok: true, state, position };
}
export async function cancelBackfill(slug: string): Promise<boolean> {
  const cur = await getBackfill(slug);
  if (!cur || !(cur.status === "queued" || cur.status === "scanning" || cur.status === "fetching")) return false;
  const next: BackfillState = { ...cur, status: "cancelled", finished_at: new Date().toISOString() };
  await client().multi().set(K.tBackfill(slug), JSON.stringify(next)).lrem(K.backfillQueue, 0, slug).exec();
  return true;
}

// ---- owner: walks, coverage requests, legacy adoption ----

export async function getWalk(): Promise<WalkState | null> {
  return getJson<WalkState>(K.walk);
}
export async function getWalkQueue(): Promise<WalkState[]> {
  const raws = await client().lrange(K.walkQueue, 0, -1);
  return raws.map((r) => parseJson<WalkState>(r)).filter((w): w is WalkState => !!w);
}
export type StartWalkResult = { ok: true; walk: WalkState; gap: number } | { ok: false; error: string };
export async function enqueueWalk(fromId: number, requestedBy: number | null): Promise<StartWalkResult> {
  if (!Number.isInteger(fromId) || fromId <= 0) return { ok: false, error: "from_id must be a positive integer match ID" };
  const toId = await liveWatermark();
  if (toId <= 0) return { ok: false, error: "the rolling sweep has no position yet — let it run once first" };
  if (fromId > toId) return { ok: false, error: `from_id (${fromId}) is ahead of the sweep position (${toId}); nothing to walk` };
  const walk: WalkState = {
    id: crypto.randomBytes(6).toString("hex"),
    from_id: fromId,
    to_id: toId,
    cursor: fromId - 1,
    status: "queued",
    processed: 0,
    requested_at: new Date().toISOString(),
    requested_by: requestedBy,
    finished_at: null,
  };
  await client().rpush(K.walkQueue, JSON.stringify(walk));
  return { ok: true, walk, gap: toId - fromId + 1 };
}
export async function cancelWalk(id: string): Promise<boolean> {
  const c = client();
  const active = await getWalk();
  if (active && active.id === id && active.status === "running") {
    await c.set(K.walk, JSON.stringify({ ...active, status: "cancelled", finished_at: new Date().toISOString() }));
    return true;
  }
  const raws = await c.lrange(K.walkQueue, 0, -1);
  for (const raw of raws) {
    const w = parseJson<WalkState>(raw);
    if (w && w.id === id) {
      await c.lrem(K.walkQueue, 0, raw);
      return true;
    }
  }
  return false;
}
export async function getCoverageRequests(): Promise<{ slug: string; from_day: string; to_day: string; uncovered_days: string[]; at: string }[]> {
  const raw = await client().hgetall(K.coverageReq);
  const out: { slug: string; from_day: string; to_day: string; uncovered_days: string[]; at: string }[] = [];
  for (const [slug, json] of Object.entries(raw)) {
    const r = parseJson<{ from_day: string; to_day: string; uncovered_days: string[]; at: string }>(json);
    if (r) out.push({ slug, from_day: r.from_day, to_day: r.to_day, uncovered_days: Array.isArray(r.uncovered_days) ? r.uncovered_days : [], at: r.at });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}
export async function clearCoverageRequest(slug: string): Promise<void> {
  await client().hdel(K.coverageReq, slug);
}

export async function legacyInfo(): Promise<{ present: boolean; adopted_into: string | null; hits: number; pool: number[] }> {
  const c = client();
  const [cfg, adopted, idxCount] = await Promise.all([getJson<{ target_beatmap_ids?: unknown }>(K.legacyConfig), c.get(K.migrated), c.zcard(K.hitsIdx)]);
  const pool = sanitizePool(cfg?.target_beatmap_ids);
  return { present: !!cfg || idxCount > 0, adopted_into: adopted, hits: idxCount, pool };
}

/**
 * One-time: fold the pre-multi-tenant data into a tenant — its pool from the
 * legacy config, references to every stored hit, its tombstones and roster.
 * Copies, never moves; safe to re-run against the same slug.
 */
export async function adoptLegacy(slug: string, name: string, ownerId: number): Promise<{ ok: true; tenant: Tenant; hits: number } | { ok: false; error: string }> {
  const c = client();
  let tenant = await getTenant(slug);
  if (!tenant) {
    const created = await createTenant({ slug, name, owner_id: ownerId });
    if (!created.ok) return created;
    tenant = created.tenant;
  }
  const cfg = await getJson<{ target_beatmap_ids?: unknown; enabled?: boolean }>(K.legacyConfig);
  const pool = sanitizePool(cfg?.target_beatmap_ids);
  if (pool.length && tenant.pool.length === 0) tenant = (await updateTenant(slug, { pool })) ?? tenant;

  const hidden = await c.smembers(K.legacyHidden);
  if (hidden.length) await c.sadd(K.tHidden(slug), ...hidden);

  const entries = await c.zrange(K.hitsIdx, 0, -1, "WITHSCORES");
  let n = 0;
  for (let i = 0; i + 1 < entries.length; i += 2) {
    const id = entries[i]!;
    if (hidden.includes(id)) continue;
    await c.zadd(K.tHits(slug), Number(entries[i + 1]), id);
    n++;
  }
  const roster = await getJson<Roster>(K.legacyRoster);
  if (roster && !(await getRoster(slug))) await saveRoster(slug, roster);
  await c.set(K.migrated, slug);
  return { ok: true, tenant, hits: n };
}
