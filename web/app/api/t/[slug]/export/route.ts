import { NextResponse } from "next/server";
import { requireTenant } from "@/lib/api";
import { getAllTenantHits, getRoster } from "@/lib/redis";
import { computeStats, sanitizeStatsSettings } from "@/lib/stats";
import { buildGridRows, gridCsv, statsWorkbook } from "@/lib/statsExport";
import type { Hit } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { slug: string } };

function csv(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const row = (cells: unknown[]) => cells.map(csv).join(",");

function mapLabel(g: Hit["games"][number]): string {
  const base = g.title ? g.title : `beatmap ${g.beatmap_id}`;
  const diff = g.version ? ` [${g.version}]` : "";
  const mods = g.mods && g.mods.length ? ` +${g.mods.join(",")}` : "";
  return `${base}${diff}${mods} (#${g.beatmap_id})`;
}

function file(content: string, filename: string, type: string) {
  return new NextResponse(content, {
    headers: {
      "content-type": `${type}; charset=utf-8`,
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}

export async function GET(req: Request, { params }: Ctx) {
  const t = await requireTenant(params.slug, "edit");
  if (!t.ok) return t.res;
  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "json";
  const hits = await getAllTenantHits(t.tenant.slug, t.tenant.pool);
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `lobbyfinder-${t.tenant.slug}`;

  // the Teams-grid viewport (best score per player per pool map)
  if (format === "grid") {
    const roster = await getRoster(t.tenant.slug);
    return file(gridCsv(t.tenant.pool, hits, roster), `${base}-grid-${stamp}.csv`, "text/csv");
  }

  // the full stats workbook (placements, leaderboards, performance, mappool, grid)
  if (format === "stats") {
    const roster = await getRoster(t.tenant.slug);
    const q = url.searchParams;
    const settings = sanitizeStatsSettings({
      ...t.tenant.stats,
      ...(q.get("method") ? { method: q.get("method") } : {}),
      ...(q.get("count_failed") !== null ? { count_failed: q.get("count_failed") === "1" } : {}),
      ...(q.get("players_per_map") !== null ? { players_per_map: Number(q.get("players_per_map")) } : {}),
      ...(q.get("mc_mod_scaling") !== null ? { mc_mod_scaling: q.get("mc_mod_scaling") === "1" } : {}),
    });
    const stats = computeStats({ pool: t.tenant.pool, hits, roster, settings });
    const grid = buildGridRows(t.tenant.pool, hits, roster);
    const buf = await statsWorkbook({ tournament: t.tenant.name, slug: t.tenant.slug, stats, grid });
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${base}-stats-${stamp}.xlsx"`,
        "cache-control": "no-store",
      },
    });
  }

  if (format === "players") {
    const lines = [row(["match_id", "lobby_name", "lobby_url", "start_time", "user_id", "username", "maps_played"])];
    for (const h of hits) {
      for (const p of h.players ?? []) {
        lines.push(row([h.match_id, h.match_name, h.match_url, h.start_time, p.user_id, p.username, p.maps_played]));
      }
    }
    return file("\uFEFF" + lines.join("\r\n"), `${base}-players-${stamp}.csv`, "text/csv");
  }

  if (format === "lobbies") {
    const lines = [row(["match_id", "lobby_name", "lobby_url", "start_time", "end_time", "source", "partial", "pool_maps_played", "player_count", "maps_played"])];
    for (const h of hits) {
      lines.push(
        row([
          h.match_id,
          h.match_name,
          h.match_url,
          h.start_time,
          h.end_time,
          h.source,
          h.partial ? "yes" : "no",
          h.games.length,
          (h.players ?? []).length,
          h.games.map(mapLabel).join(" | "),
        ])
      );
    }
    return file("\uFEFF" + lines.join("\r\n"), `${base}-lobbies-${stamp}.csv`, "text/csv");
  }

  const payload = { exported_at: new Date().toISOString(), tournament: t.tenant.slug, lobby_count: hits.length, lobbies: hits };
  return file(JSON.stringify(payload, null, 2), `${base}-export-${stamp}.json`, "application/json");
}
