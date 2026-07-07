import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { getRoster, saveRoster, clearRoster } from "@/lib/redis";
import type { Roster, RosterTeam } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ roster: await getRoster() });
}

export async function POST(req: Request) {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { source_url?: unknown; sheet_name?: unknown; teams?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  const rawTeams = Array.isArray(body.teams) ? body.teams : null;
  if (!rawTeams || rawTeams.length === 0) return NextResponse.json({ error: "no teams provided" }, { status: 400 });
  if (rawTeams.length > 256) return NextResponse.json({ error: "too many teams" }, { status: 400 });

  const teams: RosterTeam[] = [];
  for (const t of rawTeams) {
    const name = typeof t?.name === "string" ? t.name.trim().slice(0, 60) : "";
    const rawPlayers = Array.isArray(t?.players) ? t.players : [];
    if (!name || rawPlayers.length === 0 || rawPlayers.length > 64) continue;
    const players = [];
    for (const p of rawPlayers) {
      const pname = typeof p?.name === "string" ? p.name.trim().slice(0, 40) : "";
      if (!pname) continue;
      const uid = Number.isInteger(p?.user_id) && p.user_id > 0 ? (p.user_id as number) : null;
      players.push({ name: pname, user_id: uid });
    }
    if (players.length) teams.push({ name, players });
  }
  if (teams.length === 0) return NextResponse.json({ error: "no valid teams after validation" }, { status: 400 });

  const roster: Roster = {
    source_url: typeof body.source_url === "string" ? body.source_url.slice(0, 500) : "",
    sheet_name: typeof body.sheet_name === "string" ? body.sheet_name.slice(0, 100) : "",
    synced_at: new Date().toISOString(),
    teams,
  };
  await saveRoster(roster);
  const players = teams.reduce((n, t) => n + t.players.length, 0);
  return NextResponse.json({ ok: true, teams: teams.length, players });
}

export async function DELETE() {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await clearRoster();
  return NextResponse.json({ ok: true });
}
