"use client";

import { useCallback, useEffect, useState } from "react";
import type { OwnerStatusResponse } from "@/lib/types";
import { fmtAgo, fmtDur, fmtNum } from "@/lib/format";
import NavBar from "./NavBar";
import HealthPanel from "./HealthPanel";

const POLL_MS = 10000;
const RATE_S = 1.1; // worker default request interval, for ETAs

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

export default function OwnerPanel() {
  const [data, setData] = useState<OwnerStatusResponse | null>(null);
  const [denied, setDenied] = useState<"anon" | "forbidden" | null>(null);
  const [errored, setErrored] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [walkFrom, setWalkFrom] = useState("");
  const [adoptName, setAdoptName] = useState("Catfe Clash 3");
  const [adoptSlug, setAdoptSlug] = useState("catfe3");

  const flash = (kind: "ok" | "err", msg: string) => {
    setToast({ kind, msg });
    setTimeout(() => setToast(null), 5000);
  };

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/owner/status", { cache: "no-store" });
      if (res.status === 401) return setDenied("anon");
      if (res.status === 403) return setDenied("forbidden");
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as OwnerStatusResponse);
      setDenied(null);
      setErrored(false);
    } catch {
      setErrored(true);
    }
  }, []);

  useEffect(() => {
    refetch();
    const p = setInterval(refetch, POLL_MS);
    const c = setInterval(() => setClock(Date.now()), 1000);
    return () => {
      clearInterval(p);
      clearInterval(c);
    };
  }, [refetch]);

  if (denied) {
    return (
      <main className="wrap">
        <NavBar />
        <div className="panel">
          <h2>Owner panel</h2>
          <p className="hint">
            {denied === "anon" ? (
              <>
                <a href="/api/auth/login?next=%2Fowner">Sign in with osu!</a> as a site owner to use this page.
              </>
            ) : (
              <>This page is limited to the site owner (OWNER_OSU_IDS).</>
            )}
          </p>
        </div>
      </main>
    );
  }

  const status = data?.status ?? null;
  const cursor = status?.roll_cursor ?? 0;
  const from = Number(walkFrom.trim());
  const walkValid = Number.isInteger(from) && from > 0 && cursor > 0 && from <= cursor;
  const gap = walkValid ? cursor - from + 1 : 0;

  async function toggleGlobal() {
    if (!data) return;
    const next = !data.global.enabled;
    if (!next && !confirm("Pause the scanner site-wide? Every tournament stops receiving lobbies and the index stops growing until you resume.")) return;
    setBusy(true);
    const { ok, data: d } = await api("/api/owner/global", "POST", { enabled: next });
    setBusy(false);
    if (ok) refetch();
    else flash("err", d?.error ?? "failed");
  }
  async function startWalk(clearRequest?: string) {
    setBusy(true);
    const { ok, data: d } = await api("/api/owner/walk", "POST", { from_id: from, clear_request: clearRequest });
    setBusy(false);
    if (ok) {
      flash("ok", `Walk queued: ${fmtNum(d.gap)} match ids, #${d.walk.from_id} → #${d.walk.to_id}.`);
      setWalkFrom("");
      refetch();
    } else flash("err", d?.error ?? "walk failed");
  }
  async function cancelWalk(id: string) {
    setBusy(true);
    await api("/api/owner/walk", "DELETE", { id });
    setBusy(false);
    refetch();
  }
  async function clearRequest(slug: string) {
    await api("/api/owner/walk", "DELETE", { clear_request: slug });
    refetch();
  }
  async function adopt() {
    if (!confirm(`Adopt the legacy single-tenant data into "${adoptName}" (/t/${adoptSlug})? Copies pool, hits, tombstones and roster.`)) return;
    setBusy(true);
    const { ok, data: d } = await api("/api/owner/adopt", "POST", { slug: adoptSlug, name: adoptName });
    setBusy(false);
    if (ok) {
      flash("ok", `Adopted ${fmtNum(d.hits)} lobbies into /t/${d.tournament.slug}.`);
      refetch();
    } else flash("err", d?.error ?? "adopt failed");
  }

  return (
    <main className="wrap">
      <NavBar />
      <div className="head">
        <div>
          <h1 className="title">
            Owner <span className="accent">panel</span>
          </h1>
          <div className="subtitle">The only place that spends raw osu! API budget on purpose: walks, the global switch, and coverage requests.</div>
        </div>
      </div>

      <div className="panel">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Scanner switch</h2>
          <label className="toggle">
            <button className={`switch ${data?.global.enabled ? "on" : ""}`} disabled={busy || !data} onClick={toggleGlobal} aria-label="toggle scanner" />
            {data?.global.enabled ? "Running" : "Paused"}
          </label>
        </div>
        <p className="hint" style={{ margin: "8px 0 0" }}>
          Site-wide. When paused the worker makes no osu! requests at all — sweep, backfills and walks all wait. Tournament-level &quot;live
          matching&quot; toggles are separate and only affect what gets linked to that tournament.
        </p>
      </div>

      <HealthPanel status={status} clock={clock} errored={errored} />

      <div className="panel">
        <h2>API walk (raw rescan)</h2>
        <p className="hint" style={{ margin: "0 0 10px" }}>
          Re-reads every osu! match from a start id up to the sweep cursor (#{fmtNum(cursor)}) into the index — 1 request per match, shared
          with everyone. Use it to seed history before the index existed, or to fill a gap after downtime; tournaments then backfill from the
          index for free. Walks queue FIFO and run below the sweep in priority.
        </p>
        <div className="row">
          <input
            className="input"
            style={{ maxWidth: 200 }}
            inputMode="numeric"
            placeholder="start match ID"
            value={walkFrom}
            onChange={(e) => setWalkFrom(e.target.value.replace(/[^0-9]/g, ""))}
          />
          <button className="btn blue" disabled={busy || !walkValid} onClick={() => startWalk()}>
            Queue walk
          </button>
          {walkValid && (
            <span className="hint">
              ≈ {fmtNum(gap)} matches · est. {fmtDur(gap * RATE_S)} – {fmtDur(gap * RATE_S * 3)} depending on sweep load
            </span>
          )}
        </div>
        {walkFrom && !walkValid && (
          <p className="hint" style={{ marginTop: 8, color: "var(--amber)" }}>
            {cursor <= 0 ? "The sweep has no position yet." : `ID must be between 1 and the sweep cursor (#${fmtNum(cursor)}).`}
          </p>
        )}

        {(data?.walk || (data?.walk_queue.length ?? 0) > 0) && (
          <div style={{ marginTop: 12 }}>
            {data?.walk && (
              <div className="walk-row">
                <span className={`badge ${data.walk.status === "running" ? "auto" : "open"}`}>{data.walk.status}</span>
                <span className="mono">
                  #{fmtNum(data.walk.from_id)} → #{fmtNum(data.walk.to_id)}
                </span>
                <span className="hint">
                  processed {fmtNum(data.walk.processed)}
                  {data.walk.status === "running" ? ` · ~${fmtNum(Math.max(0, data.walk.to_id - data.walk.cursor))} ids left` : ""} · requested{" "}
                  {fmtAgo(data.walk.requested_at)}
                </span>
                {data.walk.status === "running" && (
                  <button className="linkbtn" disabled={busy} onClick={() => cancelWalk(data.walk!.id)}>
                    cancel
                  </button>
                )}
              </div>
            )}
            {data?.walk_queue.map((w, i) => (
              <div className="walk-row" key={w.id}>
                <span className="badge open">queued #{i + 1}</span>
                <span className="mono">
                  #{fmtNum(w.from_id)} → #{fmtNum(w.to_id)}
                </span>
                <span className="hint">≈ {fmtNum(w.to_id - w.from_id + 1)} matches · requested {fmtAgo(w.requested_at)}</span>
                <button className="linkbtn" disabled={busy} onClick={() => cancelWalk(w.id)}>
                  remove
                </button>
              </div>
            ))}
          </div>
        )}

        {status && (
          <>
            <div className="export-label" style={{ marginTop: 14 }}>
              Index coverage (match-id ranges the index is backed by)
            </div>
            <div className="hint mono">
              {status.index.coverage.length === 0
                ? "nothing indexed yet"
                : status.index.coverage.map((r) => `#${fmtNum(r.from)}–#${fmtNum(r.to)}`).join("  ·  ")}
              {status.index.oldest_day ? ` · days ${status.index.oldest_day} → ${status.index.newest_day} (${status.index.days})` : ""}
            </div>
          </>
        )}
      </div>

      <div className="panel">
        <h2>Coverage requests</h2>
        <p className="hint" style={{ margin: "0 0 10px" }}>
          Backfills that asked for days the index doesn&apos;t have. Queue a walk that reaches back far enough (find a match id from that
          date on osu!), then the tournament re-runs its backfill.
        </p>
        {data && data.coverage_requests.length === 0 && <div className="hint">none</div>}
        {data?.coverage_requests.map((r) => (
          <div className="walk-row" key={r.slug}>
            <a href={`/t/${r.slug}`}>/t/{r.slug}</a>
            <span className="mono">
              {r.from_day} → {r.to_day}
            </span>
            <span className="hint">
              {r.uncovered_days.length} uncovered day{r.uncovered_days.length === 1 ? "" : "s"} ({r.uncovered_days.slice(0, 4).join(", ")}
              {r.uncovered_days.length > 4 ? "…" : ""}) · {fmtAgo(r.at)}
            </span>
            <button className="linkbtn" onClick={() => clearRequest(r.slug)}>
              dismiss
            </button>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Tournaments</h2>
          <span className="hint mono">{data ? `${fmtNum(data.tenants.length)} total` : "…"}</span>
        </div>
        <div className="ttable">
          {data?.tenants.map((t) => (
            <div className="ttable-row" key={t.slug}>
              <a href={`/t/${t.slug}`}>{t.name}</a>
              <span className="mono hint">/t/{t.slug}</span>
              <span className="hint">{t.owner_name ?? `user ${t.owner_id}`}</span>
              <span className="mono hint">
                {fmtNum(t.pool_size)} maps · {fmtNum(t.hits)} lobbies
              </span>
              <span className={`dot ${t.enabled ? "live" : "paused"}`} title={t.enabled ? "live matching on" : "off"} />
            </div>
          ))}
        </div>
      </div>

      {data?.legacy.present && (
        <div className="panel">
          <h2>Legacy data</h2>
          {data.legacy.adopted_into ? (
            <p className="hint" style={{ margin: 0 }}>
              The pre-multi-tenant pool, lobbies, tombstones and roster were adopted into{" "}
              <a href={`/t/${data.legacy.adopted_into}`}>/t/{data.legacy.adopted_into}</a>.
            </p>
          ) : (
            <>
              <p className="hint" style={{ margin: "0 0 10px" }}>
                This Redis still has the single-tenant keys (<code>mpf:config</code>, <code>mpf:hits</code>, <code>mpf:roster</code>). Fold them
                into a tournament so nothing is lost — copies only, safe to run once.
              </p>
              <div className="row" style={{ flexWrap: "wrap" }}>
                <input className="input" style={{ maxWidth: 240 }} value={adoptName} onChange={(e) => setAdoptName(e.target.value)} placeholder="name" />
                <input
                  className="input mono"
                  style={{ maxWidth: 160 }}
                  value={adoptSlug}
                  onChange={(e) => setAdoptSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                  placeholder="slug"
                />
                <button className="btn" disabled={busy || !adoptName.trim() || !adoptSlug} onClick={adopt}>
                  Adopt into tournament
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
    </main>
  );
}
