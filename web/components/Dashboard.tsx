"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DataResponse, Status } from "@/lib/types";
import { fmtDur, fmtNum, fmtAgo } from "@/lib/format";
import ControlPanel from "./ControlPanel";
import ResultsList from "./ResultsList";

const POLL_MS = 10000;
const LAG_CAP = 3600; // matches behind at which the catch-up gauge reads empty

export default function Dashboard() {
  const [data, setData] = useState<DataResponse | null>(null);
  const [errored, setErrored] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const inFlight = useRef(false);

  const refetch = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch("/api/data", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as DataResponse);
      setErrored(false);
    } catch {
      setErrored(true);
    } finally {
      inFlight.current = false;
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

  const status = data?.status ?? null;
  const config = data?.config ?? { target_beatmap_ids: [], enabled: false, updated_at: "" };
  const authed = data?.authed ?? false;
  const pill = derivePill(data, errored);

  return (
    <main className="wrap">
      <div className="head">
        <div>
          <h1 className="title">
            MP <span className="accent">Pool</span> Scanner
          </h1>
          <div className="subtitle">
            Watches every osu! multiplayer lobby for maps in your pool · one scan front live, one for rescans · ~1
            request/sec
          </div>
        </div>
        <span className="pill">
          <span className={`dot ${pill.dot}`} />
          {pill.label}
        </span>
      </div>

      <HealthPanel status={status} config={config} clock={clock} errored={errored} />

      <ControlPanel authed={authed} config={config} status={status} onChanged={refetch} />

      <section className="panel">
        <div className="results-head">
          <h2 style={{ margin: 0 }}>Results</h2>
          <span className="hint mono">
            {fmtNum(status?.hits_total ?? data?.hits.length ?? 0)} lobbies
            {data && data.hits.length >= 200 ? " · showing newest 200" : ""}
          </span>
        </div>
        <ResultsList hits={data?.hits ?? []} />
      </section>

      <div className="footer">
        Uses beatmap (difficulty) IDs · match-feed scanning is visible tournament scouting · data updates every{" "}
        {POLL_MS / 1000}s
      </div>
    </main>
  );
}

function HealthPanel({
  status,
  config,
  clock,
  errored,
}: {
  status: Status | null;
  config: { enabled: boolean; target_beatmap_ids: number[] };
  clock: number;
  errored: boolean;
}) {
  const running = config.enabled && config.target_beatmap_ids.length > 0;

  // catch-up gauge: how close the live front is to the newest match it has seen
  const watermark = status?.live_watermark ?? 0;
  const newest = status?.newest_seen_id ?? watermark;
  const behind = Math.max(0, newest - watermark);
  const fill = status?.caught_up ? 100 : Math.max(2, Math.round(100 * (1 - Math.min(1, behind / LAG_CAP))));

  // live lag ticks up between polls while running (the last processed match keeps aging)
  let lagSeconds: number | null = null;
  if (running && status && status.lag_seconds != null) {
    const since = Math.max(0, (clock - Date.parse(status.updated_at)) / 1000);
    lagSeconds = status.lag_seconds + (Number.isFinite(since) ? since : 0);
  }
  const lagClass = lagSeconds == null ? "" : lagSeconds < 90 ? "ok" : "warn";

  const rescan = status?.rescan;
  const rescanActive = rescan?.active ?? false;
  const rescanPct =
    rescanActive && rescan && rescan.to_id && rescan.from_id != null && rescan.cursor != null && rescan.to_id > rescan.from_id
      ? Math.max(0, Math.min(100, Math.round((100 * (rescan.cursor - rescan.from_id)) / (rescan.to_id - rescan.from_id))))
      : 0;

  return (
    <section className="panel">
      <h2>Scanner health</h2>

      <div className="lag-line">
        <span className={`lag-num ${lagClass}`}>{running ? fmtDur(lagSeconds) : "paused"}</span>
        <span className="lag-cap">
          {running
            ? status?.caught_up
              ? "at the live edge · last match this long ago"
              : `behind the live edge · last processed match this long ago`
            : config.target_beatmap_ids.length === 0
              ? "no beatmap pool set"
              : "scanner stopped"}
        </span>
      </div>

      <div className="gauge-track">
        <div className="gauge-fill" style={{ width: `${fill}%` }} />
        <div className="gauge-head" style={{ left: `calc(${fill}% - 1px)` }} />
      </div>
      <div className="gauge-labels">
        <span>{status?.caught_up ? "caught up" : `${fmtNum(behind)} matches behind`}</span>
        <span>live edge →</span>
      </div>

      {rescanActive && (
        <div style={{ marginTop: 14 }}>
          <div className="gauge-track rescan">
            <div className="gauge-fill" style={{ width: `${rescanPct}%` }} />
          </div>
          <div className="gauge-labels">
            <span>
              rescan #{fmtNum(rescan?.from_id)} → #{fmtNum(rescan?.to_id)}
            </span>
            <span>
              {rescanPct}% · ~{fmtNum(rescan?.remaining)} left
            </span>
          </div>
        </div>
      )}

      <div className="stats">
        <Stat k="Live watermark" v={status ? `#${fmtNum(status.live_watermark)}` : "—"} />
        <Stat k="Newest seen" v={status?.newest_seen_id ? `#${fmtNum(status.newest_seen_id)}` : "—"} />
        <Stat k="Pool size" v={fmtNum(config.target_beatmap_ids.length)} />
        <Stat k="Processed" v={fmtNum(status?.processed_total)} />
        <Stat k="Hits" v={fmtNum(status?.hits_total)} />
        <Stat k="Open watched" v={fmtNum(status?.open_watched)} />
        <Stat k="Updated" v={errored ? "stale" : fmtAgo(status?.updated_at)} />
        <Stat k="Token renews" v={fmtAgo(status?.token_expires_at).replace(" ago", "")} />
      </div>

      {status?.last_error && (
        <div className="toast err" style={{ marginTop: 12 }}>
          last error — {status.last_error}
        </div>
      )}
    </section>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  );
}

function derivePill(data: DataResponse | null, errored: boolean): { dot: string; label: string } {
  if (errored && !data) return { dot: "err", label: "Connection lost" };
  if (!data || !data.status) return { dot: "paused", label: "Connecting…" };
  if (!data.config.enabled) return { dot: "paused", label: "Stopped" };
  if (data.config.target_beatmap_ids.length === 0) return { dot: "paused", label: "No pool set" };
  if (data.status.caught_up) return { dot: "live", label: "Live · caught up" };
  return { dot: "lag", label: "Live · catching up" };
}
