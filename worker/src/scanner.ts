import { config } from "./config.js";
import { feedPageAsc, getMatchDetail, newestMatchId, tokenExpiresAtIso } from "./osu.js";
import * as store from "./store.js";
import type { AppConfig, RollState, RescanState, MatchInfo, Status } from "./types.js";

/**
 * Two fronts share the single 1 req/sec limiter:
 *   - rolling sweep (primary): walks forward but only PROCESSES a match once it
 *     is >= rollDelaySec old, by which point a normal lobby has closed, so one
 *     read returns its full history. Results lag real time by ~rollDelaySec.
 *   - rescan (on demand): walks [from_id .. to_id] against the CURRENT pool.
 * There is no live-edge front and no open-lobby watchlist: closed lobbies are
 * read once and never re-polled, so there is nothing to evict.
 */
export class Scanner {
  private roll!: RollState;

  // rolling sweep in-memory cursors (persisted cursor is source of truth on restart)
  private rollBuffer: MatchInfo[] = [];
  private rollEnumCursor = 0;
  private parked = false;
  private cursorStart: string | null = null; // start_time of the match at the cursor

  // rescan in-memory cursors
  private rescanBuffer: MatchInfo[] = [];
  private rescanEnumCursor = 0;
  private rescanSig = "";

  // telemetry
  private newestSeenId: number | null = null;
  private processedTotal = 0;
  private lastError: string | null = null;
  private lastStatusFlush = 0;
  private lastEdgeProbe = 0;

  async init(): Promise<void> {
    let s = await store.loadRollState();
    if (!s || !s.initialized) {
      const newest = await newestMatchId();
      if (newest === null) throw new Error("could not reach osu! API to seed the rolling cursor");
      this.newestSeenId = newest;
      const cursor = Math.max(0, newest - config.rollSeedLookback);
      s = { cursor, initialized: true, started_at: new Date().toISOString() };
      await store.saveRollState(s);
      console.log(`[init] seeded rolling cursor at ${cursor} (live edge ${newest}, lookback ${config.rollSeedLookback})`);
    } else {
      console.log(`[init] resuming rolling cursor at ${s.cursor}`);
    }
    this.roll = s;
    this.rollEnumCursor = s.cursor;
    this.lastEdgeProbe = 0; // probe the live edge promptly
  }

  // ---- one outer cycle ----
  async cycle(cfg: AppConfig): Promise<boolean> {
    const targets = new Set(cfg.target_beatmap_ids);
    await this.maybeProbeEdge();

    let didWork = await this.rollStep(targets);

    const rescan = await store.loadRescan();
    if (rescan && rescan.status === "running") {
      didWork = (await this.rescanStep(targets, rescan)) || didWork;
    }

    await this.maybeFlush(cfg);
    return didWork;
  }

  // ---- rolling sweep ----
  private async rollStep(targets: Set<number>): Promise<boolean> {
    if (this.rollBuffer.length === 0) {
      const page = await feedPageAsc(this.rollEnumCursor);
      if (page.matches.length === 0) {
        // nothing above the cursor yet — caught up to the live edge
        this.parked = true;
        return false;
      }
      this.rollBuffer = page.matches;
      this.rollEnumCursor = page.nextCursor ?? page.matches[page.matches.length - 1]!.id;
    }

    const now = Date.now();
    const delayMs = config.rollDelaySec * 1000;
    let reads = 0;
    let advanced = false;

    while (reads < config.rollBatch && this.rollBuffer.length > 0) {
      const m = this.rollBuffer[0]!;
      if (m.id <= this.roll.cursor) {
        this.rollBuffer.shift(); // already processed; idempotent safety
        continue;
      }

      // null start_time can't be aged → treat as old enough to process
      const age = m.start_time ? now - Date.parse(m.start_time) : Number.POSITIVE_INFINITY;
      if (Number.isFinite(age) && age < delayMs) {
        // too young — park at the boundary and wait for it to age/close
        this.parked = true;
        return advanced;
      }
      this.parked = false;
      this.rollBuffer.shift();

      const stillOpen = m.end_time === null;
      if (stillOpen && config.rollSkipOpen) {
        // auto-host / freak long-runner: skip entirely (no read), advance past it
        this.roll.cursor = m.id;
        this.cursorStart = m.start_time;
        advanced = true;
        continue;
      }

      await this.processMatch(m, targets, "auto");
      this.roll.cursor = m.id;
      this.cursorStart = m.start_time;
      advanced = true;
      reads++;
    }
    return advanced;
  }

  // ---- on-demand rescan ----
  private async rescanStep(targets: Set<number>, rescan: RescanState): Promise<boolean> {
    const sig = `${rescan.requested_at}:${rescan.from_id}:${rescan.to_id}`;
    if (sig !== this.rescanSig) {
      this.rescanSig = sig;
      this.rescanBuffer = [];
      this.rescanEnumCursor = rescan.cursor;
    }

    if (rescan.from_id > rescan.to_id || rescan.cursor >= rescan.to_id) {
      await this.completeRescan(rescan);
      return false;
    }

    if (this.rescanBuffer.length === 0) {
      const page = await feedPageAsc(this.rescanEnumCursor);
      const inRange = page.matches.filter((m) => m.id <= rescan.to_id);
      const overshot = page.matches.some((m) => m.id > rescan.to_id);
      if (page.matches.length === 0 || (inRange.length === 0 && overshot)) {
        await this.completeRescan(rescan);
        return false;
      }
      this.rescanBuffer = inRange;
      this.rescanEnumCursor = page.nextCursor ?? page.matches[page.matches.length - 1]!.id;
    }

    let processed = 0;
    while (processed < config.rescanBatch && this.rescanBuffer.length > 0) {
      const m = this.rescanBuffer.shift()!;
      if (m.id <= rescan.cursor) continue;
      await this.processMatch(m, targets, "rescan");
      rescan.cursor = m.id;
      rescan.processed++;
      processed++;
      if (rescan.cursor >= rescan.to_id) break;
    }

    if (rescan.cursor >= rescan.to_id) await this.completeRescan(rescan);
    else await store.saveRescan(rescan);
    return processed > 0;
  }

  private async completeRescan(rescan: RescanState): Promise<void> {
    if (rescan.status === "running") {
      rescan.status = "done";
      rescan.finished_at = new Date().toISOString();
      await store.saveRescan(rescan);
      console.log(`[rescan] complete: processed ${rescan.processed} matches`);
    }
    this.rescanBuffer = [];
  }

  // ---- shared per-match work ----
  private async processMatch(m: MatchInfo, targets: Set<number>, source: "auto" | "rescan"): Promise<void> {
    try {
      const detail = await getMatchDetail(m.id);
      const hits = detail.games.filter((g) => targets.has(g.beatmap_id));
      const partial = detail.match.end_time === null; // still open => history may be incomplete
      if (hits.length) await store.upsertHit(detail, hits, source, partial);
      this.processedTotal++;
      this.lastError = null;
    } catch (err) {
      this.lastError = `match ${m.id}: ${(err as Error).message}`;
      console.error("[process]", this.lastError);
    }
  }

  // ---- live-edge probe (cheap, just for telemetry) ----
  private async maybeProbeEdge(): Promise<void> {
    if (Date.now() - this.lastEdgeProbe < config.edgeProbeMs) return;
    this.lastEdgeProbe = Date.now();
    try {
      const n = await newestMatchId();
      if (n !== null && (this.newestSeenId === null || n > this.newestSeenId)) this.newestSeenId = n;
    } catch {
      /* transient; keep the last known edge */
    }
  }

  // ---- status / persistence ----
  isParked(): boolean {
    return this.parked && this.rollBuffer.length === 0;
  }

  private async maybeFlush(cfg?: AppConfig): Promise<void> {
    if (Date.now() - this.lastStatusFlush < config.statusWriteMs) return;
    await this.flush(cfg);
  }

  async flush(cfg?: AppConfig): Promise<void> {
    this.lastStatusFlush = Date.now();
    await store.saveRollState(this.roll);

    const rescan = await store.loadRescan();
    const active = !!rescan && rescan.status === "running";
    const coverage = this.cursorStart ? Math.max(0, Math.round((Date.now() - Date.parse(this.cursorStart)) / 1000)) : null;
    const behind = coverage === null ? null : Math.max(0, coverage - config.rollDelaySec);
    const onSchedule = behind === null ? true : behind <= Math.max(120, config.rollDelaySec * 0.1);
    const hitsTotal = await store.hitsCount();

    const status: Status = {
      updated_at: new Date().toISOString(),
      enabled: cfg?.enabled ?? true,
      pool_size: cfg?.target_beatmap_ids.length ?? 0,
      roll_cursor: this.roll.cursor,
      newest_seen_id: this.newestSeenId,
      cursor_start_time: this.cursorStart,
      coverage_delay_seconds: coverage,
      target_delay_seconds: config.rollDelaySec,
      behind_seconds: behind,
      parked: this.isParked(),
      on_schedule: onSchedule,
      processed_total: this.processedTotal,
      hits_total: hitsTotal,
      token_expires_at: tokenExpiresAtIso(),
      rescan: {
        active,
        status: rescan?.status ?? "idle",
        from_id: rescan?.from_id ?? null,
        to_id: rescan?.to_id ?? null,
        cursor: rescan?.cursor ?? null,
        processed: rescan?.processed ?? 0,
        remaining: rescan && rescan.status === "running" ? Math.max(0, rescan.to_id - rescan.cursor) : 0,
      },
      last_error: this.lastError,
    };
    await store.writeStatus(status);
  }

  async flushPaused(cfg: AppConfig, reason: "paused" | "no_pool"): Promise<void> {
    this.lastError = reason === "no_pool" ? "no target beatmaps configured" : null;
    await this.flush(cfg);
  }
}
