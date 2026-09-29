import { NextResponse } from "next/server";
import { bad } from "@/lib/api";
import { getJob, getResult } from "@/lib/placements/store";
import { placementsWorkbook } from "@/lib/placements/workbook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

export async function GET(_req: Request, { params }: Ctx) {
  if (!/^[a-f0-9]{12}$/.test(params.id)) return bad("not found", 404);
  const job = await getJob(params.id);
  const result = job?.has_result ? await getResult(params.id) : null;
  if (!job || !result) return bad("no result for that run", 404);
  const buf = await placementsWorkbook(result);
  const slug = (result.title || "placements").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "placements";
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${slug}-final-placements-${result.generated_at.slice(0, 10)}.xlsx"`,
      "cache-control": "no-store",
    },
  });
}
