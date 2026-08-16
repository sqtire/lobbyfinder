import { json, requireTenant } from "@/lib/api";
import { backfillQueuePosition, getBackfill, getStatus, getTenantHits, tenantHiddenCount, tenantHitsCount } from "@/lib/redis";
import type { TenantDataResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { slug: string } };

/** Everything the tournament page polls: tenant, global status, newest hits, backfill state, caller's access. */
export async function GET(_req: Request, { params }: Ctx) {
  const t = await requireTenant(params.slug, "public");
  if (!t.ok) return t.res;
  const slug = t.tenant.slug;
  const [status, hits, hitsTotal, hidden, backfill] = await Promise.all([
    getStatus(),
    getTenantHits(slug, t.tenant.pool, 200),
    tenantHitsCount(slug),
    tenantHiddenCount(slug),
    getBackfill(slug),
  ]);
  const position = backfill && backfill.status === "queued" ? await backfillQueuePosition(slug) : null;
  const body: TenantDataResponse = {
    tenant: t.tenant,
    status,
    hits,
    hits_total: hits.length < 200 ? hits.length : hitsTotal, // exact when we have them all; ZCARD counts refs incl. lobbies no longer on the pool
    hidden_count: hidden,
    backfill,
    backfill_position: position,
    access: t.access,
  };
  return json(body);
}
