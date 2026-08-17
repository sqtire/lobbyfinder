"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { StatsSettingsLite } from "@/lib/types";
import { fmtNum } from "@/lib/format";

// Kept in sync with lib/stats.ts (client bundles must not import the engine).
const METHODS: {
  id: StatsSettingsLite["method"];
  label: string;
  blurb: string;
}[] = [
  {
    id: "zsum",
    label: "Z-Sum",
    blurb:
      "Σ over maps of Φ((score − mean) / stdev): how many standard deviations above the field, summed. Higher is better.",
  },
  {
    id: "placements",
    label: "Avg. placements",
    blurb:
      "Rank on each map (1 = best, ties share, unplayed = last), averaged. Lower is better.",
  },
  {
    id: "maxpct",
    label: "Max %",
    blurb: "score / best score on each map, averaged.",
  },
  {
    id: "pctdiff",
    label: "% difference",
    blurb: "(score − lowest) / best on each map, averaged.",
  },
  {
    id: "zipf",
    label: "Zipfian",
    blurb: "100 / (rank + maps × 1.4) on each map, averaged.",
  },
];

type View =
  "teams" | "players" | "map-teams" | "map-players" | "performance" | "mappool";

interface MapCell {
  score: number;
  placement: number | null;
  value: number;
  acc?: number | null;
  mods?: string[];
  match_id?: number | null;
}
interface StatsData {
  generated_at: string;
  settings: StatsSettingsLite;
  method_label: string;
  aggregate_label: string;
  maps: {
    beatmap_id: number;
    title: string | null;
    version: string | null;
    url: string;
  }[];
  has_roster: boolean;
  teams: {
    rank: number;
    name: string;
    aggregate: number;
    avg_score: number;
    maps_played: number;
    cells: MapCell[];
  }[];
  players: {
    rank: number;
    name: string;
    user_id: number | null;
    team: string | null;
    aggregate: number;
    avg_score: number;
    avg_acc: number | null;
    maps_played: number;
    cells: MapCell[];
  }[];
  team_leaderboards: {
    rank: number;
    team: string;
    team_score: number;
    match_id: number | null;
    players: {
      name: string;
      user_id: number | null;
      score: number;
      acc: number | null;
      mods: string[];
      passed: boolean;
    }[];
  }[][];
  player_leaderboards: {
    rank: number;
    name: string;
    user_id: number | null;
    team: string | null;
    score: number;
    acc: number | null;
    mods: string[];
    passed: boolean;
    match_id: number | null;
  }[][];
  performance: {
    rank: number;
    name: string;
    user_id: number | null;
    team: string | null;
    match_cost: number;
    lobbies: number;
    played: number;
    played_pct: number;
    mvps: number;
    avg_score: number;
    avg_acc: number | null;
    best: { beatmap_id: number; score: number; match_id: number | null } | null;
  }[];
  mappool: {
    beatmap_id: number;
    plays: number;
    best_player: {
      name: string;
      user_id: number | null;
      score: number;
      acc: number | null;
      mods: string[];
      match_id: number | null;
    } | null;
    best_team: { team: string; score: number; match_id: number | null } | null;
    avg_score: number | null;
    avg_acc: number | null;
    avg_team_score: number | null;
  }[];
  lobbies_used: number;
  notes: string[];
  saved_settings: StatsSettingsLite;
}

const fmtScore = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtAcc = (a: number | null | undefined) =>
  typeof a === "number" ? `${(a * 100).toFixed(2)}%` : "—";
const fmtAgg = (v: number, method: StatsSettingsLite["method"]) =>
  method === "placements"
    ? v.toFixed(2)
    : method === "zipf"
      ? v.toFixed(3)
      : v.toFixed(4);
const dispMods = (mods: string[] | undefined) =>
  (mods ?? []).filter((m) => m !== "NF").join("") || "NM";
const mapShort = (m: {
  beatmap_id: number;
  title: string | null;
  version: string | null;
}) =>
  m.title
    ? `${m.title}${m.version ? ` [${m.version}]` : ""}`
    : `#${m.beatmap_id}`;
const profile = (id: number | null) =>
  id ? `https://osu.ppy.sh/users/${id}` : undefined;
const mpUrl = (id: number | null | undefined) =>
  id ? `https://osu.ppy.sh/community/matches/${id}` : undefined;

export default function StatsPanel({
  slug,
  canEdit,
  savedSettings,
}: {
  slug: string;
  canEdit: boolean;
  savedSettings: StatsSettingsLite;
}) {
  const [settings, setSettings] = useState<StatsSettingsLite>(savedSettings);
  const [data, setData] = useState<StatsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("teams");
  const [mapIdx, setMapIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const query = useMemo(() => {
    const q = new URLSearchParams();
    q.set("method", settings.method);
    q.set("count_failed", settings.count_failed ? "1" : "0");
    q.set("players_per_map", String(settings.players_per_map));
    q.set("mc_mod_scaling", settings.mc_mod_scaling ? "1" : "0");
    return q.toString();
  }, [settings]);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/t/${slug}/stats?${query}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as StatsData);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [slug, query]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (data && !data.has_roster && (view === "teams" || view === "map-teams"))
      setView("players");
  }, [data, view]);

  async function saveDefaults() {
    const res = await fetch(`/api/t/${slug}/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stats: settings }),
    });
    setSaved(
      res.ok ? "Saved as this tournament's default view." : "Save failed.",
    );
    setTimeout(() => setSaved(null), 3000);
  }

  const method = METHODS.find((m) => m.id === settings.method)!;
  const dirty =
    data && JSON.stringify(settings) !== JSON.stringify(data.saved_settings);

  return (
    <div>
      <div className="stats-controls">
        <label className="hint">
          Method{" "}
          <select
            className="input"
            style={{ maxWidth: 170 }}
            value={settings.method}
            onChange={(e) =>
              setSettings({
                ...settings,
                method: e.target.value as StatsSettingsLite["method"],
              })
            }
          >
            {METHODS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label
          className="hint"
          title="Number of a team's scores that count toward its map score (0 = everyone who played)"
        >
          Scores/team/map{" "}
          <input
            className="input"
            style={{ width: 64 }}
            inputMode="numeric"
            value={settings.players_per_map}
            onChange={(e) =>
              setSettings({
                ...settings,
                players_per_map: Math.max(
                  0,
                  Math.min(
                    16,
                    Number(e.target.value.replace(/[^0-9]/g, "")) || 0,
                  ),
                ),
              })
            }
          />
        </label>
        <label
          className="hint"
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          <input
            type="checkbox"
            checked={settings.count_failed}
            onChange={(e) =>
              setSettings({ ...settings, count_failed: e.target.checked })
            }
          />{" "}
          count failed
        </label>
        <label
          className="hint"
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          title="Stats v5 divides each score by its mod multiplier before dividing by the raw field average, which penalises mod maps; on = sheet-identical numbers"
        >
          <input
            type="checkbox"
            checked={settings.mc_mod_scaling}
            onChange={(e) =>
              setSettings({ ...settings, mc_mod_scaling: e.target.checked })
            }
          />{" "}
          MC mod scaling
        </label>
        {canEdit && (
          <>
            <button
              className="btn ghost"
              style={{ padding: "4px 10px", fontSize: 12 }}
              disabled={!dirty}
              onClick={saveDefaults}
            >
              Save as default
            </button>
            <a
              className="btn ghost"
              style={{ padding: "4px 10px", fontSize: 12 }}
              href={`/api/t/${slug}/export?format=stats&${query}`}
              download
            >
              Export stats (.xlsx)
            </a>
            <a
              className="btn ghost"
              style={{ padding: "4px 10px", fontSize: 12 }}
              href={`/api/t/${slug}/export?format=grid`}
              download
            >
              Export grid (.csv)
            </a>
          </>
        )}
        {saved && <span className="hint">{saved}</span>}
      </div>
      <p className="hint" style={{ margin: "6px 0 10px" }}>
        {method.blurb} Ranking ties break on average score.{" "}
        {data
          ? `${fmtNum(data.lobbies_used)} lobbies · ${fmtNum(data.players.length)} players${data.has_roster ? ` · ${fmtNum(data.teams.length)} teams` : ""}.`
          : ""}
      </p>
      {data?.notes.map((n, i) => (
        <div key={i} className="toast" style={{ marginBottom: 8 }}>
          {n}
        </div>
      ))}

      <div className="tabs" style={{ marginBottom: 10, flexWrap: "wrap" }}>
        {data?.has_roster && (
          <button
            className={`tab ${view === "teams" ? "active" : ""}`}
            onClick={() => setView("teams")}
          >
            Team placements
          </button>
        )}
        <button
          className={`tab ${view === "players" ? "active" : ""}`}
          onClick={() => setView("players")}
        >
          Player placements
        </button>
        {data?.has_roster && (
          <button
            className={`tab ${view === "map-teams" ? "active" : ""}`}
            onClick={() => setView("map-teams")}
          >
            Team leaderboards
          </button>
        )}
        <button
          className={`tab ${view === "map-players" ? "active" : ""}`}
          onClick={() => setView("map-players")}
        >
          Player leaderboards
        </button>
        <button
          className={`tab ${view === "performance" ? "active" : ""}`}
          onClick={() => setView("performance")}
        >
          Performance
        </button>
        <button
          className={`tab ${view === "mappool" ? "active" : ""}`}
          onClick={() => setView("mappool")}
        >
          Mappool
        </button>
      </div>

      {error && (
        <div className="empty">Couldn&apos;t load stats ({error}).</div>
      )}
      {!data && !error && <div className="empty">Computing…</div>}
      {data && data.maps.length === 0 && (
        <div className="empty">No beatmap pool set — stats need pool maps.</div>
      )}
      {data && data.maps.length > 0 && data.players.length === 0 && (
        <div className="empty">No scores logged yet.</div>
      )}
      {data && data.maps.length > 0 && data.players.length > 0 && (
        <div className={`tgrid-wrap ${busy ? "dim" : ""}`}>
          {view === "teams" && <PlacementsTable kind="teams" data={data} />}
          {view === "players" && <PlacementsTable kind="players" data={data} />}
          {(view === "map-teams" || view === "map-players") && (
            <>
              <div
                className="row"
                style={{ marginBottom: 8, flexWrap: "wrap" }}
              >
                {data.maps.map((m, i) => (
                  <button
                    key={m.beatmap_id}
                    className={`tab ${mapIdx === i ? "active" : ""}`}
                    style={{ fontSize: 12 }}
                    onClick={() => setMapIdx(i)}
                    title={mapShort(m)}
                  >
                    {i + 1}.{" "}
                    {m.title
                      ? m.title.slice(0, 18) + (m.title.length > 18 ? "…" : "")
                      : `#${m.beatmap_id}`}
                  </button>
                ))}
              </div>
              {view === "map-teams" ? (
                <TeamLeaderboard data={data} mapIdx={mapIdx} />
              ) : (
                <PlayerLeaderboard data={data} mapIdx={mapIdx} />
              )}
            </>
          )}
          {view === "performance" && <PerformanceTable data={data} />}
          {view === "mappool" && <MappoolTable data={data} />}
        </div>
      )}
    </div>
  );
}

function PlacementsTable({
  kind,
  data,
}: {
  kind: "teams" | "players";
  data: StatsData;
}) {
  const rows = kind === "teams" ? data.teams : data.players;
  return (
    <table className="tgrid stable">
      <thead>
        <tr>
          <th className="col-team">#</th>
          <th className="col-player">{kind === "teams" ? "Team" : "Player"}</th>
          {kind === "players" && <th>Team</th>}
          <th>
            {data.aggregate_label}{" "}
            {data.settings.method === "placements" ? "▲" : "▼"}
          </th>
          <th>Avg score</th>
          {kind === "players" && <th>Avg acc</th>}
          <th>Maps</th>
          {data.maps.map((m, i) => (
            <th key={m.beatmap_id} className="col-map">
              <a
                href={m.url}
                target="_blank"
                rel="noreferrer"
                title={mapShort(m)}
              >
                <div className="map-title">
                  {i + 1}. {m.title ?? `#${m.beatmap_id}`}
                </div>
                <div className="map-sub">
                  {m.version ?? `b/${m.beatmap_id}`}
                </div>
              </a>
              <div className="map-sub"># · score</div>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const uid =
            kind === "players"
              ? (r as StatsData["players"][number]).user_id
              : null;
          return (
            <tr key={r.rank}>
              <td className="col-team">{r.rank}</td>
              <td className="col-player">
                {uid ? (
                  <a href={profile(uid)} target="_blank" rel="noreferrer">
                    {r.name}
                  </a>
                ) : (
                  r.name
                )}
              </td>
              {kind === "players" && (
                <td className="hint">
                  {(r as StatsData["players"][number]).team ?? "—"}
                </td>
              )}
              <td className="mono">
                {fmtAgg(r.aggregate, data.settings.method)}
              </td>
              <td className="mono">{fmtScore(r.avg_score)}</td>
              {kind === "players" && (
                <td className="mono">
                  {fmtAcc((r as StatsData["players"][number]).avg_acc)}
                </td>
              )}
              <td className="mono">
                {r.maps_played}/{data.maps.length}
              </td>
              {r.cells.map((c, i) => (
                <td key={i} className="mono cell">
                  {c.placement === null ? (
                    <span className="hint">—</span>
                  ) : (
                    <>
                      <span className={`place p${Math.min(c.placement, 4)}`}>
                        #{c.placement}
                      </span>{" "}
                      <span className="hint">{fmtScore(c.score)}</span>
                    </>
                  )}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function TeamLeaderboard({
  data,
  mapIdx,
}: {
  data: StatsData;
  mapIdx: number;
}) {
  const entries = data.team_leaderboards[mapIdx] ?? [];
  return (
    <table className="tgrid stable">
      <thead>
        <tr>
          <th className="col-team">#</th>
          <th className="col-player">Team</th>
          <th>Team score ▼</th>
          <th>Players (score · acc · mods)</th>
          <th>Match</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.team}>
            <td className="col-team">{e.rank}</td>
            <td className="col-player">{e.team}</td>
            <td className="mono">{fmtScore(e.team_score)}</td>
            <td>
              {e.players.map((p) => (
                <span key={p.name} className="lb-player">
                  <a href={profile(p.user_id)} target="_blank" rel="noreferrer">
                    {p.name}
                  </a>{" "}
                  <span className="mono">{fmtScore(p.score)}</span>{" "}
                  <span className="hint">{fmtAcc(p.acc)}</span>{" "}
                  <span className="modchip">{dispMods(p.mods)}</span>
                  {!p.passed && <span className="badge open">F</span>}
                </span>
              ))}
            </td>
            <td className="mono">
              <a href={mpUrl(e.match_id)} target="_blank" rel="noreferrer">
                {e.match_id ? `#${e.match_id}` : "—"}
              </a>
            </td>
          </tr>
        ))}
        {entries.length === 0 && (
          <tr>
            <td colSpan={5} className="hint">
              No team scores on this map yet.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function PlayerLeaderboard({
  data,
  mapIdx,
}: {
  data: StatsData;
  mapIdx: number;
}) {
  const entries = data.player_leaderboards[mapIdx] ?? [];
  return (
    <table className="tgrid stable">
      <thead>
        <tr>
          <th className="col-team">#</th>
          <th className="col-player">Player</th>
          <th>Team</th>
          <th>Score ▼</th>
          <th>Acc</th>
          <th>Mods</th>
          <th>Match</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={`${e.user_id}-${e.rank}`}>
            <td className="col-team">{e.rank}</td>
            <td className="col-player">
              <a href={profile(e.user_id)} target="_blank" rel="noreferrer">
                {e.name}
              </a>
              {!e.passed && (
                <span className="badge open" style={{ marginLeft: 6 }}>
                  F
                </span>
              )}
            </td>
            <td className="hint">{e.team ?? "—"}</td>
            <td className="mono">{fmtScore(e.score)}</td>
            <td className="mono">{fmtAcc(e.acc)}</td>
            <td>
              <span className="modchip">{dispMods(e.mods)}</span>
            </td>
            <td className="mono">
              <a href={mpUrl(e.match_id)} target="_blank" rel="noreferrer">
                {e.match_id ? `#${e.match_id}` : "—"}
              </a>
            </td>
          </tr>
        ))}
        {entries.length === 0 && (
          <tr>
            <td colSpan={7} className="hint">
              No scores on this map yet.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function PerformanceTable({ data }: { data: StatsData }) {
  const mapById = new Map(data.maps.map((m) => [m.beatmap_id, m]));
  return (
    <table className="tgrid stable">
      <thead>
        <tr>
          <th className="col-team">#</th>
          <th className="col-player">Player</th>
          <th>Team</th>
          <th title="2/(n+2) · Σ score / field average of the map, per lobby; mean over lobbies">
            MC ▼
          </th>
          <th>Played</th>
          <th>MVPs</th>
          <th>Avg score</th>
          <th>Avg acc</th>
          <th>Highest score</th>
        </tr>
      </thead>
      <tbody>
        {data.performance.map((p) => (
          <tr key={p.rank}>
            <td className="col-team">{p.rank}</td>
            <td className="col-player">
              <a href={profile(p.user_id)} target="_blank" rel="noreferrer">
                {p.name}
              </a>
            </td>
            <td className="hint">{p.team ?? "—"}</td>
            <td className="mono">{p.match_cost.toFixed(4)}</td>
            <td className="mono">
              {p.played}/{data.maps.length}{" "}
              <span className="hint">({Math.round(p.played_pct * 100)}%)</span>
            </td>
            <td className="mono">{p.mvps || "—"}</td>
            <td className="mono">{fmtScore(p.avg_score)}</td>
            <td className="mono">{fmtAcc(p.avg_acc)}</td>
            <td className="mono">
              {p.best ? (
                <>
                  {fmtScore(p.best.score)}{" "}
                  <span className="hint">
                    on{" "}
                    {mapById.get(p.best.beatmap_id)?.title ??
                      `#${p.best.beatmap_id}`}
                  </span>{" "}
                  <a
                    href={mpUrl(p.best.match_id)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {p.best.match_id ? `#${p.best.match_id}` : ""}
                  </a>
                </>
              ) : (
                "—"
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MappoolTable({ data }: { data: StatsData }) {
  return (
    <table className="tgrid stable">
      <thead>
        <tr>
          <th className="col-team">#</th>
          <th className="col-player">Map</th>
          <th>Plays</th>
          <th>Best player</th>
          {data.has_roster && <th>Best team</th>}
          <th>Avg score</th>
          <th>Avg acc</th>
          {data.has_roster && <th>Avg team score</th>}
        </tr>
      </thead>
      <tbody>
        {data.mappool.map((m, i) => {
          const meta = data.maps[i]!;
          return (
            <tr key={m.beatmap_id}>
              <td className="col-team">{i + 1}</td>
              <td className="col-player">
                <a href={meta.url} target="_blank" rel="noreferrer">
                  {mapShort(meta)}
                </a>
              </td>
              <td className="mono">{m.plays}</td>
              <td>
                {m.best_player ? (
                  <>
                    <a
                      href={profile(m.best_player.user_id)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {m.best_player.name}
                    </a>{" "}
                    <span className="mono">
                      {fmtScore(m.best_player.score)}
                    </span>{" "}
                    <span className="hint">{fmtAcc(m.best_player.acc)}</span>{" "}
                    <span className="modchip">
                      {dispMods(m.best_player.mods)}
                    </span>{" "}
                    <a
                      className="hint"
                      href={mpUrl(m.best_player.match_id)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {m.best_player.match_id
                        ? `#${m.best_player.match_id}`
                        : ""}
                    </a>
                  </>
                ) : (
                  "—"
                )}
              </td>
              {data.has_roster && (
                <td>
                  {m.best_team ? (
                    <>
                      {m.best_team.team}{" "}
                      <span className="mono">
                        {fmtScore(m.best_team.score)}
                      </span>{" "}
                      <a
                        className="hint"
                        href={mpUrl(m.best_team.match_id)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {m.best_team.match_id ? `#${m.best_team.match_id}` : ""}
                      </a>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
              )}
              <td className="mono">
                {m.avg_score !== null ? fmtScore(m.avg_score) : "—"}
              </td>
              <td className="mono">{fmtAcc(m.avg_acc)}</td>
              {data.has_roster && (
                <td className="mono">
                  {m.avg_team_score !== null ? fmtScore(m.avg_team_score) : "—"}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
