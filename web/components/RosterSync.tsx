"use client";

import { useCallback, useEffect, useState } from "react";
import type { Roster } from "@/lib/types";
import { fmtAgo, fmtNum } from "@/lib/format";

interface PreviewPlayer {
  name: string;
  user_id: number | null;
  via: "link" | "name";
}
interface PreviewTeam {
  name: string;
  label_via: string;
  players: PreviewPlayer[];
}
interface Preview {
  source_url: string;
  sheet_name: string;
  teams: PreviewTeam[];
  warnings: string[];
  anchor_count: number;
}

export default function RosterSync() {
  const [roster, setRoster] = useState<Roster | null>(null);
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const flash = (kind: "ok" | "err", msg: string) => {
    setToast({ kind, msg });
    setTimeout(() => setToast(null), 6000);
  };

  const loadCurrent = useCallback(async () => {
    try {
      const res = await fetch("/api/roster", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { roster: Roster | null };
      setRoster(data.roster);
      if (data.roster?.source_url) setUrl((u) => u || data.roster!.source_url);
    } catch {
      /* panel stays usable */
    }
  }, []);

  useEffect(() => {
    void loadCurrent();
  }, [loadCurrent]);

  async function fetchPreview() {
    setBusy(true);
    setPreview(null);
    try {
      const res = await fetch("/api/roster/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sheet_url: url.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `preview failed (${res.status})`);
      setPreview(data as Preview);
      setExcluded(new Set());
    } catch (e) {
      flash("err", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function renameTeam(ti: number, name: string) {
    setPreview((prev) => {
      if (!prev) return prev;
      const teams = prev.teams.slice();
      teams[ti] = { ...teams[ti]!, name };
      return { ...prev, teams };
    });
  }

  const toggleP = (k: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });

  async function commit() {
    if (!preview) return;
    const teams = preview.teams
      .map((t, ti) => ({
        name: t.name.trim(),
        players: t.players.filter((_, pi) => !excluded.has(`${ti}:${pi}`)).map((p) => ({ name: p.name, user_id: p.user_id })),
      }))
      .filter((t) => t.name && t.players.length > 0);
    setBusy(true);
    try {
      const res = await fetch("/api/roster", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_url: preview.source_url, sheet_name: preview.sheet_name, teams }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "commit failed");
      flash("ok", `Roster committed: ${fmtNum(data.teams)} teams, ${fmtNum(data.players)} players.`);
      setPreview(null);
      await loadCurrent();
    } catch (e) {
      flash("err", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function clearRoster() {
    if (!confirm("Clear the synced roster? The Teams grid will empty until you sync again.")) return;
    setBusy(true);
    await fetch("/api/roster", { method: "DELETE" });
    setBusy(false);
    setRoster(null);
    flash("ok", "Roster cleared.");
  }

  const totalPlayers = roster?.teams.reduce((n, t) => n + t.players.length, 0) ?? 0;

  return (
    <div className="rsync">
      <div className="export-label">Team roster (Google Sheet)</div>

      {roster ? (
        <p className="hint" style={{ marginTop: 0 }}>
          Synced <b>{fmtNum(roster.teams.length)}</b> teams · <b>{fmtNum(totalPlayers)}</b> players{" "}
          {fmtAgo(roster.synced_at)}
          {roster.source_url && (
            <>
              {" "}
              from{" "}
              <a href={roster.source_url} target="_blank" rel="noreferrer">
                mainsheet ↗
              </a>
            </>
          )}{" "}
          ·{" "}
          <button className="linkbtn" onClick={clearRoster} disabled={busy}>
            clear
          </button>
        </p>
      ) : (
        <p className="hint" style={{ marginTop: 0 }}>
          No roster synced. Paste the mainsheet URL (open the team-list tab first so the URL contains its gid).
        </p>
      )}

      <div className="row">
        <input
          className="input grow"
          placeholder="https://docs.google.com/spreadsheets/d/…#gid=…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
        />
        <button className="btn" onClick={fetchPreview} disabled={busy || !url.trim()}>
          {busy && !preview ? "Fetching…" : "Fetch preview"}
        </button>
      </div>

      {preview && (
        <div className="rs-preview">
          <p className="hint">
            Parsed tab <b>{preview.sheet_name}</b> — {fmtNum(preview.anchor_count)} profile links,{" "}
            {fmtNum(preview.teams.length)} teams. Rename teams or click players to exclude them, then commit.
          </p>
          {preview.warnings.map((w, i) => (
            <div className="toast err" key={i} style={{ marginBottom: 8 }}>
              {w}
            </div>
          ))}
          <div className="rs-teams">
            {preview.teams.map((t, ti) => (
              <div className="rs-team" key={ti}>
                <input className="input rs-name" value={t.name} onChange={(e) => renameTeam(ti, e.target.value)} />
                <div className="rs-players">
                  {t.players.map((p, pi) => {
                    const k = `${ti}:${pi}`;
                    const off = excluded.has(k);
                    return (
                      <button
                        key={k}
                        className={`player-chip rs-chip ${off ? "off" : ""}`}
                        onClick={() => toggleP(k)}
                        title={off ? "Excluded — click to include" : "Click to exclude"}
                      >
                        <span className="player-name">{p.name}</span>
                        {p.via === "name" && <span className="nbadge">n</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn" onClick={commit} disabled={busy}>
              Commit roster
            </button>
            <button className="btn ghost" onClick={() => setPreview(null)} disabled={busy}>
              Discard
            </button>
          </div>
        </div>
      )}

      {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
    </div>
  );
}
