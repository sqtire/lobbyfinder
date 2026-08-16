import { json } from "@/lib/api";
import { getStatus } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public scanner health (global). */
export async function GET() {
  return json({ status: await getStatus() });
}
