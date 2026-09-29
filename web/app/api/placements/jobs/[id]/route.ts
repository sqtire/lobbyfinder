import { getSessionUser } from "@/lib/auth";
import { bad, json } from "@/lib/api";
import { cancelJob } from "@/lib/placements/jobs";
import { getJob, getResult } from "@/lib/placements/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };
const ID_RE = /^[a-f0-9]{12}$/;

/** Job status, plus the result once it's done (?result=0 to skip the payload). */
export async function GET(req: Request, { params }: Ctx) {
  if (!ID_RE.test(params.id)) return bad("not found", 404);
  const job = await getJob(params.id);
  if (!job) return bad("not found", 404);
  const wantResult = new URL(req.url).searchParams.get("result") !== "0";
  const result = wantResult && job.has_result ? await getResult(params.id) : null;
  return json({ job, result });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const user = await getSessionUser();
  if (!user?.is_site_owner) return bad(user ? "forbidden" : "sign in required", user ? 403 : 401);
  if (!ID_RE.test(params.id)) return bad("not found", 404);
  const ok = await cancelJob(params.id);
  return json({ ok });
}
