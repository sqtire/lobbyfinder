import { bad, json, readJson, requireTenant } from "@/lib/api";
import { updateTenant } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { slug: string } };

/** Pool / enabled / start_id / stats defaults (edit) and name (manage). */
export async function POST(req: Request, { params }: Ctx) {
  const t = await requireTenant(params.slug, "edit");
  if (!t.ok) return t.res;
  const patch = await readJson<{ pool?: unknown; enabled?: unknown; start_id?: unknown; name?: unknown; stats?: unknown }>(req);
  if (!patch) return bad("invalid request");
  if (patch.name !== undefined && !t.access.can_manage) return bad("only the tournament owner can rename it", 403);
  const tenant = await updateTenant(t.tenant.slug, patch);
  if (!tenant) return bad("tournament not found", 404);
  return json({ ok: true, tenant });
}
