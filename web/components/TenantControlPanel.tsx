"use client";

import { useEffect, useRef, useState } from "react";
import type { BackfillState, Status, Tenant, TenantAccess, TenantRole } from "@/lib/types";
import { MAX_POOL } from "@/lib/types";
import { fmtAgo, fmtNum } from "@/lib/format";
import RosterSync from "./RosterSync";

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

const today = () => new Date().toISOString().slice(0, 10);

export default function TenantControlPanel({
  tenant,
  access,
  status,
  backfill,
  backfillPosition,
  onChanged,
}: {
  tenant: Tenant;
  access: TenantAccess;
  status: Status | null;
  backfill: BackfillState | null;
  backfillPosition: number | null;
  onChanged: () => void;
}) {
  const base = `/api/t/${tenant.slug}`;
  const [pool, setPool] = useState<string[]>(() => padPool(tenant.pool));
  const [dirty, setDirty] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [busy, setBusy] = useState(false);
  const lastSync = useRef(tenant.updated_at);

  // Sync editor from server config when it changes externally and we're clean.
  useEffect(() => {
    if (tenant.updated_at !== lastSync.current && !dirty) {
      setPool(padPool(tenant.pool));
      lastSync.current = tenant.updated_at;
    }
  }, [tenant.updated_at, tenant.pool, dirty]);

  function flash(kind: "ok" | "err", msg: string) {
    setToast({ kind, msg });
    setTimeout(() => setToast(null), 4000);
  }

  async function savePool() {
    setBusy(true);
    const ids = pool.map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    const { ok, data } = await api(`${base}/config`, "POST", { pool: ids });
    setBusy(false);
    if (ok) {
      setDirty(false);
      lastSync.current = data.tenant.updated_at;
      flash("ok", `Saved ${data.tenant.pool.length} beatmap${data.tenant.pool.length === 1 ? "" : "s"}. Run a backfill to pick up lobbies already played.`);
      onChanged();
    } else flash("err", data?.error ?? "save failed");
  }

  async function toggleEnabled() {
    setBusy(true);
    const { ok, data } = await api(`${base}/config`, "POST", { enabled: !tenant.enabled });
    setBusy(false);
    if (ok) onChanged();
    else flash("err", data?.error ?? "toggle failed");
  }

  async function clearResults() {
    if (!confirm("Clear this tournament's logged lobbies? (Removed lobbies stay tombstoned; the shared index is untouched.)")) return;
    setBusy(true);
    await api(`${base}/hits`, "POST", { action: "clear" });
    setBusy(false);
    flash("ok", "Results cleared.");
    onChanged();
  }

  const filled = pool.filter((s) => s.trim() !== "").length;

  return (
    <div className="panel">
      <div className="row between">
        <h2 style={{ margin: 0 }}>
          Beatmap pool — {filled} / {MAX_POOL}
        </h2>
        <span className="hint mono">
          you are {access.is_site_owner ? "site owner" : access.role ?? "—"}
        </span>
      </div>

      <p className="hint" style={{ margin: "10px 0 12px" }}>
        Enter <strong>beatmap (difficulty) IDs</strong>, not beatmapset IDs. In <code>/beatmapsets/1234#osu/5678</code> the number you
        want is <code>5678</code> (same as <code>/b/5678</code>). Every lobby the scanner reads is checked against these.
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
          <button className={`switch ${tenant.enabled ? "on" : ""}`} disabled={busy} onClick={toggleEnabled} aria-label="toggle live matching" />
          {tenant.enabled ? "Live matching on" : "Live matching off"}
        </label>
        <button className="btn" disabled={busy} onClick={savePool}>
          {dirty ? "Save pool •" : "Save pool"}
        </button>
      </div>
      <p className="hint" style={{ marginTop: 6 }}>
        Live matching adds new lobbies as the shared sweep reads them (~4h after they open). Turning it off doesn&apos;t stop the sweep or
        the index — it just stops adding to <em>this</em> tournament.
      </p>

      <hr className="hr" />
      <BackfillPanel tenant={tenant} status={status} backfill={backfill} position={backfillPosition} onChanged={onChanged} flash={flash} />

      <hr className="hr" />
      <RosterSync slug={tenant.slug} />

      <hr className="hr" />
      <div className="export-block">
        <div className="export-label">Export tournament data</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <a className="btn ghost" href={`${base}/export?format=lobbies`} download>
            Lobbies + maps (CSV)
          </a>
          <a className="btn ghost" href={`${base}/export?format=players`} download>
            Players + maps (CSV)
          </a>
          <a className="btn ghost" href={`${base}/export?format=json`} download>
            Everything (JSON)
          </a>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          All of this tournament&apos;s lobbies (removed ones excluded), with games filtered to its current pool.
        </p>
      </div>

      {access.can_manage && (
        <>
          <hr className="hr" />
          <MembersPanel base={base} tenant={tenant} flash={flash} />
          <hr className="hr" />
          <DangerZone base={base} tenant={tenant} busy={busy} onClear={clearResults} flash={flash} onChanged={onChanged} />
        </>
      )}
      {!access.can_manage && (
        <>
          <hr className="hr" />
          <div className="row">
            <button className="btn danger" disabled={busy} onClick={clearResults}>
              Clear results
            </button>
          </div>
        </>
      )}

      {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
    </div>
  );
}

// ---- backfill (index-based; the tenant-facing replacement for "rescan") ----

function BackfillPanel({
  tenant,
  status,
  backfill,
  position,
  onChanged,
  flash,
}: {
  tenant: Tenant;
  status: Status | null;
  backfill: BackfillState | null;
  position: number | null;
  onChanged: () => void;
  flash: (k: "ok" | "err", m: string) => void;
}) {
  const base = `/api/t/${tenant.slug}`;
  const [from, setFrom] = useState(tenant.start_day);
  const [to, setTo] = useState(today());
  const [busy, setBusy] = useState(false);
  const active = !!backfill && (backfill.status === "queued" || backfill.status === "scanning" || backfill.status === "fetching");
  const oldest = status?.index.oldest_day ?? null;
  const beforeHistory = oldest !== null && from < oldest;

  async function start() {
    setBusy(true);
    const { ok, data } = await api(`${base}/backfill`, "POST", { from_day: from, to_day: to });
    setBusy(false);
    if (ok) {
      flash("ok", data.position > 1 ? `Backfill queued (position ${data.position}).` : "Backfill queued — the worker will pick it up in a few seconds.");
      onChanged();
    } else flash("err", data?.error ?? "backfill failed");
  }
  async function cancel() {
    setBusy(true);
    await api(`${base}/backfill`, "DELETE");
    setBusy(false);
    onChanged();
  }
  async function saveStartDay() {
    const { ok, data } = await api(`${base}/config`, "POST", { start_day: from });
    if (ok) flash("ok", `Default backfill start saved (${from}).`);
    else flash("err", data?.error ?? "save failed");
    onChanged();
  }

  return (
    <div>
      <h2>Backfill from the shared index</h2>
      <p className="hint" style={{ margin: "0 0 10px" }}>
        The scanner keeps an index of every lobby it has read (maps played per lobby, {status ? `${status.index.retention_days} days` : "rolling"} of history
        {oldest ? `, currently back to ${oldest}` : ""}). A backfill scans that index for your pool over a date range, links lobbies that are already
        stored, and reads only the ones nobody has stored yet — a few hundred requests at most, not a re-crawl of osu!.
      </p>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <label className="hint">
          from{" "}
          <input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} disabled={active} style={{ width: 160 }} />
        </label>
        <label className="hint">
          to{" "}
          <input className="input" type="date" value={to} min={from} max={today()} onChange={(e) => setTo(e.target.value)} disabled={active} style={{ width: 160 }} />
        </label>
        {!active ? (
          <button className="btn blue" disabled={busy || !from || !to || from > to} onClick={start}>
            Start backfill
          </button>
        ) : (
          <button className="btn danger" disabled={busy} onClick={cancel}>
            Cancel backfill
          </button>
        )}
        {from !== tenant.start_day && !active && (
          <button className="btn ghost" onClick={saveStartDay} title="Remember this as the tournament's default start date">
            Save as default start
          </button>
        )}
      </div>
      {beforeHistory && !active && (
        <p className="hint" style={{ marginTop: 8, color: "var(--amber)" }}>
          The index only goes back to {oldest}; days before that are reported as uncovered and flagged to the site owner, who can walk them in.
        </p>
      )}
      {backfill && <BackfillStatus b={backfill} position={position} />}
    </div>
  );
}

function BackfillStatus({ b, position }: { b: BackfillState; position: number | null }) {
  const cls = b.status === "error" ? "err" : b.status === "done" ? "ok" : "";
  let line: string;
  switch (b.status) {
    case "queued":
      line = `Queued${position ? ` (position ${position})` : ""} — ${b.from_day} → ${b.to_day}, requested ${fmtAgo(b.requested_at)}.`;
      break;
    case "scanning":
      line = `Scanning the index for ${b.from_day} → ${b.to_day}…`;
      break;
    case "fetching":
      line = `Fetching ${fmtNum(b.fetched)} / ${fmtNum(b.to_fetch)} lobbies · ${fmtNum(b.linked)} linked from the store · ${fmtNum(b.candidates)} candidates.`;
      break;
    case "done":
      line = `Done ${fmtAgo(b.finished_at)}: ${fmtNum(b.candidates)} candidates → ${fmtNum(b.linked)} linked, ${fmtNum(b.fetched)} fetched${
        b.tombstoned ? `, ${fmtNum(b.tombstoned)} skipped (removed)` : ""
      }.`;
      break;
    case "cancelled":
      line = `Cancelled ${fmtAgo(b.finished_at)} after ${fmtNum(b.fetched)} of ${fmtNum(b.to_fetch)} fetches.`;
      break;
    default:
      line = `Failed: ${b.error ?? "unknown error"}`;
  }
  return (
    <div className={`toast ${cls}`} style={{ marginTop: 10 }}>
      {line}
      {b.uncovered_days.length > 0 && (
        <div className="hint" style={{ marginTop: 4 }}>
          {b.uncovered_days.length} day{b.uncovered_days.length === 1 ? "" : "s"} not in the index ({b.uncovered_days.slice(0, 5).join(", ")}
          {b.uncovered_days.length > 5 ? "…" : ""}) — flagged to the site owner.
        </div>
      )}
    </div>
  );
}

// ---- members ----

interface Member {
  osu_id: number;
  role: TenantRole;
  username: string | null;
  avatar_url: string | null;
}

function MembersPanel({ base, tenant, flash }: { base: string; tenant: Tenant; flash: (k: "ok" | "err", m: string) => void }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [input, setInput] = useState("");
  const [role, setRole] = useState<TenantRole>("staff");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`${base}/members`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && d && setMembers(d.members as Member[]))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [base]);

  async function add() {
    setBusy(true);
    const { ok, data } = await api(`${base}/members`, "POST", { osu_id: input.trim(), role });
    setBusy(false);
    if (ok) {
      setMembers(data.members);
      setInput("");
      flash("ok", "Member added. Their name shows once they sign in.");
    } else flash("err", data?.error ?? "add failed");
  }
  async function remove(id: number) {
    setBusy(true);
    const { ok, data } = await api(`${base}/members`, "DELETE", { osu_id: id });
    setBusy(false);
    if (ok) setMembers(data.members);
    else flash("err", data?.error ?? "remove failed");
  }

  return (
    <div>
      <div className="export-label">Members</div>
      <p className="hint" style={{ marginTop: 0 }}>
        Staff can edit the pool, run backfills, sync rosters and remove lobbies. Owners can also manage members, rename and delete the
        tournament. Add people by osu! user id or profile URL — they sign in with osu! to use it.
      </p>
      <div className="members">
        {(members ?? []).map((m) => (
          <span className="member-chip" key={m.osu_id}>
            {m.avatar_url ? <img className="avatar sm" src={m.avatar_url} alt="" /> : null}
            <a href={`https://osu.ppy.sh/users/${m.osu_id}`} target="_blank" rel="noreferrer">
              {m.username ?? `user ${m.osu_id}`}
            </a>
            <span className={`badge role ${m.role}`}>{m.role}</span>
            {m.osu_id !== tenant.owner_id && (
              <button className="linkbtn" disabled={busy} onClick={() => remove(m.osu_id)} title="Remove member">
                ×
              </button>
            )}
          </span>
        ))}
        {members && members.length === 0 && <span className="hint">no members yet</span>}
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <input
          className="input"
          style={{ maxWidth: 320 }}
          placeholder="osu! user id or https://osu.ppy.sh/users/…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && input.trim() && add()}
        />
        <select className="input" style={{ maxWidth: 120 }} value={role} onChange={(e) => setRole(e.target.value as TenantRole)}>
          <option value="staff">staff</option>
          <option value="owner">owner</option>
        </select>
        <button className="btn" disabled={busy || !input.trim()} onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}

// ---- rename / delete ----

function DangerZone({
  base,
  tenant,
  busy,
  onClear,
  flash,
  onChanged,
}: {
  base: string;
  tenant: Tenant;
  busy: boolean;
  onClear: () => void;
  flash: (k: "ok" | "err", m: string) => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState(tenant.name);
  const [working, setWorking] = useState(false);

  async function rename() {
    setWorking(true);
    const { ok, data } = await api(`${base}/config`, "POST", { name });
    setWorking(false);
    if (ok) {
      flash("ok", "Renamed.");
      onChanged();
    } else flash("err", data?.error ?? "rename failed");
  }
  async function del() {
    if (!confirm(`Delete "${tenant.name}"? Its pool, roster, members and lobby list go away (the shared index is untouched).`)) return;
    if (prompt(`Type the slug to confirm: ${tenant.slug}`) !== tenant.slug) return;
    setWorking(true);
    const { ok, data } = await api(base, "DELETE");
    setWorking(false);
    if (ok) window.location.href = "/";
    else flash("err", data?.error ?? "delete failed");
  }

  return (
    <div>
      <div className="export-label">Tournament settings</div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <input className="input" style={{ maxWidth: 320 }} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn ghost" disabled={working || name.trim().length < 2 || name.trim() === tenant.name} onClick={rename}>
          Rename
        </button>
        <span className="hint mono">/t/{tenant.slug}</span>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn danger" disabled={busy || working} onClick={onClear}>
          Clear results
        </button>
        <button className="btn danger" disabled={busy || working} onClick={del}>
          Delete tournament
        </button>
      </div>
    </div>
  );
}

function padPool(ids: number[]): string[] {
  const arr = ids.slice(0, MAX_POOL).map((n) => String(n));
  while (arr.length < MAX_POOL) arr.push("");
  return arr;
}
