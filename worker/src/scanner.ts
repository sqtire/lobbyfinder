import { config } from "./config.js";
import { feedPageAsc, getMatchDetail, newestMatchId, tokenExpiresAtIso } from "./osu.js";
import * as store from "./store.js";
import type { BackfillState, GlobalConfig, MatchDetail, MatchInfo, RollState, Status, Tenant, WalkState } from "./types.js";

/**
 * Three fronts share the single 1 req/sec limiter, in priority order:
 *   1. rolling sweep (always first): walks forward, PROCESSES a match once it
 *      is >= rollDelaySec old (closed by then), writes it to the match index,
 *      and stores full detail for lobbies that hit ANY enabled tenant's pool.
 *      Runs regardless of how many tenants exist — the index is the product.
 *   2. tenant backfill (background): scans the index for a tenant's pool over a
 *      day range (no API), links already-stored hits (no API), and reads only
 *      the lobbies nobody has stored yet (1 read each).
 *   3. owner walk (background): re-reads a raw match-id range into the index —
 *      the only operation that costs a request per osu! match. Owner-only.
 * Background fronts get a batch sized by the sweep's health so the sweep never
 * falls behind because of them.
 */
export class Scanner {
  private roll!: RollState;

  // rolling sweep in-memory cursors (persisted cursor is source of truth on restart)
  private rollBuffer: MatchInfo[] = [];
  private rollEnumCursor = 0;
  private parked = false;
  private cursorStart: string | null = null; // start_time of the match at the cursor

  // walk in-memory cursors
  private walkBuffer: MatchInfo[] = [];
  private walkEnumCursor = 0;
  private walkSig = "";
  private activeWalk: WalkState | null = null;

  // tenants
  private tenants: Tenant[] = [];
  private poolIndex = new Map<number, string[]>(); // beatmap_id -> enabled tenant slugs
  private global: GlobalConfig = { enabled: true, updated_at: new Date(0).toISOString() };

  // telemetry
  private newestSeenId: number | null = null;
  private processedTotal = 0;
  private lastError: string | null = null;
  private lastStatusFlush = 0;
  private lastEdgeProbe = 0;
  private lastPrune = 0;
  private lastBackfillStatus: { slug: string | null; state: BackfillState | null } = { slug: null, state: null };

  async init(): Promise<void> {
    await store.loadIndexMeta();
    let s = await store.loadRollState();
    if (!s || !s.initialized) {
      const newest = await newestMatchId();
      if (newest === null) throw new Error("could not reach osu! API to seed the rolling cursor");
      this.newestSeenId = newest;
      const cursor = Math.max(0, newest - config.rollSeedLookback);
      s = { cursor, initialized: true, started_at: new Date().toISOString(), index_from: cursor + 1, cursor_start: null };
      await store.saveRollState(s);
      console.log(`[init] seeded rolling cursor at ${cursor} (live edge ${newest}, lookback ${config.rollSeedLookback})`);
    } else {
      if (s.index_from === null) {
        s.index_from = s.cursor + 1; // indexing starts with the next match this worker reads
        await store.saveRollState(s);
      }
      console.log(`[init] resuming rolling cursor at ${s.cursor} (index from ${s.index_from})`);
    }
    this.roll = s;
    this.rollEnumCursor = s.cursor;
    this.cursorStart = s.cursor_start;
    this.lastEdgeProbe = 0; // probe the live edge promptly
  }

  setTenants(tenants: Tenant[], global: GlobalConfig): void {
    this.tenants = tenants;
    this.global = global;
    const idx = new Map<number, string[]>();
    for (const t of tenants) {
      if (!t.enabled) continue;
      for (const b of t.pool) {
        const arr = idx.get(b);
        if (arr) arr.push(t.slug);
        else idx.set(b, [t.slug]);
      }
    }
    this.poolIndex = idx;
  }

  // ---- one outer cycle ----
  async cycle(): Promise<boolean> {
    await this.maybeProbeEdge();

    let didWork = await this.rollStep();

    const budget = this.bgBudget();
    let used = 0;
    try {
      used += await this.backfillStep(budget);
    } catch (e) {
      this.lastError = `backfill: ${(e as Error).message}`;
      console.error("[backfill]", this.lastError);
    }
    if (used < budget) {
      try {
        used += await this.walkStep(budget - used);
      } catch (e) {
        this.lastError = `walk: ${(e as Error).message}`;
        console.error("[walk]", this.lastError);
      }
    }
    didWork = didWork || used > 0;

    await this.maybePrune();
    await this.maybeFlush();
    return didWork;
  }

  /** How many background reads this cycle may spend, given the sweep's health. */
  private bgBudget(): number {
    if (this.isParked()) return config.bgBatchParked;
    const behind = this.behindSeconds();
    if (behind === null || behind <= Math.max(120, config.rollDelaySec * 0.1)) return config.bgBatchOnSchedule;
    return config.bgBatchBehind;
  }

  private behindSeconds(): number | null {
    if (!this.cursorStart) return null;
    const coverage = Math.max(0, Math.round((Date.now() - Date.parse(this.cursorStart)) / 1000));
    return Math.max(0, coverage - config.rollDelaySec);
  }

  // ---- rolling sweep ----
  private async rollStep(): Promise<boolean> {
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

      await this.processMatch(m, "auto");
      this.roll.cursor = m.id;
      this.cursorStart = m.start_time;
      advanced = true;
      reads++;
    }
    return advanced;
  }

  // ---- owner walks (queued, background) ----
  private async walkStep(budget: number): Promise<number> {
    if (budget <= 0) return 0;
    let walk = await store.loadWalk();
    if (!walk || walk.status !== "running") {
      walk = await store.popNextWalk();
      if (!walk) {
        this.activeWalk = null;
        return 0;
      }
      console.log(`[walk] starting ${walk.id}: #${walk.from_id} → #${walk.to_id}`);
    }
    this.activeWalk = walk;

    const sig = `${walk.id}:${walk.from_id}:${walk.to_id}`;
    if (sig !== this.walkSig) {
      this.walkSig = sig;
      this.walkBuffer = [];
      this.walkEnumCursor = walk.cursor;
    }

    if (walk.from_id > walk.to_id || walk.cursor >= walk.to_id) {
      await this.completeWalk(walk);
      return 0;
    }

    if (this.walkBuffer.length === 0) {
      const page = await feedPageAsc(this.walkEnumCursor);
      const inRange = page.matches.filter((m) => m.id <= walk!.to_id);
      const overshot = page.matches.some((m) => m.id > walk!.to_id);
      if (page.matches.length === 0 || (inRange.length === 0 && overshot)) {
        await this.completeWalk(walk);
        return 1;
      }
      this.walkBuffer = inRange;
      this.walkEnumCursor = page.nextCursor ?? page.matches[page.matches.length - 1]!.id;
    }

    let processed = 0;
    while (processed < budget && this.walkBuffer.length > 0) {
      const m = this.walkBuffer.shift()!;
      if (m.id <= walk.cursor) continue;
      await this.processMatch(m, "walk");
      walk.cursor = m.id;
      walk.processed++;
      processed++;
      if (walk.cursor >= walk.to_id) break;
    }

    if (walk.cursor >= walk.to_id) await this.completeWalk(walk);
    else await store.saveWalk(walk);
    return processed;
  }

  private async completeWalk(walk: WalkState): Promise<void> {
    if (walk.status === "running") {
      walk.status = "done";
      walk.finished_at = new Date().toISOString();
      await store.saveWalk(walk);
      console.log(`[walk] complete ${walk.id}: processed ${walk.processed} matches`);
    }
    if (walk.cursor >= walk.from_id) store.addCoverage(walk.from_id, walk.cursor);
    this.walkBuffer = [];
    this.activeWalk = null;
  }

  // ---- tenant backfills (queued, background) ----
  private async backfillStep(budget: number): Promise<number> {
    let slug = await store.loadBackfillActive();
    if (!slug) {
      slug = await store.popNextBackfill();
      if (!slug) {
        this.lastBackfillStatus = { slug: null, state: null };
        return 0;
      }
      await store.setBackfillActive(slug);
    }
    const state = await store.loadBackfill(slug);
    if (!state || state.status === "done" || state.status === "cancelled" || state.status === "error") {
      await store.clearPending(slug);
      await store.setBackfillActive(null);
      this.lastBackfillStatus = { slug: null, state: null };
      return 0;
    }
    this.lastBackfillStatus = { slug, state };

    const tenant = this.tenants.find((t) => t.slug === slug) ?? (await store.loadTenant(slug));
    if (!tenant) {
      state.status = "error";
      state.error = "tournament no longer exists";
      state.finished_at = new Date().toISOString();
      await store.saveBackfill(slug, state);
      await store.clearPending(slug);
      await store.setBackfillActive(null);
      return 0;
    }

    if (state.status === "queued") {
      state.status = "scanning";
      state.started_at = new Date().toISOString();
      await store.saveBackfill(slug, state);
      await this.scanForBackfill(slug, tenant, state);
      return 0; // no API spent; walk may use this cycle's budget
    }

    // fetching
    let used = 0;
    while (used < budget) {
      const id = await store.popPending(slug);
      if (id === null) {
        state.status = "done";
        state.finished_at = new Date().toISOString();
        await store.saveBackfill(slug, state);
        await store.setBackfillActive(null);
        console.log(`[backfill] ${slug} done: ${state.linked} linked, ${state.fetched} fetched, ${state.tombstoned} tombstoned`);
        break;
      }
      used++;
      try {
        const detail = await getMatchDetail(id);
        await this.ingest(detail, "backfill", slug);
        this.processedTotal++;
        this.lastError = null;
      } catch (err) {
        this.lastError = `backfill ${slug} match ${id}: ${(err as Error).message}`;
        console.error("[backfill]", this.lastError);
      }
      state.fetched++;
      await store.saveBackfill(slug, state);
    }
    return used;
  }

  private async scanForBackfill(slug: string, tenant: Tenant, state: BackfillState): Promise<void> {
    const pool = new Set(tenant.pool);
    const pendingFrom = this.cursorStart ? store.dayOf(this.cursorStart) : null;
    const { candidates, uncovered } = await store.scanIndex(state.from_day, state.to_day, pool, pendingFrom);
    const toFetch: number[] = [];
    let linked = 0;
    let tombstoned = 0;
    for (const c of candidates) {
      const hit = await store.getHit(c.match_id);
      if (hit && hit.all_games && !hit.partial) {
        if (await store.linkHitToTenant(slug, c.match_id, hit.start_time)) linked++;
        else tombstoned++;
        continue;
      }
      // needs a detail read (never stored, legacy pool-filtered record, or read while still open)
      if (await store.isHidden(slug, c.match_id)) {
        tombstoned++;
        continue;
      }
      toFetch.push(c.match_id);
    }
    state.candidates = candidates.length;
    state.linked = linked;
    state.tombstoned = tombstoned;
    state.to_fetch = toFetch.length;
    state.uncovered_days = uncovered;
    if (uncovered.length) {
      await store.setCoverageRequest(slug, {
        from_day: state.from_day,
        to_day: state.to_day,
        uncovered_days: uncovered,
        at: new Date().toISOString(),
      });
    }
    await store.pushPending(slug, toFetch);
    state.status = "fetching"; // the fetch loop finishes immediately when nothing is pending
    await store.saveBackfill(slug, state);
    console.log(
      `[backfill] ${slug} scanned ${state.from_day}..${state.to_day}: ${candidates.length} candidates, ${linked} linked, ${toFetch.length} to fetch, ${uncovered.length} uncovered days`
    );
  }

  // ---- shared per-match work ----
  private async processMatch(m: MatchInfo, source: "auto" | "walk"): Promise<void> {
    try {
      const detail = await getMatchDetail(m.id);
      await this.ingest(detail, source, null);
      this.processedTotal++;
      this.lastError = null;
    } catch (err) {
      this.lastError = `match ${m.id}: ${(err as Error).message}`;
      console.error("[process]", this.lastError);
    }
  }

  /**
   * Index the match; if any enabled tenant's pool (or the requesting tenant of a
   * backfill) intersects it, store the full detail once and reference it from
   * each of those tenants (their tombstones are honored inside the link).
   */
  private async ingest(detail: MatchDetail, source: "auto" | "walk" | "backfill", extraSlug: string | null): Promise<void> {
    await store.indexMatch(detail);
    const slugs = new Set<string>();
    for (const g of detail.games) {
      const owners = this.poolIndex.get(g.beatmap_id);
      if (owners) for (const s of owners) slugs.add(s);
    }
    if (extraSlug) slugs.add(extraSlug);
    if (slugs.size === 0) return;
    const partial = detail.match.end_time === null; // still open => history may be incomplete
    const hit = store.buildHit(detail, source, partial);
    await store.storeHit(hit);
    for (const s of slugs) await store.linkHitToTenant(s, hit.match_id, hit.start_time);
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

  private async maybePrune(): Promise<void> {
    if (Date.now() - this.lastPrune < config.pruneEveryMs) return;
    this.lastPrune = Date.now();
    try {
      const n = await store.pruneIndex();
      if (n > 0) console.log(`[index] pruned ${n} day bucket(s) older than ${config.indexRetentionDays} days`);
    } catch (e) {
      console.error("[index] prune failed:", (e as Error).message);
    }
  }

  // ---- status / persistence ----
  isParked(): boolean {
    return this.parked && this.rollBuffer.length === 0;
  }

  private async maybeFlush(): Promise<void> {
    if (Date.now() - this.lastStatusFlush < config.statusWriteMs) return;
    await this.flush();
  }

  async flush(): Promise<void> {
    this.lastStatusFlush = Date.now();
    this.roll.cursor_start = this.cursorStart;
    await store.saveRollState(this.roll);
    if (this.roll.index_from !== null && this.roll.cursor >= this.roll.index_from) store.addCoverage(this.roll.index_from, this.roll.cursor);
    if (this.activeWalk && this.activeWalk.cursor >= this.activeWalk.from_id) store.addCoverage(this.activeWalk.from_id, this.activeWalk.cursor);
    await store.flushIndexMeta();

    const walk = await store.loadWalk();
    const walkActive = !!walk && walk.status === "running";
    const coverage = this.cursorStart ? Math.max(0, Math.round((Date.now() - Date.parse(this.cursorStart)) / 1000)) : null;
    const behind = coverage === null ? null : Math.max(0, coverage - config.rollDelaySec);
    const onSchedule = behind === null ? true : behind <= Math.max(120, config.rollDelaySec * 0.1);
    const [hitsTotal, walkQueued, backfillQueued] = await Promise.all([
      store.hitsCount(),
      store.walkQueueLength(),
      store.backfillQueueLength(),
    ]);
    const idx = store.indexSummary();
    const bf = this.lastBackfillStatus;

    const status: Status = {
      updated_at: new Date().toISOString(),
      enabled: this.global.enabled,
      tenants_total: this.tenants.length,
      tenants_enabled: this.tenants.filter((t) => t.enabled).length,
      union_pool_size: this.poolIndex.size,
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
      index: {
        retention_days: config.indexRetentionDays,
        days: idx.days,
        oldest_day: idx.oldest_day,
        newest_day: idx.newest_day,
        matches: idx.matches,
        coverage: store.getCoverage(),
      },
      walk: {
        active: walkActive,
        status: walk?.status ?? "idle",
        id: walk?.id ?? null,
        from_id: walk?.from_id ?? null,
        to_id: walk?.to_id ?? null,
        cursor: walk?.cursor ?? null,
        processed: walk?.processed ?? 0,
        remaining: walk && walk.status === "running" ? Math.max(0, walk.to_id - walk.cursor) : 0,
        queued: walkQueued,
      },
      backfill: {
        active_slug: bf.slug,
        status: bf.state?.status ?? "idle",
        fetched: bf.state?.fetched ?? 0,
        to_fetch: bf.state?.to_fetch ?? 0,
        queued: backfillQueued,
      },
      last_error: this.lastError,
    };
    await store.writeStatus(status);
  }

  async flushPaused(): Promise<void> {
    await this.flush();
  }
}

