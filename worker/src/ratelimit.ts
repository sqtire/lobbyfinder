/**
 * One global pacer for EVERY osu! request — token, feed pages, match detail,
 * event pages, open-lobby re-checks — across BOTH the live and rescan fronts.
 * osu!'s ToU is <=1 req/sec, so there is exactly one limiter in the process and
 * every request awaits it. Acquisitions are strictly ordered and spaced.
 */
export class RateLimiter {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly minIntervalMs: number) {}

  acquire(): Promise<void> {
    const wait = this.chain.then(async () => {
      const elapsed = Date.now() - this.last;
      const delay = this.minIntervalMs - elapsed;
      if (delay > 0) await sleep(delay);
      this.last = Date.now();
    });
    // Never let a rejection poison the queue.
    this.chain = wait.then(
      () => undefined,
      () => undefined
    );
    return wait;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
