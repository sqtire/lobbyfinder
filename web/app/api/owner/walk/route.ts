import { getSessionUser } from "@/lib/auth";
import { bad, json, readJson } from "@/lib/api";
import { cancelWalk, clearCoverageRequest, enqueueWalk } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Owner-only: queue a raw API walk of [from_id .. sweep cursor] into the match index. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user?.is_site_owner) return bad(user ? "forbidden" : "sign in required", user ? 403 : 401);
  const body = await readJson<{ from_id?: unknown; clear_request?: unknown }>(req);
  const fromId = Number(body?.from_id);
  const r = await enqueueWalk(fromId, user.osu_id);
  if (!r.ok) return bad(r.error);
  if (typeof body?.clear_request === "string") await clearCoverageRequest(body.clear_request);
  return json(r);
}

export async function DELETE(req: Request) {
  const user = await getSessionUser();
  if (!user?.is_site_owner) return bad(user ? "forbidden" : "sign in required", user ? 403 : 401);
  const body = await readJson<{ id?: unknown; clear_request?: unknown }>(req);
  if (typeof body?.clear_request === "string") {
    await clearCoverageRequest(body.clear_request);
    return json({ ok: true });
  }
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return bad("walk id required");
  return json({ ok: true, cancelled: await cancelWalk(id) });
}
