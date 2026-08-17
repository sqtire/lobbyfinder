"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TenantDataResponse } from "@/lib/types";
import { fmtDur, fmtNum } from "@/lib/format";
import NavBar from "./NavBar";
import HealthPanel, { derivePill } from "./HealthPanel";
import TenantControlPanel from "./TenantControlPanel";
import ResultsList from "./ResultsList";
import CompactList from "./CompactList";
import TeamsGrid from "./TeamsGrid";
import StatsPanel from "./StatsPanel";

const POLL_MS = 10000;

export default function TournamentDashboard({ slug }: { slug: string }) {
  const [data, setData] = useState<TenantDataResponse | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [errored, setErrored] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const [view, setView] = useState<"log" | "compact" | "teams" | "stats">("compact");
  const [viewer, setViewer] = useState(false); // members can browse the page exactly as a visitor sees it
  const [mounted, setMounted] = useState(false);
  const inFlight = useRef(false);
  const viewerKey = `lf:viewer:${slug}`;

  useEffect(() => {
    try {
      setViewer(window.localStorage.getItem(viewerKey) === "1");
    } catch {
      /* storage unavailable */
    }
    setMounted(true);
  }, [viewerKey]);

  function toggleViewer() {
    setViewer((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(viewerKey, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  const refetch = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch(`/api/t/${slug}/data`, { cache: "no-store" });
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as TenantDataResponse);
      setErrored(false);
    } catch {
      setErrored(true);
    } finally {
      inFlight.current = false;
    }
  }, [slug]);

  useEffect(() => {
    refetch();
    const p = setInterval(refetch, POLL_MS);
    const c = setInterval(() => setClock(Date.now()), 1000);
    return () => {
      clearInterval(p);
      clearInterval(c);
    };
  }, [refetch]);

  if (notFound) {
    return (
      <main className="wrap">
        <NavBar />
        <div className="empty">
          No tournament at <code>/t/{slug}</code>. <a href="/">Back to the list</a>.
        </div>
      </main>
    );
  }

  const status = data?.status ?? null;
  const tenant = data?.tenant ?? null;
  const access = data?.access ?? null;
  const isMember = access?.can_edit ?? false;
  const canEdit = isMember && !viewer; // what the page renders as editable right now
  const pill = derivePill(status, errored, !!data);
  const targetDelay = status?.target_delay_seconds ?? 4 * 3600;

  return (
    <main className="wrap">
      <NavBar />
      <div className="head">
        <div>
          <h1 className="title">
            {tenant?.name ?? "…"} <span className="hint mono" style={{ fontWeight: 400 }}>/t/{slug}</span>
          </h1>
          <div className="subtitle">
            {tenant
              ? `${fmtNum(tenant.pool.length)} pool maps · ${fmtNum(data?.hits_total ?? 0)} lobbies logged · live matching ${
                  tenant.enabled ? "on" : "off"
                } · lobbies appear ~${fmtDur(targetDelay)} after they open`
              : "loading…"}
          </div>
        </div>
        <div className="row" style={{ alignItems: "center", gap: 10 }}>
          {isMember && mounted && (
            <button className="btn ghost" style={{ padding: "4px 10px", fontSize: 12 }} onClick={toggleViewer}>
              {viewer ? "Show controls" : "View as visitor"}
            </button>
          )}
          <span className="pill">
            <span className={`dot ${pill.dot}`} />
            {pill.label}
          </span>
        </div>
      </div>

      <HealthPanel status={status} clock={clock} errored={errored} compact />

      {tenant && access && mounted && canEdit && (
        <TenantControlPanel
          tenant={tenant}
          access={access}
          status={status}
          backfill={data?.backfill ?? null}
          backfillPosition={data?.backfill_position ?? null}
          onChanged={refetch}
        />
      )}
      {tenant && access && !isMember && (
        <div className="panel">
          <h2>Editing — members only</h2>
          <p className="hint" style={{ margin: 0 }}>
            Results below are public. Editing the pool, running backfills, syncing rosters and removing lobbies is limited to this
            tournament&apos;s members.{" "}
            {access.user ? (
              <>You&apos;re signed in as {access.user.username} but not a member — ask the tournament owner to add your osu! id.</>
            ) : (
              <a href={`/api/auth/login?next=${encodeURIComponent(`/t/${slug}`)}`}>Sign in with osu!</a>
            )}
          </p>
        </div>
      )}

      <section className="panel">
        <div className="results-head">
          <div className="tabs">
            <button className={`tab ${view === "compact" ? "active" : ""}`} onClick={() => setView("compact")}>
              Lobbies
            </button>
            <button className={`tab ${view === "log" ? "active" : ""}`} onClick={() => setView("log")}>
              Log
            </button>
            <button className={`tab ${view === "teams" ? "active" : ""}`} onClick={() => setView("teams")}>
              Teams
            </button>
            <button className={`tab ${view === "stats" ? "active" : ""}`} onClick={() => setView("stats")}>
              Stats
            </button>
          </div>
          {view !== "teams" && view !== "stats" && (
            <span className="hint mono">
              {fmtNum(data?.hits_total ?? data?.hits.length ?? 0)} lobbies
              {data && data.hits.length >= 200 ? " · showing newest 200" : ""}
            </span>
          )}
          {view === "teams" && canEdit && (
            <a className="btn ghost" style={{ padding: "4px 10px", fontSize: 12 }} href={`/api/t/${slug}/export?format=grid`} download>
              Export grid (.csv)
            </a>
          )}
        </div>
        {view === "compact" ? (
          <CompactList hits={data?.hits ?? []} authed={canEdit} hiddenCount={data?.hidden_count ?? 0} onChanged={refetch} apiBase={`/api/t/${slug}`} />
        ) : view === "teams" ? (
          <TeamsGrid slug={slug} />
        ) : view === "stats" ? (
          tenant ? <StatsPanel slug={slug} canEdit={canEdit} savedSettings={tenant.stats} /> : <div className="empty">Loading…</div>
        ) : (
          <ResultsList hits={data?.hits ?? []} />
        )}
      </section>

      <div className="footer">
        Uses beatmap (difficulty) IDs · results trail real time by ~{fmtDur(targetDelay)} by design · data updates every {POLL_MS / 1000}s
      </div>
    </main>
  );
}
