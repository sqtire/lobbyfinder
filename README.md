# osu! MP Pool Scanner (multi-tenant)

Watches **every** osu! multiplayer lobby and logs the ones that play a tournament's beatmap pool. Anyone can sign in with osu! (OAuth, `identify` scope), create a tournament, set its pool (up to 30 difficulty IDs), invite staff, sync a mainsheet roster, remove lobbies, and export. Results are public per tournament at `/t/<slug>`; editing is limited to members. Runs as two always-on Railway services sharing one Redis.

- **worker** — one process, one ≤1 req/sec limiter, three fronts in priority order:
  1. **rolling sweep** — walks every match once it is ~4h old (closed by then), writes it to the **match index** (`mpf:idx:<day>`: match id → maps played, ~1 MB/day, `INDEX_RETENTION_DAYS`), and stores full lobby detail *once* when any enabled tournament's pool intersects, linking a reference per tournament (tombstones honored). Runs regardless of how many tournaments exist — the index is the product.
  2. **tenant backfill** — a tournament's "rescan": scan the index for its pool over a match-id range (no API), link lobbies already stored (no API), read only lobbies nobody has stored yet (1 request each). Queued FIFO, one active per tournament. Ranges the scanner never read are reported as id gaps the owner can rescan.
  3. **owner walk** ("Admin rescan" in the UI) — the raw re-read of a match-id range into the index (1 request per osu! match). Site-owner only (`OWNER_OSU_IDS`); used to seed history / fill gaps after downtime. Output is shared by every tournament.
  Background fronts get a batch sized by the sweep's health, so the sweep never falls behind because of them.
- **web** — Next.js: landing (`/`), tournament pages (`/t/<slug>`), owner panel (`/owner`), APIs under `/api/t/<slug>/*` and `/api/owner/*`.
- **Redis** — tenants, members, sessions, the match index, the global hit store + per-tenant references/tombstones/rosters, queues, telemetry.

## Deploying the multi-tenant version over the old single-tenant one

1. In osu! account settings → OAuth → your existing application, set **Application Callback URL** to `https://<web-domain>/api/auth/callback`.
2. Railway env — web: add `OSU_CLIENT_ID`, `OSU_CLIENT_SECRET`, `OWNER_OSU_IDS`, `PUBLIC_BASE_URL` (`APP_PASSWORD` is no longer used). Worker: nothing new required.
3. Push. The worker resumes its cursor and starts indexing; the old `mpf:config` pool no longer drives matching by itself.
4. Sign in on `/`, open `/owner`, and **Adopt into tournament** — folds the legacy pool, lobbies, tombstones and roster into a tenant (copies only, idempotent). Within ~15 s the worker picks the tenant up and live matching continues under `/t/<slug>`. Then run one **Backfill** on that tournament for the current day to catch anything read between the deploy and the adoption.

## Roster sync formats

The mainsheet parser never assumes a layout. Per tab it tries, in order: (1) osu! profile links on player cells (rich links, `HYPERLINK()` formulas, raw URLs) — real user ids; (2) name + `#rank` cells; (3) a plain name grid — one team per row (`Team1: | name | name…`) or one team per column (team names in a header row, names below). Modes 2–3 match players by username against scanned lobbies. Mappool tables, schedules and single-column signup lists are rejected as grids; when the row/column orientation is ambiguous the preview offers a one-click flip. Whatever it finds is a preview the operator edits before committing.

## Local smoke test (worker)

`REDIS_URL=redis://127.0.0.1:6379/1 OSU_CLIENT_ID=x OSU_CLIENT_SECRET=y npm run smoke` in `worker/` exercises the index, coverage, prune, hit store, tenant links and the backfill state machine against a local Redis (no osu! calls except the deliberately-failing fetch path).
