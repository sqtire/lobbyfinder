import { getSessionUser } from "@/lib/auth";
import { bad, json, readJson } from "@/lib/api";
import { adoptLegacy, slugify, validSlug } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Owner-only, one-time: fold the pre-multi-tenant data (pool, hits, tombstones, roster) into a tournament. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user?.is_site_owner) return bad(user ? "forbidden" : "sign in required", user ? 403 : 401);
  const body = await readJson<{ slug?: unknown; name?: unknown }>(req);
  const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim().slice(0, 60) : "";
  const slug = typeof body?.slug === "string" && body.slug.trim() ? body.slug.trim().toLowerCase() : slugify(name);
  if (!name) return bad("name required");
  if (!validSlug(slug)) return bad("invalid slug");
  const r = await adoptLegacy(slug, name, user.osu_id);
  if (!r.ok) return bad(r.error);
  return json({ ok: true, tournament: r.tenant, hits: r.hits });
}
