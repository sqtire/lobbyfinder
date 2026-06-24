# osu! MP Pool Scanner

Watches **every** osu! multiplayer lobby and logs the ones that play a beatmap in **your pool** (up to 30 difficulty IDs). The pool is editable live from a web panel; results are public to view, editing is password-gated. Runs as two always-on Railway services sharing one Redis.

- **worker** — the scanner. Two fronts in one process sharing a single ≤1 req/sec limiter: a **live** front always walking toward the newest match, and an on-demand **rescan** front that re-applies the current pool to a past range. Open lobbies are re-checked periodically (a lobby plays its maps after it opens).
- **web** — Next.js control panel + public results/health view.
- **Redis** — Railway Redis holds config, scan position, results, and telemetry.

---

## What you need to do

### 1. Register an osu! OAuth app
https://osu.ppy.sh/home/account/edit#oauth → **New OAuth Application**. Callback URL can be anything (e.g. `https://example.com`) — this uses client-credentials, no redirect. Copy the **Client ID** and **Client Secret**.

### 2. Push this repo to GitHub
A normal private repo is fine. Both services deploy from it; each just uses a different root directory.

### 3. Create the Railway project + Redis
- New Project → **Deploy from GitHub repo** (pick this repo).
- In the project: **New → Database → Add Redis**. Open the Redis service → **Variables/Settings** and turn **persistence (RDB/AOF) on** so results survive restarts.

### 4. Create the **worker** service
- New → **GitHub Repo** → this repo (or use the service Railway already created).
- Service **Settings → Root Directory** = `worker`. (The `worker/railway.json` then pins it to **1 replica**, restart **always** — keep it at 1; the rate limiter is in-process, so 2 replicas would double your request rate and risk an osu! ban.)
- **Variables**:
  - `REDIS_URL` = `${{Redis.REDIS_URL}}`  ← reference the Redis service
  - `OSU_CLIENT_ID` = your client id
  - `OSU_CLIENT_SECRET` = your client secret
  - `KEY_PREFIX` = `mpf` (optional, but if you set it, set the **same** value on the web service)

### 5. Create the **web** service
- New → **GitHub Repo** → this repo again.
- Service **Settings → Root Directory** = `web`.
- **Settings → Networking → Generate Domain** (gives you the public URL).
- **Variables**:
  - `REDIS_URL` = `${{Redis.REDIS_URL}}`  ← same Redis
  - `APP_PASSWORD` = whatever password you want for editing
  - `SESSION_SECRET` = a random string — `openssl rand -hex 32`
  - `KEY_PREFIX` = `mpf` (must match the worker if you set it there)

### 6. Go live
Open the web domain → **Unlock** (your `APP_PASSWORD`) → type your beatmap **difficulty** IDs into the pool grid → **Save pool** → flip **Scanner running** on. The health panel should start moving within a few seconds.

That's it. Day to day you only touch the web UI.

---

## Using it

- **Pool** — up to 30 **beatmap (difficulty) IDs**. In `/beatmapsets/1234#osu/5678`, the number you want is `5678` (a.k.a. `/b/5678`), **not** the `1234` set ID. Editing the pool affects only future scanning until you rescan.
- **Stop / start** — the toggle pauses the worker (zero API calls). Restarting auto-resumes from the saved position; any lobbies opened while stopped get picked up as the live front walks forward (shows as lag, then catches up). Stopping the Railway service does the same thing.
- **Rescan from match ID X** — retro-applies the *current* pool to `[X → live position]` while live scanning continues. Every result row has a copy-`#id` button to grab a start point. The panel shows the gap size + an ETA before you start, and you can cancel anytime. Re-running is safe (idempotent upsert by match ID).
- **Results** — newest first; each shows the matched map(s), mods, and when they were played. Public to anyone with the URL; only editing needs the password.

---

## Reality check on rate limits (read this)

osu!'s ToU is **≤1 request/sec for everything**, and reading a lobby costs **one request to list + one (or more) to read its games**. New lobbies appear at very roughly **1.5k–2.5k/hour**. So:

- On a **daily average the scanner keeps up**, but during peak hours (evenings/weekends) it will **fall behind and then catch up overnight**. The "matches behind" number on the gauge is expected to breathe up and down. This is fundamental — more parallelism cannot beat the global 1 req/sec limit, it would just get you rate-limited.
- A **rescan shares that same budget** with live scanning (≈50/50 by default, tunable via `LIVE_BATCH` / `RESCAN_BATCH`), so a large historical sweep takes a while and the ETA reflects that.
- Match-feed scanning is **visible tournament scouting** — admins watching the public match feed is a known, documented use. Fine for your context; just don't expect it to be covert.

---

## Local dev (optional)

You need a local Redis (`brew install redis && redis-server`) or just point `REDIS_URL` at the Railway Redis's **public** URL.

```bash
# worker
cd worker && npm install
REDIS_URL=redis://localhost:6379 OSU_CLIENT_ID=... OSU_CLIENT_SECRET=... npm run dev

# web (separate terminal)
cd web && npm install
REDIS_URL=redis://localhost:6379 APP_PASSWORD=test SESSION_SECRET=dev-secret npm run dev
# → http://localhost:3000
```

See `.env.example` for the full variable list.

---

## Tuning (worker env vars, all optional)

| var | default | meaning |
|---|---|---|
| `OSU_MIN_INTERVAL_MS` | `1100` | spacing between **all** osu! requests |
| `LIVE_BATCH` / `RESCAN_BATCH` | `4` / `4` | matches processed per front per cycle (the live/rescan split) |
| `FEED_LIMIT` | `50` | `/matches` page size for discovery |
| `MAX_EVENT_PAGES` | `50` | cap on event paging per lobby (huge auto-host rooms) |
| `WATCH_OPEN_MATCHES` | `true` | re-check still-open lobbies for maps played after they opened |
| `WATCH_RECHECK_EVERY_SEC` | `120` | how often open lobbies are re-checked |
| `STATUS_WRITE_EVERY_MS` | `15000` | telemetry flush cadence |
| `CONFIG_REFRESH_MS` | `15000` | how often the worker re-reads pool/enabled |

Web vars: `REDIS_URL`, `APP_PASSWORD`, `SESSION_SECRET`, `KEY_PREFIX`.

---

## One thing to verify against the live API

The match feed is paged with `sort=id_asc&cursor[match_id]=<id>` (documented only via API wrappers). The code reads the API's returned cursor and defends with explicit id-range filtering, so it's robust even if cursor semantics differ slightly — but it's the first place to look if the live front behaves oddly. It's flagged in `worker/src/osu.ts`.
