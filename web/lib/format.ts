export function fmtDur(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) return "—";
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (s < 3600) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(s / 3600);
  if (s < 86400) return `${h}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  const d = Math.floor(s / 86400);
  return `${d}d ${Math.floor((s % 86400) / 3600)}h`;
}

export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const secs = (Date.now() - t) / 1000;
  if (secs < 5) return "just now";
  return `${fmtDur(secs)} ago`;
}

export function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
