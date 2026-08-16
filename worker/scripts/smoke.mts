// Store-level smoke test against a local Redis: index, scan, coverage, prune, hits, tenants, backfill glue.
process.env.REDIS_URL = "redis://127.0.0.1:6390/1";
process.env.OSU_CLIENT_ID = "x";
process.env.OSU_CLIENT_SECRET = "y";
process.env.KEY_PREFIX = "smoke";
process.env.INDEX_RETENTION_DAYS = "30";
const store = await import("../src/store.js");
const { Redis } = await import("ioredis");
const r = new Redis(process.env.REDIS_URL);
await r.flushdb();

const assert = (c: unknown, msg: string) => { if (!c) { console.error("FAIL:", msg); process.exit(1); } else console.log("ok  ", msg); };
const day = (offset: number) => store.addDays(store.todayUtc(), offset);
const detail = (id: number, maps: number[], dayOffset: number, open = false, users: number[] = [1, 2]) => ({
  match_id: id,
  match: { id, name: `lobby ${id}`, start_time: `${day(dayOffset)}T12:00:00Z`, end_time: open ? null : `${day(dayOffset)}T13:00:00Z` },
  games: maps.map((b, i) => ({ id: id * 100 + i, beatmap_id: b, mods: [], scores_count: users.length, scores: users.map((u) => ({ user_id: u, score: 1000 * u, accuracy: 0.99, mods: [], passed: true })) })),
  users: Object.fromEntries(users.map((u) => [u, `user${u}`])),
});

await store.loadIndexMeta();
// index 4 matches across 3 days (one is 45 days old => beyond retention)
assert(await store.indexMatch(detail(1000, [111, 222], -1) as any), "index match 1000 (yesterday)");
assert(await store.indexMatch(detail(1001, [333], -1, true) as any), "index match 1001 (yesterday, open)");
assert(await store.indexMatch(detail(1002, [222, 444], -3) as any), "index match 1002 (3 days ago)");
assert(await store.indexMatch(detail(900, [222], -45) as any), "index match 900 (45 days ago)");
assert(!(await store.indexMatch({ ...detail(1003, [], -1), games: [] } as any)), "zero-game match is not indexed");
const enc = store.encodeMaps([111, 222, 222], true);
assert(enc === `${(111).toString(36)},${(222).toString(36)}|p`, `encodeMaps dedupes + flags partial: ${enc}`);
assert(JSON.stringify(store.decodeMaps(enc)) === JSON.stringify({ maps: [111, 222], partial: true }), "decodeMaps roundtrip");
await store.flushIndexMeta();
let sum = store.indexSummary();
assert(sum.days === 3 && sum.matches === 4 && sum.oldest_day === day(-45), `summary ${JSON.stringify(sum)}`);

// scan: pool {222} over last 5 days => 1000, 1002 ; day(-2) has no bucket => uncovered ; day(0) pending (cursor day)
let res = await store.scanIndex(day(-5), day(0), new Set([222]), day(0));
assert(res.candidates.map((c) => c.match_id).join(",") === "1000,1002", `scan candidates ${JSON.stringify(res.candidates)}`);
assert(res.uncovered.join(",") === [day(-5), day(-4), day(-2)].join(","), `uncovered days ${res.uncovered}`);
res = await store.scanIndex(day(-1), day(-1), new Set([333]), null);
assert(res.candidates.length === 1 && res.candidates[0]!.partial === true, "partial flag surfaces in scan");

// coverage merge
store.addCoverage(100, 200); store.addCoverage(201, 300); store.addCoverage(500, 600); store.addCoverage(150, 250);
assert(JSON.stringify(store.getCoverage()) === JSON.stringify([{ from: 100, to: 300 }, { from: 500, to: 600 }]), "coverage merges adjacent/overlapping");
await store.flushIndexMeta();
await store.loadIndexMeta();
assert(store.getCoverage().length === 2, "coverage persisted + reloaded");

// prune: the 45-day-old bucket goes; coverage clipped to min remaining id (1000)
const pruned = await store.pruneIndex();
assert(pruned === 1, `pruned ${pruned} bucket`);
sum = store.indexSummary();
assert(sum.days === 2 && sum.matches === 3, `after prune ${JSON.stringify(sum)}`);
assert((await r.exists(store.K.idxDay(day(-45)))) === 0, "old bucket key deleted");
assert(store.getCoverage().length === 0, `coverage clipped below min indexed id (${JSON.stringify(store.getCoverage())})`);

// hits + tenant links + tombstones
const hit = store.buildHit(detail(1000, [111, 222], -1) as any, "auto", false);
assert(hit.all_games && hit.games.length === 2 && hit.players.length === 2, "buildHit stores all games + players");
await store.storeHit(hit);
assert(await store.hitExists(1000), "hit stored globally");
assert((await store.hitsCount()) === 1, "hits count 1");
assert(await store.linkHitToTenant("catfe3", 1000, hit.start_time), "link to tenant");
await r.sadd(store.K.tHidden("catfe3"), "1000");
assert(!(await store.linkHitToTenant("catfe3", 1000, hit.start_time)), "tombstoned link refused");
assert(await store.isHidden("catfe3", 1000), "isHidden true");

// tenants + global
await r.sadd(store.K.tenants, "catfe3");
await r.set(store.K.tenant("catfe3"), JSON.stringify({ slug: "catfe3", name: "Catfe 3", owner_id: 36887266, pool: [111, 222], enabled: true, start_day: day(-10), created_at: new Date().toISOString(), updated_at: new Date().toISOString() }));
const tenants = await store.loadTenants();
assert(tenants.length === 1 && tenants[0]!.pool.length === 2, "loadTenants");
assert((await store.loadGlobal()).enabled === true, "global default enabled");

// walk queue
await r.rpush(store.K.walkQueue, JSON.stringify({ id: "w1", from_id: 10, to_id: 20, cursor: 9, status: "queued", processed: 0, requested_at: new Date().toISOString(), requested_by: 1, finished_at: null }));
const w = await store.popNextWalk();
assert(w?.id === "w1" && w.status === "running" && (await store.loadWalk())?.id === "w1", "popNextWalk promotes to active");

// backfill scan path via the scanner (no API needed for queued -> scanning)
await r.set(store.K.tBackfill("catfe3"), JSON.stringify({ status: "queued", from_day: day(-5), to_day: day(0), requested_at: new Date().toISOString(), requested_by: 1, started_at: null, finished_at: null, candidates: 0, linked: 0, to_fetch: 0, fetched: 0, tombstoned: 0, uncovered_days: [], error: null }));
await r.rpush(store.K.backfillQueue, "catfe3");
const { Scanner } = await import("../src/scanner.js");
const sc = new Scanner();
sc.setTenants(tenants, { enabled: true, updated_at: "" });
(sc as any).cursorStart = `${day(0)}T00:00:00Z`;
await (sc as any).backfillStep(0);
const bf = await store.loadBackfill("catfe3");
assert(bf?.status === "fetching", `backfill moved to fetching: ${bf?.status}`);
assert(bf!.candidates === 2 && bf!.tombstoned === 1 && bf!.linked === 0 && bf!.to_fetch === 1, `scan tallies ${JSON.stringify({ c: bf!.candidates, t: bf!.tombstoned, l: bf!.linked, f: bf!.to_fetch })}`);
assert((await store.pendingLength("catfe3")) === 1 && bf!.uncovered_days.length === 3, "pending list + uncovered days recorded");
assert((await r.hget(store.K.coverageReq, "catfe3")) !== null, "coverage request written for owner");
// fetch phase with budget 1 hits the (blocked) osu! API -> error path, still counted, still finishes
await (sc as any).backfillStep(1);
const bf2 = await store.loadBackfill("catfe3");
assert(bf2!.fetched === 1, "fetch attempted (API unreachable here) and counted");
await (sc as any).backfillStep(1);
const bf3 = await store.loadBackfill("catfe3");
assert(bf3!.status === "done" && (await store.loadBackfillActive()) === null, `backfill completes: ${bf3!.status}`);
console.log("\nALL STORE/SCANNER CHECKS PASSED");
await store.disconnect(); await r.quit();
