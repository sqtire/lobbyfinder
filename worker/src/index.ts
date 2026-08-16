import { config } from "./config.js";
import { sleep } from "./ratelimit.js";
import { Scanner } from "./scanner.js";
import * as store from "./store.js";

async function main(): Promise<void> {
  console.log("[boot] osu! MP pool scanner (worker, multi-tenant) starting");
  console.log(
    `[boot] rate=${config.minIntervalMs}ms/req, rollDelay=${config.rollDelaySec}s, rollBatch=${config.rollBatch}, ` +
      `bg=${config.bgBatchParked}/${config.bgBatchOnSchedule}/${config.bgBatchBehind}, skipOpen=${config.rollSkipOpen}, ` +
      `indexRetention=${config.indexRetentionDays}d`
  );

  const scanner = new Scanner();
  await scanner.init();

  const refresh = async () => {
    const [tenants, global] = await Promise.all([store.loadTenants(), store.loadGlobal()]);
    scanner.setTenants(tenants, global);
    return global;
  };
  let global = await refresh();
  let lastCfgRefresh = Date.now();

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[shutdown] ${sig} — flushing state`);
    try {
      await scanner.flush();
    } catch (e) {
      console.error("[shutdown] flush failed:", (e as Error).message);
    }
    await store.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  while (!stopping) {
    if (Date.now() - lastCfgRefresh >= config.configRefreshMs) {
      try {
        global = await refresh();
      } catch (e) {
        console.error("[loop] tenant refresh failed:", (e as Error).message);
      }
      lastCfgRefresh = Date.now();
    }

    if (!global.enabled) {
      // site-wide pause (owner switch): no reads at all, but keep status fresh
      await scanner.flushPaused();
      await sleep(config.idleMs);
      continue;
    }

    let didWork = false;
    try {
      didWork = await scanner.cycle();
    } catch (e) {
      console.error("[loop] cycle error:", (e as Error).message);
      await sleep(2000);
      continue;
    }

    if (!didWork) {
      // Parked at the delay boundary (or caught up to the live edge) with no
      // background work — wait for lobbies to age before checking again.
      await scanner.flush();
      await sleep(config.parkIdleMs);
    }
    // else: loop immediately; the shared limiter paces the actual requests.
  }
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
