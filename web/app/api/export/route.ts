import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { getAllHits } from "@/lib/redis";
import type { Hit } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function GET(req: Request) {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const format = new URL(req.url).searchParams.get("format") ?? "json";
  const hits = await getAllHits();
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === "players") {
    const lines = [row(["match_id", "lobby_name", "lobby_url", "start_time", "user_id", "username", "maps_played"])];
    for (const h of hits) {
      for (const p of h.players ?? []) {
        lines.push(row([h.match_id, h.match_name, h.match_url, h.start_time, p.user_id, p.username, p.maps_played]));
      }
    }
    return file("\uFEFF" + lines.join("\r\n"), `lobbyfinder-players-${stamp}.csv`, "text/csv");
  }

  if (format === "lobbies") {
    const lines = [
      row([
        "match_id",
        "lobby_name",
        "lobby_url",
        "start_time",
        "end_time",
        "source",
        "partial",
        "pool_maps_played",
        "player_count",
        "maps_played",
      ]),
    ];
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
    return file("\uFEFF" + lines.join("\r\n"), `lobbyfinder-lobbies-${stamp}.csv`, "text/csv");
  }

  const payload = { exported_at: new Date().toISOString(), lobby_count: hits.length, lobbies: hits };
  return file(JSON.stringify(payload, null, 2), `lobbyfinder-export-${stamp}.json`, "application/json");
}
