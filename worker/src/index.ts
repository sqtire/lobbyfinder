import { config } from "./config.js";
import { sleep } from "./ratelimit.js";
import { Scanner } from "./scanner.js";
import * as store from "./store.js";
import type { AppConfig } from "./types.js";

async function main(): Promise<void> {
  console.log("[boot] osu! MP pool scanner (worker) starting");
  console.log(`[boot] rate=${config.minIntervalMs}ms/req, liveBatch=${config.liveBatch}, rescanBatch=${config.rescanBatch}`);

  const scanner = new Scanner();
  await scanner.init();

  let cfg: AppConfig = await store.loadConfig();
  let lastCfgRefresh = Date.now();

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[shutdown] ${sig} — flushing state`);
    try {
      await scanner.flush(cfg);
    } catch (e) {
      console.error("[shutdown] flush failed:", (e as Error).message);
    }
    await store.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  while (!stopping) {
    // refresh live config (pool + enabled) on a cadence
    if (Date.now() - lastCfgRefresh >= config.configRefreshMs) {
      cfg = await store.loadConfig();
      lastCfgRefresh = Date.now();
    }

    if (!cfg.enabled) {
      await scanner.flushPaused(cfg, "paused");
      await sleep(config.idleMs);
      continue;
    }
    if (cfg.target_beatmap_ids.length === 0) {
      await scanner.flushPaused(cfg, "no_pool");
      await sleep(config.idleMs);
      continue;
    }

    let didWork = false;
    try {
      didWork = await scanner.cycle(cfg);
    } catch (e) {
      console.error("[loop] cycle error:", (e as Error).message);
      await sleep(2000);
      continue;
    }

    // Fully caught up live AND no rescan running => nothing to do; idle briefly.
    if (!didWork && scanner.isLiveIdle()) {
      await scanner.flush(cfg);
      await sleep(config.idleMs);
    }
    // else: loop immediately; the shared limiter paces actual requests.
  }
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
