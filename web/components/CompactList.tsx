"use client";

import { useState } from "react";
import type { Hit } from "@/lib/types";
import { fmtDateTime, fmtNum } from "@/lib/format";

const profileUrl = (id: number) => `https://osu.ppy.sh/users/${id}`;

export default function CompactList({
  hits,
  authed,
  hiddenCount,
  onChanged,
}: {
  hits: Hit[];
  authed: boolean;
  hiddenCount: number;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const toggleOpen = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleSel = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const allSelected = hits.length > 0 && hits.every((h) => selected.has(h.match_id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(hits.map((h) => h.match_id)));

  async function post(payload: object) {
    setBusy(true);
    try {
      const res = await fetch("/api/hits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(String(res.status));
      setSelected(new Set());
      onChanged();
    } catch {
      /* leave selection intact so the user can retry */
    } finally {
      setBusy(false);
    }
  }

  const removeSelected = () => {
    if (selected.size === 0) return;
    void post({ action: "remove", match_ids: [...selected] });
  };
  const restoreAll = () => void post({ action: "reset_hidden" });

  if (hits.length === 0) {
    return <div className="empty">No lobbies flagged yet. Maps in your pool will show up here once played.</div>;
  }

  return (
    <>
      {authed && (
        <div className="ctable-actions">
          <button className="btn-sm danger" onClick={removeSelected} disabled={busy || selected.size === 0}>
            Remove {selected.size > 0 ? `${selected.size} selected` : "selected"}
          </button>
          <span className="ctable-actions-hint">
            Tombstoned lobbies won&apos;t come back, even on rescan.
            {hiddenCount > 0 && (
              <>
                {" "}
                <button className="linkbtn" onClick={restoreAll} disabled={busy}>
                  restore all ({fmtNum(hiddenCount)} hidden)
                </button>
              </>
            )}
          </span>
        </div>
      )}

      <div className={`ctable ${authed ? "authed" : ""}`}>
        <div className="ctable-head">
          {authed && (
            <span>
              <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
            </span>
          )}
          <span />
          <span>Lobby</span>
          <span className="ctable-when">Played</span>
          <span className="ctable-num">Maps</span>
          <span className="ctable-num">Players</span>
        </div>

        {hits.map((h) => {
          const players = h.players ?? [];
          const hasPlayers = players.length > 0;
          const isOpen = open.has(h.match_id);
          const isSel = selected.has(h.match_id);
          return (
            <div className="ctable-block" key={h.match_id}>
              <div className={`ctable-row ${isOpen ? "is-open" : ""} ${isSel ? "is-sel" : ""}`}>
                {authed && (
                  <span>
                    <input
                      type="checkbox"
                      checked={isSel}
                      onChange={() => toggleSel(h.match_id)}
                      aria-label={`Select ${h.match_name || h.match_id}`}
                    />
                  </span>
                )}

                <button
                  className={`caret ${hasPlayers ? "" : "disabled"}`}
                  onClick={() => hasPlayers && toggleOpen(h.match_id)}
                  aria-label={isOpen ? "Hide players" : "Show players"}
                  title={hasPlayers ? (isOpen ? "Hide players" : "Show players") : "No player data — rescan to populate"}
                  disabled={!hasPlayers}
                >
                  {hasPlayers ? (isOpen ? "▾" : "▸") : "·"}
                </button>

                <a className="ctable-name" href={h.match_url} target="_blank" rel="noreferrer" title={h.match_name}>
                  {h.match_name || `Match ${h.match_id}`}
                </a>

                <span className="ctable-when mono">{h.start_time ? fmtDateTime(h.start_time) : "—"}</span>
                <span className="ctable-num mono">{fmtNum(h.games.length)}</span>
                <span className="ctable-num mono">{hasPlayers ? fmtNum(players.length) : "—"}</span>
              </div>

              {isOpen && hasPlayers && (
                <div className="ctable-players">
                  {players.map((p) => (
                    <a
                      className="player-chip"
                      key={p.user_id}
                      href={profileUrl(p.user_id)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <span className="player-name">{p.username}</span>
                      <span className="player-count mono">{p.maps_played}</span>
                    </a>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
