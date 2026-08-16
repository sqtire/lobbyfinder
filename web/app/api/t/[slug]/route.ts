import { bad, json, requireTenant } from "@/lib/api";
import { deleteTenant } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { slug: string } };

/** Delete a tournament (its owner or the site owner). Stored lobby details are global and stay. */
export async function DELETE(_req: Request, { params }: Ctx) {
  const t = await requireTenant(params.slug, "manage");
  if (!t.ok) return t.res;
  const ok = await deleteTenant(params.slug);
  return ok ? json({ ok: true }) : bad("delete failed", 500);
}
