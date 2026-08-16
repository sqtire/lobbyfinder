import { bad, json, readJson, requireTenant } from "@/lib/api";
import { cancelBackfill, enqueueBackfill, getBackfill } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { slug: string } };

export async function GET(_req: Request, { params }: Ctx) {
  const t = await requireTenant(params.slug, "public");
  if (!t.ok) return t.res;
  return json({ backfill: await getBackfill(t.tenant.slug) });
}

/**
 * Queue a backfill: the worker scans the match index for this tournament's
 * pool over [from_day, to_day], links lobbies already stored, and reads only
 * the ones nobody has stored yet. No raw API walk is ever triggered here.
 */
export async function POST(req: Request, { params }: Ctx) {
  const t = await requireTenant(params.slug, "edit");
  if (!t.ok) return t.res;
  if (t.tenant.pool.length === 0) return bad("set a beatmap pool first — a backfill matches lobbies against it");
  const body = await readJson<{ from_day?: unknown; to_day?: unknown }>(req);
  const from = typeof body?.from_day === "string" ? body.from_day : t.tenant.start_day;
  const to = typeof body?.to_day === "string" ? body.to_day : new Date().toISOString().slice(0, 10);
  const r = await enqueueBackfill(t.tenant.slug, from, to, t.access.user?.osu_id ?? null);
  if (!r.ok) return bad(r.error);
  return json({ ok: true, backfill: r.state, position: r.position });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const t = await requireTenant(params.slug, "edit");
  if (!t.ok) return t.res;
  return json({ ok: true, cancelled: await cancelBackfill(t.tenant.slug) });
}
