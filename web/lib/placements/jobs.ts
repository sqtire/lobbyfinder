/**
 * One placements job = sheet → pool → lobbies → engine → stored result.
 *
 * Runs inside the web process (Next `next start` is a long-lived node
 * server), one job at a time (Redis lock with a heartbeat), with progress
 * written to Redis so the panel can poll it. If the web service restarts
 * mid-job the lock expires by itself and the job is reported as stalled.
 */

import crypto from "crypto";
import { computePlacements, roomKey } from "./engine";
import { loadBeatmaps, loadRoom } from "./osu";
import { parsePool } from "./pool";
import { fetchScheduleTable, parseScheduleTable, sanitizeTable } from "./schedule";
import { activeJobId, claimActive, getJob, registerJob, releaseActive, saveJob, saveResult, touchActive } from "./store";
import type { BeatmapMeta, JobProgress, PlacementsJob, PlacementsSettings, RoomData } from "./types";
import { DEFAULT_PLACEMENTS_SETTINGS } from "./types";

const STALL_MS = 120_000;
const cancels = (globalThis as unknown as { __plcCancel?: Set<string> }).__plcCancel ?? new Set<string>();
(globalThis as unknown as { __plcCancel?: Set<string> }).__plcCancel = cancels;

export function sanitizeSettings(v: unknown): { ok: true; settings: PlacementsSettings } | { ok: false; error: string } {
  const o = (v ?? {}) as Partial<Record<keyof PlacementsSettings, unknown>>;
  const str = (x: unknown, max = 4000) => (typeof x === "string" ? x.slice(0, max) : "");
  const sheet_url = str(o.sheet_url, 500).trim();
  const schedule_rows = sanitizeTable(o.schedule_rows);
  if (!schedule_rows && !/docs\.google\.com\/spreadsheets\/d\//.test(sheet_url)) return { ok: false, error: "Paste the referee sheet's Google Sheets link, or upload the sheet as .xlsx." };
  const pool_text = str(o.pool_text, 20000);
  if (!pool_text.trim()) return { ok: false, error: "The mappool is empty." };
  const num = (x: unknown, fallback: number, min: number, max: number) => {
    const n = Number(x);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const stages = Array.isArray(o.stages) ? o.stages.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean).slice(0, 50) : [];
  const excluded = Array.isArray(o.excluded_items)
    ? o.excluded_items.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0)
    : str(o.excluded_items as unknown, 4000)
        .split(/[\s,;]+/)
        .map((x) => Number(x))
        .filter((n) => Number.isInteger(n) && n > 0);
  return {
    ok: true,
    settings: {
      title: str(o.title, 120).trim(),
      sheet_url: schedule_rows ? "" : sheet_url,
      sheet_tab: str(o.sheet_tab, 120).trim() || DEFAULT_PLACEMENTS_SETTINGS.sheet_tab,
      schedule_rows,
      schedule_file: schedule_rows ? str(o.schedule_file, 200).trim() || "upload.xlsx" : null,
      pool_text,
      multipliers_text: str(o.multipliers_text, 20000),
      stages,
      prior_maps: num(o.prior_maps, DEFAULT_PLACEMENTS_SETTINGS.prior_maps, 0, 50),
      min_plays: Math.round(num(o.min_plays, DEFAULT_PLACEMENTS_SETTINGS.min_plays, 2, 100)),
      value_mode: o.value_mode === "z" ? "z" : o.value_mode === "zipf" ? "zipf" : "phi",
      map_weighting: o.map_weighting === "per_map" ? "per_map" : "per_play",
      count_failed: o.count_failed === undefined ? true : !!o.count_failed,
      forfeit_lobby_maps: o.forfeit_lobby_maps === undefined ? true : !!o.forfeit_lobby_maps,
      excluded_items: [...new Set(excluded)].slice(0, 500),
      hidden_players: str(o.hidden_players, 4000),
      lower_multiplier: num(o.lower_multiplier, DEFAULT_PLACEMENTS_SETTINGS.lower_multiplier, 0.5, 1.5),
    },
  };
}

export async function startJob(settings: PlacementsSettings, requestedBy: number | null): Promise<{ ok: true; job: PlacementsJob } | { ok: false; error: string; active?: string }> {
  const id = crypto.randomBytes(6).toString("hex");
  const holder = await claimActive(id);
  if (holder) {
    const other = await getJob(holder);
    const stalled = !other || other.status !== "running" || !other.heartbeat_at || Date.now() - Date.parse(other.heartbeat_at) > STALL_MS;
    if (!stalled) return { ok: false, error: `Another run (${other?.title || holder}) is in progress — wait for it to finish.`, active: holder };
    await releaseActive(holder);
    const again = await claimActive(id);
    if (again) return { ok: false, error: "Another run just started — try again in a moment.", active: again };
  }
  const now = new Date().toISOString();
  const job: PlacementsJob = {
    id,
    status: "queued",
    title: settings.title || settings.sheet_tab,
    requested_by: requestedBy,
    created_at: now,
    started_at: null,
    finished_at: null,
    heartbeat_at: now,
    progress: { phase: "queued", done: 0, total: 0, message: "Starting…" },
    settings,
    error: null,
    has_result: false,
  };
  await saveJob(job);
  await registerJob(id);
  void run(job).catch((e) => console.error("[placements] job crashed", e));
  return { ok: true, job };
}

export async function cancelJob(id: string): Promise<boolean> {
  const job = await getJob(id);
  if (!job || (job.status !== "running" && job.status !== "queued")) return false;
  cancels.add(id);
  return true;
}

export async function isRunning(): Promise<string | null> {
  return activeJobId();
}

class Cancelled extends Error {}

async function run(job: PlacementsJob): Promise<void> {
  const s = job.settings;
  const setProgress = async (p: Partial<JobProgress>) => {
    if (cancels.has(job.id)) throw new Cancelled("cancelled");
    job.progress = { ...job.progress, ...p };
    job.heartbeat_at = new Date().toISOString();
    await saveJob(job);
    await touchActive(job.id);
  };
  try {
    job.status = "running";
    job.started_at = new Date().toISOString();
    await setProgress({ phase: "sheet", done: 0, total: 0, message: `Reading “${s.sheet_tab}”…` });

    const table = s.schedule_rows ?? (await fetchScheduleTable(s.sheet_url, s.sheet_tab));
    const schedule = parseScheduleTable(table);
    const poolParse = parsePool(s.pool_text);
    if (poolParse.maps.length === 0) throw new Error("The mappool has no maps.");

    const wanted = s.stages.length ? new Set(s.stages.map((x) => x.toLowerCase())) : null;
    const rows = schedule.rows.filter((r) => !wanted || wanted.has(r.stage.toLowerCase()));
    if (rows.length === 0) throw new Error(wanted ? "No matches in the selected stages." : "No matches found in the sheet.");

    // unique lobbies, in sheet order
    const refs = new Map<string, (typeof rows)[number]["rooms"][number]>();
    for (const r of rows) if (r.outcome !== "unplayed" || r.rooms.length) for (const ref of r.rooms) refs.set(roomKey(ref), ref);
    const rooms = new Map<string, RoomData>();
    const roomErrors = new Map<string, string>();
    let i = 0;
    let fetched = 0;
    await setProgress({ phase: "rooms", done: 0, total: refs.size, message: `Reading ${refs.size} lobbies…` });
    for (const [key, ref] of refs) {
      i++;
      try {
        const { room, cached } = await loadRoom(ref.kind, ref.id);
        rooms.set(key, room);
        if (!cached) fetched++;
        await setProgress({ done: i, message: `${cached ? "Cached" : "Read"} ${ref.kind === "lazer" ? "room" : "match"} ${ref.id} (${i}/${refs.size}${fetched ? `, ${fetched} from the API` : ""})` });
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        roomErrors.set(key, (e as Error).message);
        await setProgress({ done: i, message: `Could not read ${ref.url}: ${(e as Error).message}` });
      }
    }

    // metadata for pool maps no lobby told us about
    const known = new Set<number>();
    for (const room of rooms.values()) for (const m of Object.values(room.beatmaps)) known.add(m.id);
    const missing = poolParse.maps.map((m) => m.beatmap_id).filter((id) => !known.has(id));
    let beatmaps = new Map<number, BeatmapMeta>();
    if (missing.length) {
      await setProgress({ phase: "beatmaps", done: 0, total: missing.length, message: `Looking up ${missing.length} pool map(s)…` });
      beatmaps = await loadBeatmaps(missing);
    }

    await setProgress({ phase: "compute", message: "Computing placements…" });
    const result = computePlacements({ settings: s, schedule: schedule.rows, pool: poolParse.maps, rooms, roomErrors, beatmaps });
    result.notes = [...schedule.warnings, ...poolParse.warnings, ...result.notes];
    await saveResult(job.id, result);

    job.status = "done";
    job.has_result = true;
    job.finished_at = new Date().toISOString();
    job.progress = { phase: "done", done: refs.size, total: refs.size, message: `${result.counts.matches} matches, ${result.counts.games_counted} counted maps, ${result.counts.players} players.` };
    await saveJob(job);
  } catch (e) {
    job.status = e instanceof Cancelled ? "cancelled" : "error";
    job.error = e instanceof Cancelled ? null : (e as Error).message || String(e);
    job.finished_at = new Date().toISOString();
    job.progress = { ...job.progress, message: e instanceof Cancelled ? "Cancelled." : `Failed: ${job.error}` };
    await saveJob(job);
  } finally {
    cancels.delete(job.id);
    await releaseActive(job.id);
  }
}
