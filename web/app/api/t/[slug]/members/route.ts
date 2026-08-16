import { bad, json, readJson, requireTenant } from "@/lib/api";
import { listMembers, removeMember, setMember } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { slug: string } };

/** Accepts an osu! user id or a profile URL (osu.ppy.sh/users/123). Numeric ids only — no API lookups. */
function parseOsuId(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  if (typeof v !== "string") return null;
  const s = v.trim();
  const m = s.match(/osu\.ppy\.sh\/(?:users|u)\/(\d+)/i) ?? s.match(/^(\d+)$/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(_req: Request, { params }: Ctx) {
  const t = await requireTenant(params.slug, "public");
  if (!t.ok) return t.res;
  return json({ members: await listMembers(t.tenant.slug) });
}

export async function POST(req: Request, { params }: Ctx) {
  const t = await requireTenant(params.slug, "manage");
  if (!t.ok) return t.res;
  const body = await readJson<{ osu_id?: unknown; role?: unknown }>(req);
  const id = parseOsuId(body?.osu_id);
  if (!id) return bad("provide an osu! user id or profile URL");
  const role = body?.role === "owner" ? "owner" : "staff";
  await setMember(t.tenant.slug, id, role);
  return json({ ok: true, members: await listMembers(t.tenant.slug) });
}

export async function DELETE(req: Request, { params }: Ctx) {
  const t = await requireTenant(params.slug, "manage");
  if (!t.ok) return t.res;
  const body = await readJson<{ osu_id?: unknown }>(req);
  const id = parseOsuId(body?.osu_id);
  if (!id) return bad("provide an osu! user id");
  if (id === t.tenant.owner_id) return bad("the tournament owner cannot be removed", 400);
  await removeMember(t.tenant.slug, id);
  return json({ ok: true, members: await listMembers(t.tenant.slug) });
}
