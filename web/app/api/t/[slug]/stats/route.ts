import { json, requireTenant } from "@/lib/api";
import { getAllTenantHits, getRoster } from "@/lib/redis";
import { computeStats, sanitizeStatsSettings } from "@/lib/stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { slug: string } };

/**
 * Qualifier statistics for a tournament (public). Query params override the
 * tournament's saved defaults for this request only:
 *   ?method=zsum|placements|maxpct|pctdiff|zipf&count_failed=0|1&players_per_map=N&mc_mod_scaling=0|1
 */
export async function GET(req: Request, { params }: Ctx) {
  const t = await requireTenant(params.slug, "public");
  if (!t.ok) return t.res;
  const q = new URL(req.url).searchParams;
  const settings = sanitizeStatsSettings({
    ...t.tenant.stats,
    ...(q.get("method") ? { method: q.get("method") } : {}),
    ...(q.get("count_failed") !== null ? { count_failed: q.get("count_failed") === "1" || q.get("count_failed") === "true" } : {}),
    ...(q.get("players_per_map") !== null ? { players_per_map: Number(q.get("players_per_map")) } : {}),
    ...(q.get("mc_mod_scaling") !== null ? { mc_mod_scaling: q.get("mc_mod_scaling") === "1" || q.get("mc_mod_scaling") === "true" } : {}),
  });
  const [hits, roster] = await Promise.all([getAllTenantHits(t.tenant.slug, t.tenant.pool), getRoster(t.tenant.slug)]);
  const result = computeStats({ pool: t.tenant.pool, hits, roster, settings });
  return json({ ...result, saved_settings: t.tenant.stats });
}
