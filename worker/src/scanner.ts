import { config } from "./config.js";
import { feedPageAsc, getMatchDetail, newestMatchId, tokenExpiresAtIso } from "./osu.js";
import * as store from "./store.js";
import type { AppConfig, LiveState, RescanState, MatchInfo, MatchGame, Status } from "./types.js";

/**
 * Two scan fronts run in one process and share the single 1 req/sec limiter:
 *   - live:   always walks forward toward the newest match (never rewound)
 *   - rescan: on demand, walks [from_id .. to_id] against the CURRENT pool
 * Plus a periodic re-check of still-open lobbies (maps are played after a lobby
 * opens). Equal LIVE_BATCH / RESCAN_BATCH => ~50/50 of processed matches.
 */
export class Scanner {
  private live!: LiveState;

  // in-memory live cursors (persisted watermark is the source of truth on restart)
  private liveBuffer: MatchInfo[] = [];
  private liveEnumCursor = 0;
  private liveCaughtUp = false;
  private lastLiveStart: string | null = null;

  // in-memory rescan cursors
  private rescanBuffer: MatchInfo[] = [];
  private rescanEnumCursor = 0;
  private rescanSig = ""; // detects a freshly-requested rescan

  // telemetry
  private newestSeenId: number | null = null;
  private processedTotal = 0;
  private lastError: string | null = null;
  private lastStatusFlush = 0;
  private lastWatchCheck = 0;

  async init(): Promise<void> {
    let s = await store.loadLiveState();
    if (!s || !s.initialized) {
      const newest = await newestMatchId();
      const watermark = newest ?? 0;
      s = { watermark, initialized: newest !== null, started_at: new Date().toISOString() };
      await store.saveLiveState(s);
      console.log(`[init] live watermark seeded at ${watermark}`);
    } else {
      console.log(`[init] resuming live watermark at ${s.watermark}`);
    }
    this.live = s;
    this.liveEnumCursor = s.watermark;
    if (s.watermark > 0) this.newestSeenId = s.watermark;
  }

  // ---- one outer cycle ----
  async cycle(cfg: AppConfig): Promise<boolean> {
    const targets = new Set(cfg.target_beatmap_ids);
    let didWork = false;

    if (this.watchDueNow()) {
      this.lastWatchCheck = Date.now();
      didWork = (await this.watchStep(targets)) || didWork;
    }

    didWork = (await this.liveStep(targets)) || didWork;

    const rescan = await store.loadRescan();
    if (rescan && rescan.status === "running") {
      didWork = (await this.rescanStep(targets, rescan)) || didWork;
    }

    await this.maybeFlush(cfg);
    return didWork;
  }

  // ---- live front ----
  private async liveStep(targets: Set<number>): Promise<boolean> {
    if (this.liveBuffer.length === 0) {
      const page = await feedPageAsc(this.liveEnumCursor);
      this.trackNewest(page.matches);
      if (page.matches.length === 0) {
        this.liveCaughtUp = true;
        return false;
      }
      this.liveCaughtUp = false;
      this.liveBuffer = page.matches;
      this.liveEnumCursor = page.nextCursor ?? page.matches[page.matches.length - 1]!.id;
    }

    let processed = 0;
    while (processed < config.liveBatch && this.liveBuffer.length > 0) {
      const m = this.liveBuffer.shift()!;
      // ids must move strictly forward past the watermark
      if (m.id <= this.live.watermark) continue;
      await this.processMatch(m, targets, "live");
      this.live.watermark = m.id;
      this.lastLiveStart = m.start_time;
      processed++;
    }
    return processed > 0;
  }

  // ---- rescan front ----
  private async rescanStep(targets: Set<number>, rescan: RescanState): Promise<boolean> {
    const sig = `${rescan.requested_at}:${rescan.from_id}:${rescan.to_id}`;
    if (sig !== this.rescanSig) {
      // a new rescan was requested → reset in-memory walk
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
      this.trackNewest(page.matches);
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

  // ---- open-lobby re-check ----
  private watchDueNow(): boolean {
    return config.watchOpenMatches && Date.now() - this.lastWatchCheck >= config.watchRecheckEverySec * 1000;
  }
  private async watchStep(targets: Set<number>): Promise<boolean> {
    const due = await store.watchDue();
    const batch = due.slice(0, config.watchBatch);
    for (const id of batch) {
      const detail = await getMatchDetail(id);
      const hits = detail.games.filter((g) => targets.has(g.beatmap_id));
      if (hits.length) await store.upsertHit(detail, hits, "live");
      if (detail.match.end_time !== null) await store.watchRemove(id); // closed → stop watching
      this.processedTotal++;
    }
    return batch.length > 0;
  }

  // ---- shared per-match work ----
  private async processMatch(m: MatchInfo, targets: Set<number>, source: "live" | "rescan"): Promise<void> {
    try {
      const detail = await getMatchDetail(m.id);
      const hits: MatchGame[] = detail.games.filter((g) => targets.has(g.beatmap_id));
      if (hits.length) await store.upsertHit(detail, hits, source);
      if (source === "live" && detail.match.end_time === null) await store.watchAdd(m.id);
      this.processedTotal++;
      this.lastError = null;
    } catch (err) {
      this.lastError = `match ${m.id}: ${(err as Error).message}`;
      console.error("[process]", this.lastError);
    }
  }

  private trackNewest(matches: MatchInfo[]): void {
    for (const m of matches) if (this.newestSeenId === null || m.id > this.newestSeenId) this.newestSeenId = m.id;
  }

  // ---- status / persistence ----
  isLiveIdle(): boolean {
    return this.liveCaughtUp && this.liveBuffer.length === 0;
  }

  private async maybeFlush(cfg?: AppConfig): Promise<void> {
    if (Date.now() - this.lastStatusFlush < config.statusWriteMs) return;
    await this.flush(cfg);
  }

  async flush(cfg?: AppConfig): Promise<void> {
    this.lastStatusFlush = Date.now();
    await store.saveLiveState(this.live);

    const rescan = await store.loadRescan();
    const active = !!rescan && rescan.status === "running";
    const lagSeconds = this.lastLiveStart ? Math.max(0, Math.round((Date.now() - Date.parse(this.lastLiveStart)) / 1000)) : null;
    const [hitsTotal, openWatched] = await Promise.all([store.hitsCount(), store.watchCount()]);

    const status: Status = {
      updated_at: new Date().toISOString(),
      enabled: cfg?.enabled ?? true,
      pool_size: cfg?.target_beatmap_ids.length ?? 0,
      live_watermark: this.live.watermark,
      newest_seen_id: this.newestSeenId,
      last_processed_start_time: this.lastLiveStart,
      lag_seconds: lagSeconds,
      caught_up: this.isLiveIdle(),
      processed_total: this.processedTotal,
      hits_total: hitsTotal,
      open_watched: openWatched,
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

  /** Write a status snapshot reflecting a paused/idle worker. */
  async flushPaused(cfg: AppConfig, reason: "paused" | "no_pool"): Promise<void> {
    this.lastError = reason === "no_pool" ? "no target beatmaps configured" : null;
    await this.flush(cfg);
  }
}
