import { bad, json, readJson, requireTenant } from "@/lib/api";
import { clearRoster, getRoster, saveRoster } from "@/lib/redis";
import type { Roster, RosterTeam } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { slug: string } };

export async function GET(_req: Request, { params }: Ctx) {
  const t = await requireTenant(params.slug, "public");
  if (!t.ok) return t.res;
  return json({ roster: await getRoster(t.tenant.slug) });
}

export async function POST(req: Request, { params }: Ctx) {
  const t = await requireTenant(params.slug, "edit");
  if (!t.ok) return t.res;
  const body = await readJson<{ source_url?: unknown; sheet_name?: unknown; teams?: unknown }>(req);
  if (!body) return bad("invalid request");

  const rawTeams = Array.isArray(body.teams) ? body.teams : null;
  if (!rawTeams || rawTeams.length === 0) return bad("no teams provided");
  if (rawTeams.length > 256) return bad("too many teams");

  const teams: RosterTeam[] = [];
  for (const rt of rawTeams) {
    const name = typeof rt?.name === "string" ? rt.name.trim().slice(0, 60) : "";
    const rawPlayers = Array.isArray(rt?.players) ? rt.players : [];
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
  if (teams.length === 0) return bad("no valid teams after validation");

  const roster: Roster = {
    source_url: typeof body.source_url === "string" ? body.source_url.slice(0, 500) : "",
    sheet_name: typeof body.sheet_name === "string" ? body.sheet_name.slice(0, 100) : "",
    synced_at: new Date().toISOString(),
    teams,
  };
  await saveRoster(t.tenant.slug, roster);
  const players = teams.reduce((n, tm) => n + tm.players.length, 0);
  return json({ ok: true, teams: teams.length, players });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const t = await requireTenant(params.slug, "edit");
  if (!t.ok) return t.res;
  await clearRoster(t.tenant.slug);
  return json({ ok: true });
}
