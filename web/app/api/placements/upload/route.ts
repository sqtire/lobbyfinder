import { getSessionUser } from "@/lib/auth";
import { bad, json } from "@/lib/api";
import { readScheduleTable } from "@/lib/placements/schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 30 * 1024 * 1024;

/**
 * Upload the referee sheet as .xlsx (File → Download → Microsoft Excel) instead
 * of linking it. The body is the raw file; ?tab= picks the schedule tab. Only
 * that tab comes back, as a string table the panel sends with the preview/run.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return bad("sign in required", 401);
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) return bad("That spreadsheet is larger than 30 MB.", 413);
  const tab = (new URL(req.url).searchParams.get("tab") ?? "").trim() || "Chrono Schedule";
  let buf: Buffer;
  try {
    buf = Buffer.from(await req.arrayBuffer());
  } catch {
    return bad("Couldn't read the upload.");
  }
  if (buf.byteLength === 0) return bad("The file is empty.");
  if (buf.byteLength > MAX_BYTES) return bad("That spreadsheet is larger than 30 MB.", 413);
  try {
    const { rows, tab: found, tabs } = await readScheduleTable(buf, tab);
    return json({ rows, tab: found, tabs: tabs.length });
  } catch (e) {
    return bad((e as Error).message);
  }
}
