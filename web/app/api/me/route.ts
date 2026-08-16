import { getSessionUser } from "@/lib/auth";
import { json } from "@/lib/api";
import { userMemberships } from "@/lib/redis";
import type { MeResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  const memberships = user ? await userMemberships(user.osu_id) : [];
  const body: MeResponse = { user, memberships };
  return json(body);
}
