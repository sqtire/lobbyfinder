"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MeResponse } from "@/lib/types";
import type {
  JobSummary,
  LeaderboardEntry,
  MapStatRow,
  MatchGame,
  MatchResult,
  PlacementRow,
  PlacementsJob,
  PlacementsResult,
  PlacementsSettings,
  PlayerRef,
  PreviewResponse,
  RoomKind,
} from "@/lib/placements/types";
import { DEFAULT_PLACEMENTS_SETTINGS } from "@/lib/placements/types";
import { fmtAgo, fmtDateTime, fmtNum } from "@/lib/format";
import NavBar from "./NavBar";

const INPUTS_KEY = "lf:placements:inputs";
const POLL_MS = 2000;

type View = "placements" | "performance" | "mappool" | "leaderboards" | "grid" | "matches" | "games" | "notes";

/** What the panel persists between visits (settings + the excluded-ids text as typed). */
interface Inputs extends Omit<PlacementsSettings, "excluded_items"> {
  excluded_text: string;
  /** Where the schedule comes from: the sheet link, or an uploaded .xlsx (schedule_rows). */
  source: "link" | "upload";
}

const DEFAULT_INPUTS: Inputs = { ...DEFAULT_PLACEMENTS_SETTINGS, excluded_text: "", source: "link" };

const POOL_PLACEHOLDER = `NM1 4567890 5678901   ← upper (Tier 1) difficulty first, then the lower (Tier 2) one
NM2 https://osu.ppy.sh/beatmapsets/123456#osu/654321
NM2 T2 7891011        ← or the lower tier on its own line
TB  999999 999998

[Round 3]             ← optional: a section when a round uses a different pool
NM1 …`;

const fmtScore = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—");
const fmtAcc = (a: number | null | undefined) => (typeof a === "number" && Number.isFinite(a) ? `${(a * 100).toFixed(2)}%` : "—");
const fmtVal = (v: number | null | undefined, d = 4) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "—");
const fmtSigned = (v: number | null | undefined, d = 3) =>
  typeof v === "number" && Number.isFinite(v) ? `${v > 0 ? "+" : ""}${v.toFixed(d)}` : "—";
const dispMods = (mods: string[] | undefined) => (mods ?? []).filter((m) => m !== "NF").join("") || "NM";
const profile = (p: PlayerRef | null | undefined) => (p?.user_id ? `https://osu.ppy.sh/users/${p.user_id}` : undefined);
const roomUrl = (kind: RoomKind, id: number) =>
  kind === "lazer" ? `https://osu.ppy.sh/multiplayer/rooms/${id}` : `https://osu.ppy.sh/community/matches/${id}`;
const beatmapUrl = (id: number) => `https://osu.ppy.sh/b/${id}`;
const parseIds = (text: string) =>
  [...new Set(text.split(/[\s,;]+/).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))];

function Player({ p }: { p: PlayerRef | null | undefined }) {
  if (!p) return <span className="hint">—</span>;
  const url = profile(p);
  return url ? (
    <a href={url} target="_blank" rel="noreferrer">
      {p.name}
    </a>
  ) : (
    <span title="not matched to an osu! account">{p.name}</span>
  );
}

function StatusBadge({ status }: { status: PlacementsJob["status"] }) {
  const cls = status === "done" ? "live" : status === "running" || status === "queued" ? "rescan" : status === "error" ? "open" : "";
  return <span className={`badge ${cls}`}>{status}</span>;
}

async function api(path: string, method = "GET", body?: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(path, {
    method,
    cache: "no-store",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  return { ok: res.ok, status: res.status, data };
}

export default function PlacementsPanel() {
  const [me, setMe] = useState<MeResponse | null | undefined>(undefined);
  const [inputs, setInputs] = useState<Inputs>(DEFAULT_INPUTS);
  const [loaded, setLoaded] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [job, setJob] = useState<PlacementsJob | null>(null);
  const [result, setResult] = useState<PlacementsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [view, setView] = useState<View>("placements");
  const [setupOpen, setSetupOpen] = useState(true);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const user = me?.user ?? null;
  const isOwner = !!user?.is_site_owner;

  const flash = useCallback((kind: "ok" | "err", msg: string) => {
    setToast({ kind, msg });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  }, []);

  const set = <K extends keyof Inputs>(k: K, v: Inputs[K]) => setInputs((s) => ({ ...s, [k]: v }));

  const refreshJobs = useCallback(async () => {
    const r = await api("/api/placements/jobs");
    if (r.ok && Array.isArray(r.data?.jobs)) setJobs(r.data.jobs as JobSummary[]);
    return r.ok ? (r.data as { jobs: JobSummary[]; active: string | null }) : null;
  }, []);

  const openJob = useCallback(
    async (id: string, withResult = true) => {
      const r = await api(`/api/placements/jobs/${id}${withResult ? "" : "?result=0"}`);
      if (!r.ok) {
        flash("err", r.data?.error ?? "Couldn't load that run.");
        return null;
      }
      const j = r.data.job as PlacementsJob;
      setJob(j);
      if (withResult) setResult((r.data.result as PlacementsResult | null) ?? null);
      try {
        const u = new URL(window.location.href);
        u.searchParams.set("job", id);
        window.history.replaceState(null, "", u.toString());
      } catch {
        /* ignore */
      }
      return j;
    },
    [flash],
  );

  // session, saved inputs, deep link / latest run
  useEffect(() => {
    fetch("/api/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setMe((d as MeResponse) ?? null))
      .catch(() => setMe(null));
    try {
      const raw = window.localStorage.getItem(INPUTS_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<Inputs>;
        setInputs({ ...DEFAULT_INPUTS, ...saved, stages: Array.isArray(saved.stages) ? saved.stages : [] });
      }
    } catch {
      /* ignore */
    }
    setLoaded(true);
    (async () => {
      const wanted = new URLSearchParams(window.location.search).get("job");
      const list = await refreshJobs();
      if (wanted && /^[a-f0-9]{12}$/.test(wanted)) {
        const j = await openJob(wanted);
        if (j) {
          if (j.status === "done") setSetupOpen(false);
          return;
        }
      }
      const latest = list?.jobs.find((j) => j.status === "done") ?? list?.jobs.find((j) => j.status === "running" || j.status === "queued");
      if (latest) {
        const j = await openJob(latest.id);
        if (j?.status === "done") setSetupOpen(false);
      }
    })();
  }, [refreshJobs, openJob]);

  // persist inputs
  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(INPUTS_KEY, JSON.stringify(inputs));
    } catch {
      /* ignore */
    }
  }, [inputs, loaded]);

  // poll a live job
  const live = job && (job.status === "queued" || job.status === "running");
  useEffect(() => {
    if (!live || !job) return;
    const id = job.id;
    const t = setInterval(async () => {
      const r = await api(`/api/placements/jobs/${id}?result=0`);
      if (!r.ok) return;
      const j = r.data.job as PlacementsJob;
      if (j.status === "queued" || j.status === "running") {
        setJob(j);
        return;
      }
      clearInterval(t);
      const full = await openJob(id);
      void refreshJobs();
      if (full?.status === "done") {
        flash("ok", `Done — ${full.progress.message}`);
        setSetupOpen(false);
        setView("placements");
      } else if (full?.status === "error") flash("err", full.error ?? "The run failed.");
    }, POLL_MS);
    return () => clearInterval(t);
  }, [live, job, openJob, refreshJobs, flash]);

  async function uploadFile(file: File) {
    setPreviewBusy(true);
    try {
      const res = await fetch(`/api/placements/upload?tab=${encodeURIComponent(inputs.sheet_tab || "Chrono Schedule")}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: file,
      });
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        /* no body */
      }
      if (!res.ok || !Array.isArray(data?.rows)) {
        flash("err", data?.error ?? (res.status === 401 ? "Sign in first." : res.status === 413 ? "That file is too large." : "Couldn't read that file."));
        return;
      }
      const rows = data.rows as string[][];
      setInputs((s) => ({ ...s, source: "upload", schedule_rows: rows, schedule_file: file.name, sheet_tab: typeof data.tab === "string" ? data.tab : s.sheet_tab }));
      await readSheet(rows);
    } finally {
      setPreviewBusy(false);
    }
  }

  async function readSheet(uploadedRows?: string[][]) {
    setPreviewBusy(true);
    try {
      const rows = uploadedRows ?? (inputs.source === "upload" ? inputs.schedule_rows : null);
      if (inputs.source === "upload" && !rows) {
        flash("err", "Choose the .xlsx file first.");
        return;
      }
      const r = await api("/api/placements/preview", "POST", {
        sheet_url: inputs.source === "link" ? inputs.sheet_url : "",
        sheet_tab: inputs.sheet_tab,
        pool_text: inputs.pool_text,
        schedule_rows: rows,
      });
      if (!r.ok) {
        setPreview(null);
        flash("err", r.data?.error ?? (r.status === 401 ? "Sign in first." : "Couldn't read the sheet."));
        return;
      }
      const p = r.data as PreviewResponse;
      setPreview(p);
      // default the stage selection to every stage with a played match
      const playable = p.schedule.stages.filter((s) => s.played + s.forfeits > 0).map((s) => s.stage);
      setInputs((s) => {
        const keep = s.stages.filter((x) => p.schedule.stages.some((st) => st.stage === x));
        return { ...s, stages: keep.length ? keep : playable };
      });
      const issues = p.schedule.warnings.length + p.pool.warnings.length;
      flash("ok", `Read ${p.schedule.total_rows} rows, ${p.schedule.rooms} lobbies, ${p.pool.maps.length} pool maps${issues ? ` — ${issues} warning(s) below` : ""}.`);
    } finally {
      setPreviewBusy(false);
    }
  }

  async function generate() {
    setBusy(true);
    try {
      const { excluded_text, source, ...rest } = inputs;
      const body: PlacementsSettings = {
        ...rest,
        sheet_url: source === "link" ? rest.sheet_url : "",
        schedule_rows: source === "upload" ? rest.schedule_rows : null,
        schedule_file: source === "upload" ? rest.schedule_file : null,
        excluded_items: parseIds(excluded_text),
      };
      const r = await api("/api/placements/jobs", "POST", body);
      if (!r.ok) {
        const msg: string = r.data?.error ?? "Couldn't start the run.";
        flash("err", msg);
        if (r.status === 409 && typeof r.data?.active === "string") void openJob(r.data.active, false);
        return;
      }
      setResult(null);
      setJob(r.data.job as PlacementsJob);
      setView("placements");
      void refreshJobs();
      try {
        const u = new URL(window.location.href);
        u.searchParams.set("job", (r.data.job as PlacementsJob).id);
        window.history.replaceState(null, "", u.toString());
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!job) return;
    const r = await api(`/api/placements/jobs/${job.id}`, "DELETE");
    if (!r.ok) flash("err", r.data?.error ?? "Couldn't cancel.");
  }

  function reuse(settings: PlacementsSettings) {
    setInputs({ ...DEFAULT_INPUTS, ...settings, excluded_text: settings.excluded_items.join(" "), source: settings.schedule_rows ? "upload" : "link" });
    setPreview(null);
    setSetupOpen(true);
    flash("ok", "Inputs loaded from that run — read the sheet again to check the stages.");
  }

  const stageRows = preview?.schedule.stages ?? [];
  const poolSummary = useMemo(() => {
    if (!preview) return null;
    const bySection = new Map<string, { maps: number; slots: Set<string>; tb: number }>();
    for (const m of preview.pool.maps) {
      const key = m.stage ?? "Every stage";
      let s = bySection.get(key);
      if (!s) bySection.set(key, (s = { maps: 0, slots: new Set(), tb: 0 }));
      s.maps++;
      s.slots.add(m.label);
      if (m.is_tb) s.tb++;
    }
    return [...bySection.entries()];
  }, [preview]);

  const hasSchedule = inputs.source === "upload" ? !!inputs.schedule_rows?.length : inputs.sheet_url.trim().length > 0;
  const canGenerate = isOwner && !busy && !live && hasSchedule && inputs.pool_text.trim().length > 0;
  const progressPct = job ? (job.status === "done" ? 100 : job.progress.total > 0 ? Math.round((job.progress.done / job.progress.total) * 100) : null) : null;

  return (
    <main className="wrap">
      <NavBar />
      <div className="head">
        <div>
          <h1 className="title">Final placements</h1>
          <p className="subtitle">
            One click from the referee sheet to a full stats workbook: points from the schedule, performance across every counted map, and a
            standings order that doesn&apos;t punish sweeps or forfeit wins.
          </p>
        </div>
      </div>

      {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}

      {/* ---- setup ---------------------------------------------------------- */}
      <div className="panel">
        <div className="row between" style={{ alignItems: "center" }}>
          <h2 style={{ margin: 0 }}>Set up a run</h2>
          <button className="btn-sm" onClick={() => setSetupOpen((o) => !o)}>
            {setupOpen ? "Hide" : "Show"}
          </button>
        </div>
        {setupOpen && (
          <>
            {me === null && (
              <p className="hint" style={{ marginTop: 12 }}>
                <a href="/api/auth/login?next=%2Fplacements">Sign in with osu!</a> to read a sheet. Only the site owner can generate a run
                (it spends osu! API requests); results are public.
              </p>
            )}
            {user && !isOwner && (
              <p className="hint" style={{ marginTop: 12 }}>
                You can read a sheet to check how it parses, but only the site owner can generate a run.
              </p>
            )}
            <div className="plc-form" style={{ marginTop: 14 }}>
              <label className="plc-field">
                <span className="plc-label">Tournament title</span>
                <input className="input" value={inputs.title} placeholder="AEROLS" onChange={(e) => set("title", e.target.value)} />
              </label>
              <div className="plc-field plc-wide">
                <span className="plc-label">Referee sheet</span>
                <div className="lock-row">
                  <div className="tabs">
                    <button className={`tab ${inputs.source === "link" ? "active" : ""}`} onClick={() => set("source", "link")}>
                      Google Sheets link
                    </button>
                    <button className={`tab ${inputs.source === "upload" ? "active" : ""}`} onClick={() => set("source", "upload")}>
                      Upload .xlsx
                    </button>
                  </div>
                  <span className="hint">
                    {inputs.source === "link"
                      ? "The sheet must be “anyone with the link can view”."
                      : "File → Download → Microsoft Excel (.xlsx). Set the tab name first; re-upload after the sheet changes."}
                  </span>
                </div>
                {inputs.source === "link" ? (
                  <input
                    className="input"
                    value={inputs.sheet_url}
                    placeholder="https://docs.google.com/spreadsheets/d/…/edit"
                    onChange={(e) => set("sheet_url", e.target.value)}
                  />
                ) : (
                  <div className="lock-row">
                    <label className={`btn ghost ${previewBusy || !user ? "plc-disabled" : ""}`} style={{ cursor: "pointer" }}>
                      {previewBusy ? "Reading…" : "Choose .xlsx…"}
                      <input
                        type="file"
                        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                        style={{ display: "none" }}
                        disabled={previewBusy || !user}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = "";
                          if (f) void uploadFile(f);
                        }}
                      />
                    </label>
                    <span className="hint">
                      {inputs.schedule_rows?.length
                        ? `Loaded “${inputs.sheet_tab}” from ${inputs.schedule_file ?? "the upload"} (${inputs.schedule_rows.length} rows).`
                        : "No file loaded yet."}
                    </span>
                  </div>
                )}
              </div>
              <label className="plc-field plc-wide">
                <span className="plc-label">
                  Mappool — manual input, one slot per line: label + beatmap ids/urls, <b>upper (Tier 1) difficulty first, lower (Tier 2) second</b>{" "}
                  (or on its own line as <span className="mono">NM1 T2 &lt;id&gt;</span>); <span className="mono">[Stage]</span> sections for round-specific
                  pools; a label starting with TB is the tiebreaker
                </span>
                <textarea
                  className="input plc-pool"
                  value={inputs.pool_text}
                  placeholder={POOL_PLACEHOLDER}
                  spellCheck={false}
                  onChange={(e) => set("pool_text", e.target.value)}
                />
              </label>
            </div>
            <div className="lock-row" style={{ marginTop: 10 }}>
              <button className="btn ghost" disabled={previewBusy || !user || !hasSchedule} onClick={() => void readSheet()}>
                {previewBusy ? "Reading…" : inputs.source === "upload" ? "Re-check" : "Read sheet"}
              </button>
              <span className="hint">Parses the schedule tab and the pool without touching the osu! API.</span>
            </div>

            {preview && (
              <div className="plc-preview">
                <div className="plc-label" style={{ marginBottom: 6 }}>
                  Stages to include ({preview.schedule.total_rows} rows, header on row {preview.schedule.header_row};{" "}
                  {preview.schedule.lazer_rooms} lazer rooms{preview.schedule.legacy_matches ? `, ${preview.schedule.legacy_matches} legacy matches` : ""})
                </div>
                <div className="plc-stages">
                  {stageRows.map((s) => {
                    const on = inputs.stages.includes(s.stage);
                    return (
                      <label key={s.stage} className={`plc-stage ${on ? "on" : ""}`}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) =>
                            set("stages", e.target.checked ? [...inputs.stages, s.stage] : inputs.stages.filter((x) => x !== s.stage))
                          }
                        />
                        <span className="plc-stage-name">{s.stage}</span>
                        <span className="hint">
                          {s.played} played · {s.forfeits} FF · {s.unplayed} unplayed
                          {s.first_to.length ? ` · first to ${s.first_to.join("/")}` : ""}
                          {s.with_rooms < s.played ? ` · ${s.played - s.with_rooms} played without a lobby link!` : ""}
                        </span>
                      </label>
                    );
                  })}
                  {stageRows.length === 0 && <span className="hint">No stages found — check the tab name and the header row.</span>}
                </div>
                {poolSummary && poolSummary.length > 0 && (
                  <div className="hint" style={{ marginTop: 10 }}>
                    Pool:{" "}
                    {poolSummary
                      .map(([sec, s]) => `${sec}: ${s.maps} maps in ${s.slots.size} slots${s.tb ? ` (TB ×${s.tb})` : " (no TB)"}`)
                      .join(" · ")}
                  </div>
                )}
                {preview.pool.maps.length === 0 && (
                  <div className="toast err" style={{ marginTop: 10 }}>
                    The mappool is empty — paste the pool above (labels + beatmap ids or links).
                  </div>
                )}
                {[...preview.schedule.warnings, ...preview.pool.warnings].map((w, i) => (
                  <div key={i} className="toast err" style={{ marginTop: 8 }}>
                    {w}
                  </div>
                ))}
              </div>
            )}

            <div className="hr" />
            <h2>Formula</h2>
            <div className="plc-form">
              <label className="plc-field" title="k phantom average maps added to every player's average. 0 = plain average; higher = small samples are pulled harder toward the middle.">
                <span className="plc-label">Prior maps (k)</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={50}
                  step={0.5}
                  value={inputs.prior_maps}
                  onChange={(e) => set("prior_maps", Math.max(0, Math.min(50, Number(e.target.value) || 0)))}
                />
              </label>
              <label className="plc-field" title="A map with fewer counted plays than this (or no spread) is skipped in the ratings.">
                <span className="plc-label">Min plays per map</span>
                <input
                  className="input"
                  type="number"
                  min={2}
                  max={100}
                  step={1}
                  value={inputs.min_plays}
                  onChange={(e) => set("min_plays", Math.max(2, Math.min(100, Math.round(Number(e.target.value)) || 2)))}
                />
              </label>
              <label className="plc-field" title="Φ(z): every counted play scored 0–1 against the slot's field and averaged — rewards consistency, one pop-off score barely moves it. z: same without saturation. Zipf: best score per slot ranked among everyone, worth 1/placement — top scores dominate.">
                <span className="plc-label">Tiebreak</span>
                <select className="input" value={inputs.value_mode} onChange={(e) => set("value_mode", e.target.value as Inputs["value_mode"])}>
                  <option value="phi">Φ(z) average — consistency (default)</option>
                  <option value="z">z average — no saturation</option>
                  <option value="zipf">Zipf placement average — top scores dominate</option>
                </select>
              </label>
              <label className="plc-field" title="Φ(z) / z only — Zipf is always one value per slot.">
                <span className="plc-label">Averaging (Φ/z only)</span>
                <select
                  className="input"
                  value={inputs.map_weighting}
                  onChange={(e) => set("map_weighting", e.target.value as Inputs["map_weighting"])}
                >
                  <option value="per_play">Every counted play weighs the same</option>
                  <option value="per_map">Average per unique map first</option>
                </select>
              </label>
              <label className="plc-field" title="Applied to scores set on a lower-tier difficulty (the 2nd+ id on a pool line) inside the tiebreak only. Leaderboards, mappool stats and grids always show raw scores. AEROLS: 0.95.">
                <span className="plc-label">T2 multiplier (tiebreak only)</span>
                <input
                  className="input"
                  type="number"
                  min={0.5}
                  max={1.5}
                  step={0.01}
                  value={inputs.lower_multiplier}
                  onChange={(e) => set("lower_multiplier", Math.max(0.5, Math.min(1.5, Number(e.target.value) || 1)))}
                />
              </label>
              <label className="plc-field plc-wide">
                <span className="plc-label">Excluded playlist items (ids from the Games tab, e.g. a warmup that happens to be a pool map)</span>
                <input
                  className="input"
                  value={inputs.excluded_text}
                  placeholder="12345678 12345679"
                  onChange={(e) => set("excluded_text", e.target.value)}
                />
              </label>
            </div>
            <div className="lock-row" style={{ marginTop: 12, gap: 18 }}>
              <label className="toggle" title="Lazer submits failed scores with passed=false; keep them in the ratings?">
                <button className={`switch ${inputs.count_failed ? "on" : ""}`} onClick={() => set("count_failed", !inputs.count_failed)} aria-label="count failed scores" />
                <span className="hint">Count failed scores</span>
              </label>
              <label className="toggle" title="If the sheet says forfeit but the lobby has played maps, count those maps for the ratings (points still come from the sheet).">
                <button
                  className={`switch ${inputs.forfeit_lobby_maps ? "on" : ""}`}
                  onClick={() => set("forfeit_lobby_maps", !inputs.forfeit_lobby_maps)}
                  aria-label="count maps played in forfeited matches"
                />
                <span className="hint">Count maps played in forfeited matches</span>
              </label>
            </div>
            <p className="hint" style={{ margin: "12px 0 0" }}>
              Standings: points from the sheet (1 per win, forfeit wins included) → tiebreak (an average over the slots played, with k phantom
              &ldquo;average&rdquo; slots, so map count is neutral; T2 scores × multiplier only inside this step) → plain average → name. Counted maps: pool maps both players scored on, in lobby order,
              up to the sheet&apos;s red + blue score — so warmups, aborted maps and &ldquo;for fun&rdquo; maps after the match never count, and a TB only
              counts as the deciding map at (first-to − 1) each.
            </p>
            <div className="lock-row" style={{ marginTop: 14 }}>
              <button className="btn" disabled={!canGenerate} onClick={generate} title={isOwner ? "" : "Site owner only"}>
                {busy ? "Starting…" : live ? "Run in progress…" : "Generate final placements"}
              </button>
              {!isOwner && me !== undefined && <span className="hint">Site owner only.</span>}
            </div>
          </>
        )}
      </div>

      {/* ---- progress / result ------------------------------------------- */}
      {job && (
        <div className="panel">
          <div className="row between" style={{ alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <h2 style={{ margin: 0 }}>
              {job.title || "Run"} <StatusBadge status={job.status} />
            </h2>
            <div className="lock-row">
              {job.status === "done" && (
                <a className="btn blue" href={`/api/placements/jobs/${job.id}/export`} download>
                  Download .xlsx
                </a>
              )}
              {isOwner && live && (
                <button className="btn danger" onClick={cancel}>
                  Cancel
                </button>
              )}
              {isOwner && !live && (
                <button className="btn ghost" onClick={() => reuse(job.settings)}>
                  Reuse these inputs
                </button>
              )}
            </div>
          </div>
          <div className="hint" style={{ marginTop: 6 }}>
            Started {fmtDateTime(job.created_at)} ({fmtAgo(job.created_at)})
            {job.finished_at ? ` · finished ${fmtDateTime(job.finished_at)}` : ""} · {job.progress.message}
          </div>
          {live && (
            <div style={{ marginTop: 10 }}>
              <div className={`gauge-track ${progressPct === null ? "plc-indeterminate" : ""}`}>
                <div className="gauge-fill" style={{ width: progressPct === null ? "30%" : `${progressPct}%` }} />
              </div>
              <div className="gauge-labels">
                <span>{job.progress.phase}</span>
                <span>{job.progress.total > 0 ? `${job.progress.done} / ${job.progress.total}` : "…"}</span>
              </div>
            </div>
          )}
          {job.status === "error" && <div className="toast err">{job.error ?? "The run failed."}</div>}
          {job.status === "cancelled" && <div className="toast">Cancelled.</div>}
          {job.status === "done" && !result && <div className="empty">Loading results…</div>}
          {result && <Results result={result} view={view} setView={setView} />}
        </div>
      )}

      {/* ---- recent runs ---------------------------------------------------- */}
      <div className="panel">
        <h2>Recent runs</h2>
        {jobs.length === 0 && <div className="empty">No runs yet.</div>}
        {jobs.map((j) => (
          <div key={j.id} className="walk-row">
            <StatusBadge status={j.status} />
            <span style={{ fontWeight: 600 }}>{j.title || j.id}</span>
            <span className="hint">{fmtDateTime(j.created_at)}</span>
            <span className="hint" style={{ flex: 1, minWidth: 160 }}>
              {j.status === "error" ? j.error : j.progress.message}
            </span>
            <button className="btn-sm" disabled={job?.id === j.id && !!result} onClick={() => openJob(j.id)}>
              Open
            </button>
          </div>
        ))}
      </div>
    </main>
  );
}

// ---- results ------------------------------------------------------------------

function Results({ result, view, setView }: { result: PlacementsResult; view: View; setView: (v: View) => void }) {
  const tabs: { id: View; label: string }[] = [
    { id: "placements", label: "Final placements" },
    { id: "performance", label: "Performance" },
    { id: "mappool", label: "Mappool" },
    { id: "leaderboards", label: "Map leaderboards" },
    { id: "grid", label: "Scores grid" },
    { id: "matches", label: `Matches (${result.counts.matches})` },
    { id: "games", label: `Games (${result.counts.games_counted}+${result.counts.games_excluded})` },
    { id: "notes", label: `Notes${result.notes.length ? ` (${result.notes.length})` : ""}` },
  ];
  return (
    <div style={{ marginTop: 14 }}>
      <div className="stats" style={{ marginTop: 0, marginBottom: 12 }}>
        <div className="stat">
          <div className="k">Players</div>
          <div className="v">{fmtNum(result.counts.players)}</div>
        </div>
        <div className="stat">
          <div className="k">Matches</div>
          <div className="v">{fmtNum(result.counts.matches)}</div>
        </div>
        <div className="stat">
          <div className="k">Lobbies read</div>
          <div className="v">{fmtNum(result.counts.rooms)}</div>
        </div>
        <div className="stat">
          <div className="k">Maps counted</div>
          <div className="v">{fmtNum(result.counts.games_counted)}</div>
        </div>
        <div className="stat">
          <div className="k">Maps excluded</div>
          <div className="v">{fmtNum(result.counts.games_excluded)}</div>
        </div>
        <div className="stat">
          <div className="k">Slots in tiebreak</div>
          <div className="v">
            {result.maps.filter((m) => m.tiebreak.rated).length}/{result.maps.length}
          </div>
        </div>
      </div>
      <div className="tabs" style={{ marginBottom: 10, flexWrap: "wrap" }}>
        {tabs.map((t) => (
          <button key={t.id} className={`tab ${view === t.id ? "active" : ""}`} onClick={() => setView(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {view === "placements" && <PlacementsTable result={result} />}
      {view === "performance" && <PerformanceTable result={result} />}
      {view === "mappool" && <MappoolTable result={result} />}
      {view === "leaderboards" && <Leaderboards result={result} />}
      {view === "grid" && <ScoresGrid result={result} />}
      {view === "matches" && <MatchesTable result={result} />}
      {view === "games" && <GamesTable result={result} />}
      {view === "notes" && <NotesView result={result} />}
    </div>
  );
}

function valueLabel(result: PlacementsResult) {
  return result.settings.value_mode === "z" ? "z" : result.settings.value_mode === "phi" ? "Φ(z)" : "1/rank";
}
const tierName = (tier: number, tiers: number) => (tiers > 1 ? (tier === 0 ? "T1" : tiers === 2 ? "T2" : `T${tier + 1}`) : "");

function StageCell({ row, stage }: { row: PlacementRow; stage: string }) {
  const s = row.stages.find((x) => x.stage === stage);
  if (!s || s.result === "—") return <span className="hint">—</span>;
  const cls = s.result === "W" || s.result === "FFW" ? "p1" : s.result === "L" || s.result === "FFL" || s.result === "FF" ? "p2" : "p4";
  return (
    <>
      <span className={`place ${cls}`}>{s.result}</span> <span className="mono">{s.score}</span>{" "}
      {s.opponent && (
        <span className="hint">
          vs <Player p={s.opponent} />
        </span>
      )}
    </>
  );
}

function PlacementsTable({ result }: { result: PlacementsResult }) {
  const vl = valueLabel(result);
  return (
    <>
      <div className="tgrid-wrap">
        <table className="tgrid stable">
          <thead>
            <tr>
              <th className="col-team">#</th>
              <th className="col-player">Player</th>
              <th title="From the referee sheet: 1 per win, forfeit wins included">Pts ▼</th>
              <th title="Wins – losses (forfeits in brackets)">W–L</th>
              <th title={result.formula[1]}>{result.tiebreak_label} ▼</th>
              <th title="Plain average of the per-slot value, without the prior">Avg {vl}</th>
              <th title="Slots where the player's best raw score is #1">Top</th>
              <th title="Average raw placement over slots played">Avg #</th>
              <th title="Slots played / slots in the pool (counted plays in brackets)">Maps</th>
              <th title="Map wins–losses–ties by raw score; shown only, never sorted on (cross-tier games are not comparable)">Map W–L–T</th>
              <th title="Sum of opponents' points (shown only)">Buchholz</th>
              {result.stages.map((s) => (
                <th key={s}>{s}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.placements.map((r) => (
              <tr key={r.player.key}>
                <td className="col-team">
                  <span className={`place p${Math.min(r.rank, 4)}`}>#{r.rank}</span>
                </td>
                <td className="col-player">
                  <Player p={r.player} />
                </td>
                <td className="mono">{r.points}</td>
                <td className="mono">
                  {r.wins}–{r.losses}
                  {r.forfeit_wins + r.forfeit_losses > 0 && (
                    <span className="hint">
                      {" "}
                      ({r.forfeit_wins}FF/{r.forfeit_losses}FF)
                    </span>
                  )}
                </td>
                <td className="mono">{fmtVal(r.performance)}</td>
                <td className="mono">{fmtVal(r.avg_value)}</td>
                <td className="mono">{r.top_scores || "—"}</td>
                <td className="mono">{fmtVal(r.avg_placement, 2)}</td>
                <td className="mono">
                  {r.unique_maps}/{r.slots_total} <span className="hint">({r.counted_plays})</span>
                </td>
                <td className="mono">
                  {r.map_wins}–{r.map_losses}–{r.map_ties}
                </td>
                <td className="mono">{r.buchholz}</td>
                {result.stages.map((s) => (
                  <td key={s} className="cell">
                    <StageCell row={r} stage={s} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint" style={{ margin: "8px 0 0" }}>
        {result.formula.join(" ")}
      </p>
    </>
  );
}

function PerformanceTable({ result }: { result: PlacementsResult }) {
  const mapById = new Map(result.maps.flatMap((m) => m.beatmaps.map((b) => [b.beatmap_id, b] as const)));
  const rows = [...result.placements].sort((a, b) => (b.performance ?? -Infinity) - (a.performance ?? -Infinity) || (b.avg_value ?? -Infinity) - (a.avg_value ?? -Infinity));
  const total = result.maps.length;
  return (
    <div className="tgrid-wrap">
      <table className="tgrid stable">
        <thead>
          <tr>
            <th className="col-team">#</th>
            <th className="col-player">Player</th>
            <th title={result.formula[1]}>{result.tiebreak_label} ▼</th>
            <th title="Plain average of the per-slot value, without the prior">Avg {valueLabel(result)}</th>
            <th title="Slots played / slots in the pool">Maps played</th>
            <th title="Slots where the player's best raw score is #1">Top scores</th>
            <th title="Average raw placement over slots played">Avg placement</th>
            <th>Avg score</th>
            <th>Avg acc</th>
            <th>Best score</th>
            <th title="Final placement (points first)">Final</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.player.key}>
              <td className="col-team">{i + 1}</td>
              <td className="col-player">
                <Player p={r.player} />
              </td>
              <td className="mono">{fmtVal(r.performance)}</td>
              <td className="mono">{fmtVal(r.avg_value)}</td>
              <td className="mono">
                {r.unique_maps}/{total} <span className="hint">({total ? Math.round((r.unique_maps / total) * 100) : 0}%)</span>
              </td>
              <td className="mono">{r.top_scores || "—"}</td>
              <td className="mono">{fmtVal(r.avg_placement, 2)}</td>
              <td className="mono">{fmtScore(r.avg_score)}</td>
              <td className="mono">{fmtAcc(r.avg_acc)}</td>
              <td className="mono">
                {r.best ? (
                  <>
                    {fmtScore(r.best.score)}{" "}
                    <a href={roomUrl(r.best.room_kind, r.best.room_id)} target="_blank" rel="noreferrer" className="hint" title={mapById.get(r.best.beatmap_id)?.title}>
                      {r.best.label} · {r.best.match_id ? `#${r.best.match_id}` : "lobby"}
                    </a>
                  </>
                ) : (
                  "—"
                )}
              </td>
              <td className="mono">
                #{r.rank} <span className="hint">({r.points} pts)</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MappoolTable({ result }: { result: PlacementsResult }) {
  return (
    <div className="tgrid-wrap">
      <table className="tgrid stable">
        <thead>
          <tr>
            <th className="col-team">Map</th>
            <th>Tier</th>
            <th className="col-player">Artist - Title [Diff]</th>
            <th>★</th>
            <th>Best player</th>
            <th>Score</th>
            <th>Acc</th>
            <th>Mods</th>
            <th>Match</th>
            <th>Plays</th>
            <th>Avg score</th>
            <th>Median</th>
            <th>Avg acc</th>
          </tr>
        </thead>
        <tbody>
          {result.maps.flatMap((m) =>
            m.beatmaps.map((b) => (
              <tr key={b.beatmap_id}>
                <td className="col-team">{m.label}</td>
                <td className="hint">{tierName(b.tier, m.beatmaps.length) || "—"}</td>
                <td className="col-player">
                  <a href={b.url} target="_blank" rel="noreferrer">
                    {b.title}
                  </a>
                </td>
                <td className="mono">{b.difficulty_rating !== null ? b.difficulty_rating.toFixed(2) : "—"}</td>
                <td>{b.best ? <Player p={b.best.player} /> : <span className="hint">—</span>}</td>
                <td className="mono">{b.best ? fmtScore(b.best.score) : "—"}</td>
                <td className="mono">{b.best ? fmtAcc(b.best.accuracy) : "—"}</td>
                <td>{b.best ? <span className="modchip">{dispMods(b.best.mods)}</span> : "—"}</td>
                <td className="mono">
                  {b.best ? (
                    <a href={roomUrl(b.best.room_kind, b.best.room_id)} target="_blank" rel="noreferrer">
                      {b.best.match_id ? `#${b.best.match_id}` : "lobby"}
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="mono">{b.plays}</td>
                <td className="mono">{fmtScore(b.mean)}</td>
                <td className="mono">{fmtScore(b.median)}</td>
                <td className="mono">{fmtAcc(b.avg_acc)}</td>
              </tr>
            ))
          )}
          {result.maps.length === 0 && (
            <tr>
              <td colSpan={13} className="hint">
                No pool maps.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Leaderboards({ result }: { result: PlacementsResult }) {
  const [idx, setIdx] = useState(0);
  const map: MapStatRow | undefined = result.maps[idx];
  const entries: LeaderboardEntry[] = map ? (result.leaderboards[map.key] ?? []) : [];
  const tiers = map ? map.beatmaps.length : 1;
  return (
    <>
      <div className="row" style={{ marginBottom: 8, flexWrap: "wrap", gap: 4 }}>
        {result.maps.map((m, i) => (
          <button key={m.key} className={`tab ${idx === i ? "active" : ""}`} style={{ fontSize: 12 }} onClick={() => setIdx(i)} title={m.beatmaps.map((b) => b.title).join(" / ")}>
            {m.label}
          </button>
        ))}
      </div>
      {map && (
        <div className="tgrid-meta">
          {map.beatmaps.map((b, i) => (
            <span key={b.beatmap_id}>
              {i > 0 ? " · " : ""}
              {tiers > 1 ? `${tierName(b.tier, tiers)}: ` : ""}
              <a href={b.url} target="_blank" rel="noreferrer">
                {b.title}
              </a>
            </span>
          ))}
          {" · "}avg score {fmtScore(map.mean)} · avg acc {fmtAcc(map.avg_acc)} · {map.plays} plays / {map.players} players · raw scores, both tiers together
        </div>
      )}
      <div className="tgrid-wrap">
        <table className="tgrid stable">
          <thead>
            <tr>
              <th className="col-team">#</th>
              <th className="col-player">Player</th>
              {tiers > 1 && <th>Tier</th>}
              <th>Score ▼</th>
              <th>Acc</th>
              <th>Combo</th>
              <th>Mods</th>
              <th>Match</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={`${e.player.key}-${e.room_id}-${i}`}>
                <td className="col-team">
                  <span className={`place p${Math.min(e.rank, 4)}`}>#{e.rank}</span>
                </td>
                <td className="col-player">
                  <Player p={e.player} />
                  {!e.passed && (
                    <span className="badge open" style={{ marginLeft: 6 }}>
                      F
                    </span>
                  )}
                </td>
                {tiers > 1 && <td className="hint">{tierName(e.tier, tiers)}</td>}
                <td className="mono">{fmtScore(e.score)}</td>
                <td className="mono">{fmtAcc(e.accuracy)}</td>
                <td className="mono">{e.max_combo ?? "—"}</td>
                <td>
                  <span className="modchip">{dispMods(e.mods)}</span>
                </td>
                <td className="mono">
                  <a href={roomUrl(e.room_kind, e.room_id)} target="_blank" rel="noreferrer">
                    {e.match_id ? `#${e.match_id}` : "lobby"}
                  </a>{" "}
                  <span className="hint">{e.stage}</span>
                </td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={tiers > 1 ? 8 : 7} className="hint">
                  No counted plays on this map.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ScoresGrid({ result }: { result: PlacementsResult }) {
  const [detail, setDetail] = useState(false);
  const rankByKey = new Map(result.placements.map((p) => [p.player.key, p.rank]));
  const players = [...result.grid.players].sort((a, b) => (rankByKey.get(a.key) ?? 1e9) - (rankByKey.get(b.key) ?? 1e9));
  const vl = valueLabel(result);
  return (
    <>
      <div className="lock-row" style={{ marginBottom: 8 }}>
        <div className="tabs">
          <button className={`tab ${!detail ? "active" : ""}`} onClick={() => setDetail(false)}>
            Scores (raw)
          </button>
          <button className={`tab ${detail ? "active" : ""}`} onClick={() => setDetail(true)}>
            Tiebreak detail
          </button>
        </div>
        <span className="hint">
          {detail
            ? `What the tiebreak used per slot: adjusted best score (T2 × ${result.settings.lower_multiplier}), its placement, and the ${vl} value.`
            : "Best raw score per slot and its placement among every player's best (ties share)."}
        </span>
      </div>
      <div className="tgrid-wrap">
        <table className="tgrid stable">
          <thead>
            <tr>
              <th className="col-team">Player</th>
              {result.maps.map((m) => (
                <th key={m.key} className="col-map">
                  <a href={m.url} target="_blank" rel="noreferrer" title={m.beatmaps.map((b) => b.title).join(" / ")}>
                    <div className="map-title">{m.label}</div>
                    <div className="map-sub">{m.title.length > 22 ? m.title.slice(0, 22) + "…" : m.title}</div>
                  </a>
                  <div className="map-sub">{detail ? `adj # · adj · ${vl}` : "# · score"}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {players.map((p) => {
              const row = result.grid.cells[p.key] ?? {};
              return (
                <tr key={p.key}>
                  <td className="col-team">
                    <span className="hint">#{rankByKey.get(p.key) ?? "—"}</span> <Player p={p} />
                  </td>
                  {result.maps.map((m) => {
                    const c = row[m.key] ?? null;
                    if (!c)
                      return (
                        <td key={m.key} className="mono cell">
                          <span className="hint">—</span>
                        </td>
                      );
                    return detail ? (
                      <td key={m.key} className="mono cell" title={`raw ${fmtScore(c.score)} (${tierName(c.tier, m.beatmaps.length) || "single tier"})`}>
                        <span className={`place p${Math.min(c.tiebreak.placement, 4)}`}>#{c.tiebreak.placement}</span>{" "}
                        <span className="hint">{fmtScore(c.tiebreak.adjusted)}</span>{" "}
                        <span className="hint">{c.tiebreak.value === null ? "unrated" : fmtVal(c.tiebreak.value, 3)}</span>
                      </td>
                    ) : (
                      <td key={m.key} className="mono cell" title={`${c.plays} play(s)${m.beatmaps.length > 1 ? ` · ${tierName(c.tier, m.beatmaps.length)}` : ""}`}>
                        <span className={`place p${Math.min(c.placement, 4)}`}>#{c.placement}</span> <span className="hint">{fmtScore(c.score)}</span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function outcomeText(m: MatchResult) {
  if (m.outcome === "unplayed") return "unplayed";
  if (m.forfeit === "both") return "double forfeit";
  if (m.forfeit) return `${m.forfeit === "red" ? m.red.name : m.blue.name} forfeited`;
  if (m.outcome === "tie") return "tie";
  return `${m.outcome === "red" ? m.red.name : m.blue.name} wins`;
}

function MatchesTable({ result }: { result: PlacementsResult }) {
  return (
    <div className="tgrid-wrap">
      <table className="tgrid stable">
        <thead>
          <tr>
            <th className="col-team">Match</th>
            <th>Stage</th>
            <th className="col-player">Red</th>
            <th>Blue</th>
            <th title="From the sheet">Sheet</th>
            <th title="Raw-score reconstruction of the counted maps (cross-tier games may differ from the real result)">Lobby</th>
            <th>Pts</th>
            <th>Counted</th>
            <th>Lobbies</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {result.matches.map((m) => (
            <tr key={`${m.match_id}-${m.stage}-${m.red.key}-${m.blue.key}`}>
              <td className="col-team">{m.match_id || "—"}</td>
              <td className="hint">
                {m.stage}
                {m.first_to ? ` · ft${m.first_to}` : ""}
              </td>
              <td className="col-player">
                <Player p={m.red} />
              </td>
              <td>
                <Player p={m.blue} />
              </td>
              <td className="mono" title={outcomeText(m)}>
                {m.forfeit ? "FF" : m.sheet_score ? `${m.sheet_score[0]}–${m.sheet_score[1]}` : "—"}
              </td>
              <td className="mono">{m.lobby_score ? `${m.lobby_score[0]}–${m.lobby_score[1]}` : "—"}</td>
              <td className="mono">
                {m.points[0]}–{m.points[1]}
              </td>
              <td className="mono">
                {m.counted}/{m.games.length}
              </td>
              <td className="mono">
                {m.rooms.map((r, i) => (
                  <a
                    key={i}
                    href={r.ref.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ marginRight: 6, color: r.ok ? undefined : "var(--red)" }}
                    title={r.ok ? (r.name ?? "") : (r.error ?? "unreadable")}
                  >
                    {r.ref.kind === "lazer" ? "room" : "mp"} {r.ref.id}
                    {r.ok ? "" : " ✕"}
                  </a>
                ))}
                {m.rooms.length === 0 && <span className="hint">none</span>}
              </td>
              <td className="hint" style={{ whiteSpace: "normal", minWidth: 220 }}>
                {m.notes.join(" ") || ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GamesTable({ result }: { result: PlacementsResult }) {
  const [filter, setFilter] = useState<"all" | "counted" | "excluded">("all");
  const [matchKey, setMatchKey] = useState("all");
  const mapById = new Map(result.maps.flatMap((m) => m.beatmaps.map((b) => [b.beatmap_id, b] as const)));
  const rows: { m: MatchResult; g: MatchGame }[] = [];
  for (const m of result.matches) {
    const key = `${m.match_id}|${m.stage}`;
    if (matchKey !== "all" && key !== matchKey) continue;
    for (const g of m.games) if (filter === "all" || g.status === filter) rows.push({ m, g });
  }
  return (
    <>
      <div className="lock-row" style={{ marginBottom: 8 }}>
        <select className="input" style={{ maxWidth: 320 }} value={matchKey} onChange={(e) => setMatchKey(e.target.value)}>
          <option value="all">All matches</option>
          {result.matches
            .filter((m) => m.games.length > 0)
            .map((m) => (
              <option key={`${m.match_id}|${m.stage}`} value={`${m.match_id}|${m.stage}`}>
                {m.stage} · {m.match_id || "?"} · {m.red.name} vs {m.blue.name}
              </option>
            ))}
        </select>
        <div className="tabs">
          {(["all", "counted", "excluded"] as const).map((f) => (
            <button key={f} className={`tab ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
        <span className="hint">Copy an item id into &ldquo;Excluded playlist items&rdquo; to drop a map from a re-run.</span>
      </div>
      <div className="tgrid-wrap">
        <table className="tgrid stable">
          <thead>
            <tr>
              <th className="col-team">Match</th>
              <th>#</th>
              <th className="col-player">Map</th>
              <th>Red</th>
              <th>Blue</th>
              <th>Raw</th>
              <th>Status</th>
              <th>Reason</th>
              <th>Item id</th>
              <th>Lobby</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ m, g }) => {
              const pm = mapById.get(g.beatmap_id);
              return (
                <tr key={`${g.room_id}-${g.item_id}`} style={g.status === "excluded" ? { opacity: 0.65 } : undefined}>
                  <td className="col-team">
                    <span className="hint">{m.stage}</span> {m.match_id || ""}
                    <div className="hint" style={{ fontWeight: 400 }}>
                      {m.red.name} vs {m.blue.name}
                    </div>
                  </td>
                  <td className="mono">{g.order}</td>
                  <td className="col-player">
                    <a href={pm?.url ?? beatmapUrl(g.beatmap_id)} target="_blank" rel="noreferrer">
                      {g.label ? `${g.label} · ` : ""}
                      {pm?.title ?? `#${g.beatmap_id}`}
                    </a>
                  </td>
                  <td className="mono">
                    {g.red ? (
                      <>
                        {fmtScore(g.red.score)} <span className="hint">{fmtAcc(g.red.accuracy)}</span>
                        {g.red.beatmap_id !== g.beatmap_id && <span className="hint"> ·b{g.red.beatmap_id}</span>}
                        {!g.red.passed && <span className="badge open"> F</span>}
                      </>
                    ) : (
                      <span className="hint">—</span>
                    )}
                  </td>
                  <td className="mono">
                    {g.blue ? (
                      <>
                        {fmtScore(g.blue.score)} <span className="hint">{fmtAcc(g.blue.accuracy)}</span>
                        {g.blue.beatmap_id !== g.beatmap_id && <span className="hint"> ·b{g.blue.beatmap_id}</span>}
                        {!g.blue.passed && <span className="badge open"> F</span>}
                      </>
                    ) : (
                      <span className="hint">—</span>
                    )}
                  </td>
                  <td className="mono">
                    {g.raw_winner ?? "—"}
                    {g.score_after ? <span className="hint"> ({g.score_after[0]}–{g.score_after[1]})</span> : null}
                  </td>
                  <td>{g.status === "counted" ? <span className="badge live">counted</span> : <span className="badge">excluded</span>}</td>
                  <td className="hint" style={{ whiteSpace: "normal", minWidth: 200 }}>
                    {g.reason ?? ""}
                  </td>
                  <td className="mono">{g.item_id}</td>
                  <td className="mono">
                    <a href={roomUrl(g.room_kind, g.room_id)} target="_blank" rel="noreferrer">
                      {g.room_id}
                    </a>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="hint">
                  Nothing to show.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function NotesView({ result }: { result: PlacementsResult }) {
  const s = result.settings;
  return (
    <div>
      <div className="plc-label" style={{ marginBottom: 6 }}>
        Formula
      </div>
      {result.formula.map((f, i) => (
        <p key={i} className="hint" style={{ margin: "0 0 6px" }}>
          {f}
        </p>
      ))}
      <div className="plc-label" style={{ margin: "14px 0 6px" }}>
        Settings
      </div>
      <p className="hint mono" style={{ margin: 0 }}>
        tiebreak={s.value_mode} · prior_maps={s.prior_maps} · min_plays={s.min_plays} · weighting={s.map_weighting} · lower_multiplier={s.lower_multiplier}{" "}
        (tiebreak only) · count_failed={String(s.count_failed)} ·
        forfeit_lobby_maps={String(s.forfeit_lobby_maps)} · stages={s.stages.length ? s.stages.join(", ") : "all"} · excluded=
        {s.excluded_items.length ? s.excluded_items.join(" ") : "none"} · tab=&ldquo;{s.sheet_tab}&rdquo; · generated {fmtDateTime(result.generated_at)}
      </p>
      <div className="plc-label" style={{ margin: "14px 0 6px" }}>
        Notes ({result.notes.length})
      </div>
      {result.notes.length === 0 && <p className="hint">No notes — every match reconciled cleanly with the sheet.</p>}
      {result.notes.map((n, i) => (
        <div key={i} className="toast" style={{ marginTop: 6 }}>
          {n}
        </div>
      ))}
    </div>
  );
}
