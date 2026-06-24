"use client";

import { useEffect, useRef, useState } from "react";
import type { AppConfig, Status } from "@/lib/types";
import { MAX_POOL } from "@/lib/types";
import { fmtDur, fmtNum } from "@/lib/format";

type Toast = { kind: "ok" | "err"; msg: string } | null;

async function api(path: string, method: string, body?: unknown): Promise<{ ok: boolean; data: any }> {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  return { ok: res.ok, data };
}

const RATE_S = 1.1; // assumed osu! request interval for ETA (worker default)

export default function ControlPanel({
  authed,
  config,
  status,
  onChanged,
}: {
  authed: boolean;
  config: AppConfig;
  status: Status | null;
  onChanged: () => void;
}) {
  const [pw, setPw] = useState("");
  const [pool, setPool] = useState<string[]>(() => padPool(config.target_beatmap_ids));
  const [dirty, setDirty] = useState(false);
  const [rescanFrom, setRescanFrom] = useState("");
  const [toast, setToast] = useState<Toast>(null);
  const [busy, setBusy] = useState(false);
  const lastSync = useRef(config.updated_at);

  // Sync editor from server config when it changes externally and we're clean.
  useEffect(() => {
    if (config.updated_at !== lastSync.current && !dirty) {
      setPool(padPool(config.target_beatmap_ids));
      lastSync.current = config.updated_at;
    }
  }, [config.updated_at, config.target_beatmap_ids, dirty]);

  function flash(kind: "ok" | "err", msg: string) {
    setToast({ kind, msg });
    setTimeout(() => setToast(null), 3500);
  }

  async function unlock() {
    setBusy(true);
    const { ok, data } = await api("/api/login", "POST", { password: pw });
    setBusy(false);
    if (ok) {
      setPw("");
      onChanged();
    } else flash("err", data?.error ?? "login failed");
  }

  async function savePool() {
    setBusy(true);
    const ids = pool.map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    const { ok, data } = await api("/api/config", "POST", { target_beatmap_ids: ids });
    setBusy(false);
    if (ok) {
      setDirty(false);
      lastSync.current = data.config.updated_at;
      flash("ok", `Saved ${data.config.target_beatmap_ids.length} beatmap${data.config.target_beatmap_ids.length === 1 ? "" : "s"}.`);
      onChanged();
    } else flash("err", data?.error ?? "save failed");
  }

  async function toggleEnabled() {
    setBusy(true);
    const { ok, data } = await api("/api/config", "POST", { enabled: !config.enabled });
    setBusy(false);
    if (ok) onChanged();
    else flash("err", data?.error ?? "toggle failed");
  }

  async function startRescan() {
    const fromId = Number(rescanFrom.trim());
    setBusy(true);
    const { ok, data } = await api("/api/rescan", "POST", { from_id: fromId });
    setBusy(false);
    if (ok) {
      flash("ok", `Rescan queued: ${fmtNum(data.gap)} matches from #${data.from_id} → #${data.to_id}.`);
      onChanged();
    } else flash("err", data?.error ?? "rescan failed");
  }

  async function cancelRescan() {
    setBusy(true);
    await api("/api/rescan", "DELETE");
    setBusy(false);
    onChanged();
  }

  async function clearResults() {
    if (!confirm("Clear all logged hits? This cannot be undone.")) return;
    setBusy(true);
    await api("/api/clear", "POST");
    setBusy(false);
    flash("ok", "Results cleared.");
    onChanged();
  }

  async function logout() {
    await api("/api/logout", "POST");
    onChanged();
  }

  if (!authed) {
    return (
      <div className="panel">
        <h2>Editing — locked</h2>
        <div className="lock-row">
          <input
            className="input"
            style={{ maxWidth: 220 }}
            type="password"
            placeholder="app password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && unlock()}
          />
          <button className="btn" disabled={busy || !pw} onClick={unlock}>
            Unlock
          </button>
        </div>
        <p className="hint" style={{ marginTop: 10 }}>
          Results and scanner health below are public. The password unlocks the pool editor, the start/stop toggle, and
          rescans — anything that changes what the scanner does or uses API quota.
        </p>
        {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
      </div>
    );
  }

  const filled = pool.filter((s) => s.trim() !== "").length;
  const fromId = Number(rescanFrom.trim());
  const wm = status?.live_watermark ?? 0;
  const rescanValid = Number.isInteger(fromId) && fromId > 0 && wm > 0 && fromId <= wm;
  const gap = rescanValid ? wm - fromId + 1 : 0;
  const rescanActive = status?.rescan.active ?? false;

  return (
    <div className="panel">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Beatmap pool — {filled} / {MAX_POOL}</h2>
        <button className="btn ghost" onClick={logout} style={{ padding: "4px 10px", fontSize: 12 }}>
          Lock
        </button>
      </div>

      <p className="hint" style={{ margin: "10px 0 12px" }}>
        Enter <strong>beatmap (difficulty) IDs</strong>, not beatmapset IDs. In <code>/beatmapsets/1234#osu/5678</code> the
        number you want is <code>5678</code> (same as <code>/b/5678</code>). Every lobby is checked against all of these.
      </p>

      <div className="pool-grid">
        {pool.map((val, i) => (
          <div className="pool-cell" key={i}>
            <span className="idx">{i + 1}</span>
            <input
              className="input"
              inputMode="numeric"
              placeholder="—"
              value={val}
              onChange={(e) => {
                const next = [...pool];
                next[i] = e.target.value.replace(/[^0-9]/g, "");
                setPool(next);
                setDirty(true);
              }}
            />
          </div>
        ))}
      </div>

      <div className="row between" style={{ marginTop: 14 }}>
        <label className="toggle">
          <button
            className={`switch ${config.enabled ? "on" : ""}`}
            disabled={busy}
            onClick={toggleEnabled}
            aria-label="toggle scanner"
          />
          {config.enabled ? "Scanner running" : "Scanner stopped"}
        </label>
        <button className="btn" disabled={busy} onClick={savePool}>
          {dirty ? "Save pool •" : "Save pool"}
        </button>
      </div>

      <hr className="hr" />

      <h2>Rescan from a match ID</h2>
      <p className="hint" style={{ margin: "0 0 10px" }}>
        Retro-applies the <em>current</em> pool to past lobbies, from this match ID up to the live position — runs
        alongside live scanning. Use a hit&apos;s <code>#id</code> (copy button on any result) as the start point.
      </p>
      <div className="row">
        <input
          className="input"
          style={{ maxWidth: 200 }}
          inputMode="numeric"
          placeholder="start match ID"
          value={rescanFrom}
          onChange={(e) => setRescanFrom(e.target.value.replace(/[^0-9]/g, ""))}
          disabled={rescanActive}
        />
        {!rescanActive ? (
          <button className="btn blue" disabled={busy || !rescanValid} onClick={startRescan}>
            Start rescan
          </button>
        ) : (
          <button className="btn danger" disabled={busy} onClick={cancelRescan}>
            Cancel rescan
          </button>
        )}
      </div>

      {rescanFrom && !rescanValid && !rescanActive && (
        <p className="hint" style={{ marginTop: 8, color: "var(--amber)" }}>
          {wm <= 0 ? "Live scanner has no position yet." : `ID must be between 1 and the live position (#${fmtNum(wm)}).`}
        </p>
      )}
      {rescanValid && !rescanActive && (
        <p className="hint" style={{ marginTop: 8 }}>
          ≈ {fmtNum(gap)} matches · est. {fmtDur(gap * RATE_S)} – {fmtDur(gap * RATE_S * 2)} (shared with live scanning)
        </p>
      )}
      {rescanActive && status && (
        <p className="hint" style={{ marginTop: 8, color: "var(--blue)" }}>
          Running #{fmtNum(status.rescan.from_id)} → #{fmtNum(status.rescan.to_id)} · processed{" "}
          {fmtNum(status.rescan.processed)} · ~{fmtNum(status.rescan.remaining)} match IDs left
        </p>
      )}

      <hr className="hr" />
      <div className="row">
        <button className="btn danger" disabled={busy} onClick={clearResults}>
          Clear results
        </button>
      </div>

      {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
    </div>
  );
}

function padPool(ids: number[]): string[] {
  const arr = ids.slice(0, MAX_POOL).map((n) => String(n));
  while (arr.length < MAX_POOL) arr.push("");
  return arr;
}
