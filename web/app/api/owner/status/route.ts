import { getSessionUser } from "@/lib/auth";
import { bad, json } from "@/lib/api";
import { getCoverageRequests, getGlobal, getStatus, getWalk, getWalkQueue, legacyInfo, tenantSummaries } from "@/lib/redis";
import type { OwnerStatusResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user?.is_site_owner) return bad(user ? "forbidden" : "sign in required", user ? 403 : 401);
  const [status, global, walk, walk_queue, coverage_requests, tenants, legacy] = await Promise.all([
    getStatus(),
    getGlobal(),
    getWalk(),
    getWalkQueue(),
    getCoverageRequests(),
    tenantSummaries(),
    legacyInfo(),
  ]);
  const body: OwnerStatusResponse = {
    status,
    global,
    walk,
    walk_queue,
    coverage_requests,
    tenants,
    legacy: { present: legacy.present, adopted_into: legacy.adopted_into },
  };
  return json(body);
}
