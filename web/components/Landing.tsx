"use client";

import { useCallback, useEffect, useState } from "react";
import type { MeResponse, Status, TenantSummary } from "@/lib/types";
import { fmtAgo, fmtDur, fmtNum } from "@/lib/format";
import NavBar from "./NavBar";
import HealthPanel, { derivePill } from "./HealthPanel";
import { slugify } from "@/lib/slug";

const POLL_MS = 15000;

export default function Landing() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [tournaments, setTournaments] = useState<TenantSummary[] | null>(null);
  const [errored, setErrored] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const [loginError, setLoginError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const [m, s, t] = await Promise.all([
        fetch("/api/me", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
        fetch("/api/status", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
        fetch("/api/tournaments", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      ]);
      if (m) setMe(m as MeResponse);
      if (s) setStatus((s as { status: Status | null }).status);
      if (t) setTournaments((t as { tournaments: TenantSummary[] }).tournaments);
      setErrored(false);
    } catch {
      setErrored(true);
    }
  }, []);

  useEffect(() => {
    const err = new URLSearchParams(window.location.search).get("login_error");
    if (err) setLoginError(err);
    refetch();
    const p = setInterval(refetch, POLL_MS);
    const c = setInterval(() => setClock(Date.now()), 1000);
    return () => {
      clearInterval(p);
      clearInterval(c);
    };
  }, [refetch]);

  const pill = derivePill(status, errored, !!status);
  const targetDelay = status?.target_delay_seconds ?? 4 * 3600;
  const user = me?.user ?? null;
  const mine = new Set((me?.memberships ?? []).map((m) => m.slug));

  return (
    <main className="wrap">
      <NavBar me={me} />
      <div className="head">
        <div>
          <h1 className="title">
            MP <span className="accent">Pool</span> Scanner
          </h1>
          <div className="subtitle">
            Reads every osu! multiplayer lobby ~{fmtDur(targetDelay)} after it opens and logs the ones that play a tournament&apos;s pool ·
            one shared scanner, your own tournament · sign in with osu! to run one
          </div>
        </div>
        <span className="pill">
          <span className={`dot ${pill.dot}`} />
          {pill.label}
        </span>
      </div>

      {loginError && (
        <div className="toast err" style={{ marginBottom: 14 }}>
          {loginError === "cancelled"
            ? "osu! sign-in was cancelled."
            : loginError === "bad_state"
              ? "Sign-in expired or was tampered with — try again."
              : "Sign-in failed — try again, or tell the site owner if it keeps happening."}
        </div>
      )}

      {user ? <CreatePanel me={me!} onCreated={refetch} /> : <SignInPanel />}

      <section className="panel">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Tournaments</h2>
          <span className="hint mono">{tournaments ? `${fmtNum(tournaments.length)} total` : "…"}</span>
        </div>
        {tournaments && tournaments.length === 0 && <div className="empty">No tournaments yet. Sign in and create the first one.</div>}
        <div className="tlist">
          {(tournaments ?? []).map((t) => (
            <a className={`tcard ${mine.has(t.slug) ? "mine" : ""}`} href={`/t/${t.slug}`} key={t.slug}>
              <div className="tcard-top">
                <span className="tcard-name">{t.name}</span>
                <span className={`dot ${t.enabled ? "live" : "paused"}`} title={t.enabled ? "live matching on" : "live matching off"} />
              </div>
              <div className="tcard-meta mono">
                {fmtNum(t.pool_size)} maps · {fmtNum(t.hits)} lobbies · {t.owner_name ?? `user ${t.owner_id}`}
                {mine.has(t.slug) ? " · you're a member" : ""}
              </div>
              <div className="tcard-meta">updated {fmtAgo(t.updated_at)}</div>
            </a>
          ))}
        </div>
      </section>

      <HealthPanel status={status} clock={clock} errored={errored} />

      <div className="footer">
        One osu! API budget shared by every tournament: the sweep indexes every lobby once; tournaments backfill from that index, so
        adding tournaments costs nothing extra.
      </div>
    </main>
  );
}

function SignInPanel() {
  return (
    <div className="panel">
      <h2>Run your own tournament</h2>
      <p className="hint" style={{ margin: "0 0 12px" }}>
        Sign in with your osu! account (we only ask for <code>identify</code> — who you are, nothing else) to create a tournament, set its
        pool, invite staff, sync a mainsheet roster and backfill lobbies from the shared index.
      </p>
      <a className="btn btn-osu" href="/api/auth/login?next=%2F">
        Sign in with osu!
      </a>
    </div>
  );
}

function CreatePanel({ me, onCreated }: { me: MeResponse; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const suggested = slugify(name);
  const owned = me.memberships.filter((m) => m.role === "owner");

  async function create() {
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/tournaments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, slug: slug || suggested }),
    });
    const data = await res.json().catch(() => null);
    setBusy(false);
    if (res.ok) {
      window.location.href = `/t/${data.tournament.slug}`;
      onCreated();
    } else setErr(data?.error ?? `failed (${res.status})`);
  }

  return (
    <div className="panel">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Your tournaments</h2>
        <span className="hint mono">signed in as {me.user!.username}</span>
      </div>
      {me.memberships.length > 0 ? (
        <div className="row" style={{ flexWrap: "wrap", marginTop: 8 }}>
          {me.memberships.map((m) => (
            <a className="btn ghost" href={`/t/${m.slug}`} key={m.slug}>
              {m.name} <span className={`badge role ${m.role}`}>{m.role}</span>
            </a>
          ))}
        </div>
      ) : (
        <p className="hint" style={{ marginTop: 8 }}>
          You aren&apos;t a member of any tournament yet.
        </p>
      )}
      <hr className="hr" />
      <div className="export-label">New tournament</div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <input className="input" style={{ maxWidth: 260 }} placeholder="name (e.g. Catfe Clash 3)" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          className="input mono"
          style={{ maxWidth: 200 }}
          placeholder={suggested || "slug"}
          value={slug}
          onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
        />
        <button className="btn" disabled={busy || name.trim().length < 2} onClick={create}>
          Create
        </button>
      </div>
      <p className="hint" style={{ marginTop: 8 }}>
        The slug becomes the public URL <code>/t/{slug || suggested || "…"}</code>. You own it, can add staff by osu! id, and can delete it later
        {owned.length ? ` (you own ${owned.length}).` : "."}
      </p>
      {err && <div className="toast err">{err}</div>}
    </div>
  );
}
