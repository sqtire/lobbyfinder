import { getSessionUser } from "@/lib/auth";
import { bad, json, readJson } from "@/lib/api";
import { createTenant, slugify, tenantSummaries, userMemberships, validSlug } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PER_USER = Number(process.env.MAX_TOURNAMENTS_PER_USER ?? 5);

/** Public list of tournaments. */
export async function GET() {
  return json({ tournaments: await tenantSummaries() });
}

/** Create a tournament; the signed-in user becomes its owner. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return bad("sign in required", 401);
  const body = await readJson<{ name?: unknown; slug?: unknown }>(req);
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 60) : "";
  if (name.length < 2) return bad("name must be at least 2 characters");
  const slug = typeof body?.slug === "string" && body.slug.trim() ? body.slug.trim().toLowerCase() : slugify(name);
  if (!validSlug(slug)) return bad("slug must be 3–32 chars of a-z, 0-9 and hyphens (and not reserved)");
  if (!user.is_site_owner) {
    const owned = (await userMemberships(user.osu_id)).filter((m) => m.role === "owner").length;
    if (owned >= MAX_PER_USER) return bad(`you already own ${owned} tournaments (limit ${MAX_PER_USER})`, 403);
  }
  const r = await createTenant({ slug, name, owner_id: user.osu_id });
  if (!r.ok) return bad(r.error, 409);
  return json({ ok: true, tournament: r.tenant });
}
