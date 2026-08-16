"use client";

import type { Status } from "@/lib/types";
import { fmtAgo, fmtDur, fmtNum } from "@/lib/format";

/**
 * Global scanner health. The sweep, index, walks and backfill queue are shared by
 * every tournament, so this reads the same for everyone.
 */
export default function HealthPanel({
  status,
  clock,
  errored,
  compact = false,
}: {
  status: Status | null;
  clock: number;
  errored: boolean;
  compact?: boolean;
}) {
  const running = status?.enabled ?? false;
  const target = status?.target_delay_seconds ?? 4 * 3600;

  // coverage delay = age of the lobby at the cursor; ticks up between polls while parked
  let coverage: number | null = null;
  if (running && status && status.coverage_delay_seconds != null) {
    const since = Math.max(0, (clock - Date.parse(status.updated_at)) / 1000);
    coverage = status.coverage_delay_seconds + (Number.isFinite(since) ? since : 0);
  }
  const behind = coverage == null ? null : Math.max(0, coverage - target);
  const onSchedule = running && (status?.on_schedule ?? false) && (behind == null || behind <= Math.max(120, target * 0.1));
  const fill = !running ? 0 : onSchedule ? 100 : behind == null ? 100 : Math.max(3, Math.round(100 * (1 - Math.min(1, behind / target))));
  const headline = !running ? "paused" : onSchedule ? "on schedule" : `behind ${fmtDur(behind)}`;
  const headClass = !running ? "" : onSchedule ? "ok" : "warn";

  const walk = status?.walk;
  const walkActive = walk?.active ?? false;
  const walkPct =
    walkActive && walk && walk.to_id && walk.from_id != null && walk.cursor != null && walk.to_id > walk.from_id
      ? Math.max(0, Math.min(100, Math.round((100 * (walk.cursor - walk.from_id)) / (walk.to_id - walk.from_id))))
      : 0;
  const idx = status?.index;

  return (
    <section className="panel">
      <h2>Scanner health</h2>

      <div className="lag-line">
        <span className={`lag-num ${headClass}`}>{headline}</span>
        <span className="lag-cap">
          {running
            ? onSchedule
              ? `reading lobbies ~${fmtDur(coverage)} old (target ~${fmtDur(target)}) · keeping up`
              : `working through a backlog · processing lobbies ~${fmtDur(coverage)} old`
            : "scanner paused by the site owner"}
        </span>
      </div>

      <div className="gauge-track">
        <div className="gauge-fill" style={{ width: `${fill}%` }} />
        <div className="gauge-head" style={{ left: `calc(${fill}% - 1px)` }} />
      </div>
      <div className="gauge-labels">
        <span>{running ? `coverage delay ~${fmtDur(coverage)}` : "—"}</span>
        <span>target ~{fmtDur(target)} →</span>
      </div>

      {walkActive && (
        <div style={{ marginTop: 14 }}>
          <div className="gauge-track rescan">
            <div className="gauge-fill" style={{ width: `${walkPct}%` }} />
          </div>
          <div className="gauge-labels">
            <span>
              admin rescan #{fmtNum(walk?.from_id)} → #{fmtNum(walk?.to_id)}
            </span>
            <span>
              {walkPct}% · ~{fmtNum(walk?.remaining)} left
            </span>
          </div>
        </div>
      )}

      <div className="stats">
        <Stat k="Cursor" v={status ? `#${fmtNum(status.roll_cursor)}` : "—"} />
        <Stat k="Live edge" v={status?.newest_seen_id ? `#${fmtNum(status.newest_seen_id)}` : "—"} />
        <Stat k="Coverage delay" v={running ? fmtDur(coverage) : "—"} />
        <Stat k="Index" v={idx ? `${fmtNum(idx.matches)} lobbies · ${idx.days}d` : "—"} />
        <Stat k="History from" v={idx?.oldest_day ?? "—"} />
        {!compact && <Stat k="Tournaments" v={status ? `${fmtNum(status.tenants_enabled)} / ${fmtNum(status.tenants_total)} live` : "—"} />}
        {!compact && <Stat k="Union pool" v={fmtNum(status?.union_pool_size)} />}
        {!compact && <Stat k="Stored lobbies" v={fmtNum(status?.hits_total)} />}
        <Stat k="Backfills" v={status ? `${status.backfill.active_slug ? "1 running" : "idle"}${status.backfill.queued ? ` · ${status.backfill.queued} queued` : ""}` : "—"} />
        <Stat k="Updated" v={errored ? "stale" : fmtAgo(status?.updated_at)} />
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

export function derivePill(status: Status | null, errored: boolean, hasData: boolean): { dot: string; label: string } {
  if (errored && !hasData) return { dot: "err", label: "Connection lost" };
  if (!status) return { dot: "paused", label: "Connecting…" };
  if (!status.enabled) return { dot: "paused", label: "Paused" };
  if (status.on_schedule) return { dot: "live", label: "Rolling · on schedule" };
  return { dot: "lag", label: "Rolling · behind" };
}
