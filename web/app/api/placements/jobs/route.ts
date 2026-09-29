import { getSessionUser } from "@/lib/auth";
import { bad, json, readJson } from "@/lib/api";
import { isRunning, sanitizeSettings, startJob } from "@/lib/placements/jobs";
import { listJobs } from "@/lib/placements/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Recent runs (public — results are tournament results). */
export async function GET() {
  const [jobs, active] = await Promise.all([listJobs(), isRunning()]);
  return json({ jobs, active });
}

/** Start a run. Site owners only: it spends osu! API requests. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user?.is_site_owner) return bad(user ? "forbidden — only the site owner can start a run" : "sign in required", user ? 403 : 401);
  const body = await readJson<unknown>(req);
  const parsed = sanitizeSettings(body);
  if (!parsed.ok) return bad(parsed.error);
  const started = await startJob(parsed.settings, user.osu_id);
  if (!started.ok) return json({ error: started.error, active: started.active ?? null }, { status: 409 });
  return json({ job: started.job });
}
