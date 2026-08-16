import { bad, json, requireTenant } from "@/lib/api";
import { getAllTenantHits, getRoster } from "@/lib/redis";
import { normalizeName } from "@/lib/rosterParse";
import type { CellScore, GridTeam, TeamsGridData } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { slug: string } };

export async function GET(_req: Request, { params }: Ctx) {
  const t = await requireTenant(params.slug, "public");
  if (!t.ok) return t.res;
  try {
    const slug = t.tenant.slug;
    const pool = t.tenant.pool; // grid columns, in pool-editor order
    const poolSet = new Set(pool);
    const [roster, hits] = await Promise.all([getRoster(slug), getAllTenantHits(slug, pool)]);

    // map metadata + username->id + per-user-per-map scores, newest hits first
    const mapMeta = new Map<number, { title: string | null; version: string | null }>();
    const nameToId = new Map<string, number>();
    const scores = new Map<number, Map<number, CellScore[]>>(); // user_id -> beatmap_id -> scores

    for (const h of hits) {
      for (const p of h.players ?? []) {
        const key = normalizeName(p.username);
        if (!nameToId.has(key)) nameToId.set(key, p.user_id);
      }
      for (const g of h.games) {
        if (!poolSet.has(g.beatmap_id)) continue;
        if (!mapMeta.has(g.beatmap_id)) mapMeta.set(g.beatmap_id, { title: g.title, version: g.version });
        for (const s of g.scores ?? []) {
          let byMap = scores.get(s.user_id);
          if (!byMap) scores.set(s.user_id, (byMap = new Map()));
          let list = byMap.get(g.beatmap_id);
          if (!list) byMap.set(g.beatmap_id, (list = []));
          list.push({
            score: s.score,
            accuracy: s.accuracy,
            mods: s.mods,
            passed: s.passed,
            played_at: g.played_at ?? h.start_time,
            match_id: h.match_id,
            match_url: h.match_url,
          });
        }
      }
    }

    const teams: GridTeam[] = (roster?.teams ?? []).map((tm) => ({
      name: tm.name,
      players: tm.players.map((p) => {
        const uid = p.user_id ?? nameToId.get(normalizeName(p.name)) ?? null;
        const byMap = uid !== null ? scores.get(uid) : undefined;
        const cells = pool.map((bid) => {
          const list = byMap?.get(bid);
          if (!list || list.length === 0) return null;
          return [...list].sort((a, b) => b.score - a.score);
        });
        return { name: p.name, user_id: uid, matched: uid !== null, by_name: p.user_id === null && uid !== null, cells };
      }),
    }));

    const body: TeamsGridData = {
      maps: pool.map((bid) => ({
        beatmap_id: bid,
        title: mapMeta.get(bid)?.title ?? null,
        version: mapMeta.get(bid)?.version ?? null,
        url: `https://osu.ppy.sh/b/${bid}`,
      })),
      teams,
      roster_synced_at: roster?.synced_at ?? null,
      roster_source_url: roster?.source_url ?? null,
      generated_at: new Date().toISOString(),
    };
    return json(body);
  } catch (e) {
    return bad((e as Error).message, 500);
  }
}
