import { bad, json, readJson, requireTenant } from "@/lib/api";
import { clearTenantHits, removeTenantHits, resetTenantHidden } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { slug: string } };

export async function POST(req: Request, { params }: Ctx) {
  const t = await requireTenant(params.slug, "edit");
  if (!t.ok) return t.res;
  const body = await readJson<{ action?: string; match_ids?: unknown }>(req);
  if (!body) return bad("invalid request");
  const slug = t.tenant.slug;

  if (body.action === "reset_hidden") return json({ ok: true, restored: await resetTenantHidden(slug) });
  if (body.action === "clear") {
    await clearTenantHits(slug);
    return json({ ok: true });
  }
  if (body.action === "remove") {
    const ids = Array.isArray(body.match_ids) ? body.match_ids.map((v) => Number(v)) : [];
    if (ids.length === 0) return bad("no match_ids provided");
    return json({ ok: true, removed: await removeTenantHits(slug, ids) });
  }
  return bad("unknown action");
}
