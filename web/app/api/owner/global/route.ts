import { getSessionUser } from "@/lib/auth";
import { bad, json, readJson } from "@/lib/api";
import { setGlobal } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Owner-only: site-wide scanner switch (pauses ALL osu! API traffic from the worker). */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user?.is_site_owner) return bad(user ? "forbidden" : "sign in required", user ? 403 : 401);
  const body = await readJson<{ enabled?: unknown }>(req);
  if (typeof body?.enabled !== "boolean") return bad("enabled must be a boolean");
  return json({ ok: true, global: await setGlobal(body.enabled) });
}
