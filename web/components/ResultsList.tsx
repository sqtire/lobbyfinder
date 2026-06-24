"use client";

import { useState } from "react";
import type { Hit } from "@/lib/types";
import { fmtAgo, fmtDateTime } from "@/lib/format";

function CopyId({ id }: { id: number }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copybtn"
      title="Copy match ID (use as a rescan start point)"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(String(id));
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {done ? "copied" : `#${id}`}
    </button>
  );
}

function GameRow({ g }: { g: Hit["games"][number] }) {
  const name = g.title ? `${g.title}${g.version ? ` [${g.version}]` : ""}` : `beatmap ${g.beatmap_id}`;
  return (
    <div className="game">
      <a className="bid" href={g.beatmap_url} target="_blank" rel="noreferrer">
        {g.beatmap_id}
      </a>
      <span>{name}</span>
      {g.mods.length > 0 && <span className="mods">+{g.mods.join("")}</span>}
      <span className="gmeta">
        {g.scoring_type ?? ""}
        {g.scores_count ? ` · ${g.scores_count}p` : ""}
        {g.played_at ? ` · ${fmtDateTime(g.played_at)}` : ""}
      </span>
    </div>
  );
}

export default function ResultsList({ hits }: { hits: Hit[] }) {
  if (hits.length === 0) {
    return (
      <div className="empty">
        No lobbies matched yet. Once the scanner is running with a pool set, any lobby that plays one of your maps
        lands here.
      </div>
    );
  }
  return (
    <div>
      {hits.map((h) => (
        <div className="hit" key={h.match_id}>
          <div className="hit-top">
            <div>
              <a className="hit-name" href={h.match_url} target="_blank" rel="noreferrer">
                {h.match_name || `Match ${h.match_id}`}
              </a>
              <CopyId id={h.match_id} />
              {h.still_open && <span className="badge open">open</span>}
              <span className={`badge ${h.source}`}>{h.source}</span>
            </div>
            <div className="hit-meta">
              {h.start_time ? fmtDateTime(h.start_time) : "—"} · found {fmtAgo(h.found_at)}
            </div>
          </div>
          <div className="games">
            {h.games.map((g) => (
              <GameRow key={g.game_id} g={g} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
