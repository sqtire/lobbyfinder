"use client";

import { useEffect, useState } from "react";
import type { CellScore, TeamsGridData } from "@/lib/types";
import { fmtDateTime, fmtNum } from "@/lib/format";

const profileUrl = (id: number) => `https://osu.ppy.sh/users/${id}`;
const fmtScore = (n: number) => n.toLocaleString("en-US");
const fmtAcc = (a: number) => `${(a * 100).toFixed(2)}%`;
const dispMods = (mods: string[]) => mods.filter((m) => m !== "NF").join("");

export default function TeamsGrid() {
  const [data, setData] = useState<TeamsGridData | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<string | null>(null); // "teamIdx:playerIdx:mapIdx"

  useEffect(() => {
    let live = true;
    fetch("/api/teams", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => live && setData(d as TeamsGridData))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, []);

  if (error) return <div className="empty">Couldn&apos;t load the teams grid.</div>;
  if (!data) return <div className="empty">Loading…</div>;
  if (!data.roster_synced_at || data.teams.length === 0) {
    return (
      <div className="empty">
        No roster synced yet. Unlock editing and sync a tournament mainsheet to populate this tab.
      </div>
    );
  }
  if (data.maps.length === 0) {
    return <div className="empty">No beatmap pool set — add pool maps to get grid columns.</div>;
  }

  const playerCount = data.teams.reduce((n, t) => n + t.players.length, 0);

  return (
    <>
      <div className="tgrid-meta mono">
        {fmtNum(data.teams.length)} teams · {fmtNum(playerCount)} players · {data.maps.length} maps
      </div>
      <div className="tgrid-wrap">
        <table className="tgrid">
          <thead>
            <tr>
              <th className="col-team">Team</th>
              <th className="col-player">Player</th>
              {data.maps.map((m) => (
                <th key={m.beatmap_id} className="col-map">
                  <a href={m.url} target="_blank" rel="noreferrer" title={`${m.title ?? ""} [${m.version ?? ""}]`}>
                    <span className="map-title">{m.title ?? `#${m.beatmap_id}`}</span>
                    <span className="map-sub">{m.version ?? `b/${m.beatmap_id}`}</span>
                  </a>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.teams.map((t, ti) =>
              t.players.map((p, pi) => {
                const rowKey = `${ti}:${pi}`;
                const openMap = open?.startsWith(rowKey + ":") ? Number(open.split(":")[2]) : null;
                return (
                  <FragmentRow
                    key={rowKey}
                    teamName={t.name}
                    teamSpan={pi === 0 ? t.players.length : 0}
                    p={p}
                    maps={data.maps}
                    openMap={openMap}
                    onToggle={(mi) => setOpen(open === `${rowKey}:${mi}` ? null : `${rowKey}:${mi}`)}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function FragmentRow({
  teamName,
  teamSpan,
  p,
  maps,
  openMap,
  onToggle,
}: {
  teamName: string;
  teamSpan: number;
  p: TeamsGridData["teams"][number]["players"][number];
  maps: TeamsGridData["maps"];
  openMap: number | null;
  onToggle: (mapIdx: number) => void;
}) {
  const detail = openMap !== null ? p.cells[openMap] : null;
  return (
    <>
      <tr>
        {teamSpan > 0 && (
          <td className="col-team" rowSpan={teamSpan * 2}>
            {teamName}
          </td>
        )}
        <td className="col-player">
          {p.user_id ? (
            <a href={profileUrl(p.user_id)} target="_blank" rel="noreferrer">
              {p.name}
            </a>
          ) : (
            <span title="Not seen in any scanned lobby yet">{p.name}</span>
          )}
          {p.by_name && <span className="nbadge" title="Matched by username (no profile link in sheet)">n</span>}
        </td>
        {p.cells.map((cell, mi) => {
          if (!cell || cell.length === 0) {
            return (
              <td key={mi} className="col-map np">
                Not Played
              </td>
            );
          }
          const best = cell[0]!;
          const mods = dispMods(best.mods);
          return (
            <td key={mi} className="col-map">
              <button
                className={`cellbtn ${openMap === mi ? "on" : ""} ${best.passed ? "" : "failed"}`}
                onClick={() => onToggle(mi)}
                title={`${fmtAcc(best.accuracy)}${mods ? ` · ${mods}` : ""}${best.passed ? "" : " · failed"} — click for all scores`}
              >
                {fmtScore(best.score)}
                {mods && <span className="modchip">{mods}</span>}
                {cell.length > 1 && <span className="xn">×{cell.length}</span>}
              </button>
            </td>
          );
        })}
      </tr>
      <tr className={`detail-tr ${detail ? "show" : ""}`}>
        <td colSpan={1 + maps.length} className="detail-td">
          {detail && openMap !== null && (
            <div className="detail-strip">
              <span className="detail-map">
                {maps[openMap]!.title ?? `#${maps[openMap]!.beatmap_id}`} — all scores for {p.name}:
              </span>
              {detail.map((s, i) => (
                <ScoreLine key={i} s={s} />
              ))}
            </div>
          )}
        </td>
      </tr>
    </>
  );
}

function ScoreLine({ s }: { s: CellScore }) {
  const mods = dispMods(s.mods);
  return (
    <span className={`scoreline ${s.passed ? "" : "failed"}`}>
      <b>{fmtScore(s.score)}</b> · {fmtAcc(s.accuracy)}
      {mods ? ` · ${mods}` : ""}
      {s.passed ? "" : " · failed"}
      {s.played_at ? ` · ${fmtDateTime(s.played_at)}` : ""} ·{" "}
      <a href={s.match_url} target="_blank" rel="noreferrer">
        lobby ↗
      </a>
    </span>
  );
}
