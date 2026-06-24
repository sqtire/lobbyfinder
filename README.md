# osu! MP Pool Scanner

Watches **every** osu! multiplayer lobby and logs the ones that play a beatmap in **your pool** (up to 30 difficulty IDs). The pool is editable live from a web panel; results are public to view, editing is password-gated. Runs as two always-on Railway services sharing one Redis.

- **worker** — the scanner. Two fronts in one process sharing a single ≤1 req/sec limiter: a **live** front always walking toward the newest match, and an on-demand **rescan** front that re-applies the current pool to a past range. Open lobbies are re-checked periodically (a lobby plays its maps after it opens).
- **web** — Next.js control panel + public results/health view.
- **Redis** — Railway Redis holds config, scan position, results, and telemetry.
