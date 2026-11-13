# PulseTerminal v2

Version 2 of [PulseTerminal](https://github.com/kaidenkaihq/PulseTerminal), extended for Kalshi BTC 15-minute contracts (see [docs/V2_PLAN.md](docs/V2_PLAN.md)). It runs on ports **3100** (web) and **4100** (worker) so it can run alongside v1 on 3000/4000.

A working BTC-USD intelligence terminal: Coinbase trades and order book → persistent Fastify worker → one-second WebSocket snapshots → Next.js dashboard. Independent Kraken confirmation, timestamped 20-second extrapolations and actual outcomes, completed-candle signals, analytics, and simulation-only paper trading.

All times in the app and in CSV exports are **US Eastern (ET)**, including daylight saving. Daily P&L and the daily loss limit reset at midnight ET.

## Start locally

Requires Node.js **22+** (verified with Node 24) and npm. Exchange API keys and database credentials are **not required**.

```sh
npm ci
cp .env.example .env
npm run dev
```

Open **http://localhost:3100**. The worker binds to **http://127.0.0.1:4100**. The frontend connects directly to `/ws`; `/health` reports process and market health. Allow outbound HTTPS and WSS to Coinbase and Kraken. Allow approximately **30 seconds** for regressions and **60 seconds** for full signal flow coverage. Completed predictions begin approximately **50 seconds** after a healthy startup. A signal can legitimately be NEUTRAL or INSUFFICIENT DATA.

If either exchange is inaccessible, the UI reports its actual status. Live mode never silently generates prices. To explicitly use a synthetic demonstration:

```sh
# Replace npm run dev with this command, or set DATA_MODE=replay in .env.
DATA_MODE=replay npm run dev
```

On Windows PowerShell set `$env:DATA_MODE="replay"` first. Alternatively run `npm run worker:replay` and `npm run dev:web` in separate terminals. Replay is prominently labeled **SYNTHETIC REPLAY**, has an isolated virtual account/history, and never claims independent Kraken agreement.

## Kalshi 15-minute contracts: owner's guide

This version watches Kalshi's **BTC 15-minute Up/Down** contracts (series `KXBTC15M`), turns each engine's score into a measured probability, compares it with what a contract actually costs, and paper-trades contracts. **It never places a real Kalshi order.** Kalshi is used for read-only prices.

### 1. Do you need a Kalshi API key?

No. Without a key the app reads Kalshi's public prices once per second and labels them `KALSHI · PUBLIC REST`. With a key it also gets a live WebSocket price stream (`KALSHI · WEBSOCKET`).

### 2. Adding your key

1. On kalshi.com, open your account settings and find **API Keys**. Create a key. Kalshi shows a **Key ID** and gives you a **private key** file once. Keep that file safe; anyone with it can trade your account.
2. In the project folder, create a folder called `keys` and save the private key there, for example `keys/kalshi.key`. This folder is excluded from git and Docker, so the key cannot be uploaded by accident.
3. Open the `.env` file in the project folder (copy `.env.example` to `.env` if you haven't) and fill in:

   ```sh
   KALSHI_API_KEY_ID=paste-your-key-id-here
   KALSHI_PRIVATE_KEY_PATH=./keys/kalshi.key
   ```

   Never put these in a variable starting with `NEXT_PUBLIC_`.

### 3. Running it

```sh
npm ci            # first time only
npm run dev
```

Open **http://localhost:3100** and click the **Kalshi 15m** tab. Check **Settings → source comparison**: `kalshi` should say `STREAMING (key)` with a key or `PUBLIC REST (no key)` without one. To try it with no internet data, run `DATA_MODE=replay npm run dev`. That shows a clearly labelled **synthetic** contract that is not Kalshi.

Leave the worker running. Everything it learns is saved in `./data`, and calibration needs days of windows.

### 4. Reading the Kalshi tab

- **Countdown / bucket.** Time left in the current window. Engines are measured separately in four phases: 15–10, 10–5, 5–2 and 2–0 minutes to close.
- **Target vs proxy price.** The target is Kalshi's strike. Kalshi settles on CF Benchmarks' index, which this app can't see live, so it follows a Coinbase/Kraken average and shows the gap ("basis") each time Kalshi publishes an official number.
- **How percentages are labelled.**
  - **Market price (¢)** is what you'd pay: the ask plus Kalshi's fee.
  - **Calibrated P (%)** is the model's measured probability.
  - **Raw score** is not a probability.
- **Edge after fees** = calibrated probability − market price.
- **Engine cards.** Momentum (the original trend-following signal) and Panic-Fade (bets against a sharp move once the selling or buying runs out). They are never blended.
- **Calibration table.** For each engine and phase it shows how many windows have been scored, the hit rate, and the Brier score, where lower is better. Baseline is the Brier you'd get by always guessing the usual UP rate. Click a row to see its reliability chart, where dots on the diagonal mean the probabilities are honest.
- **Settlement: proxy vs official.** How often the app's own result disagreed with Kalshi's.
- **Simulated contract order / Exit policy.** Paper-trade YES or NO. Positions sell automatically when your side's bid reaches **97¢**. Otherwise they hold to the $1/$0 settlement.

### 5. Why it will mostly say NO TRADE

A verdict appears only when **all** of these hold:

1. An engine is **CALIBRATED** in the current phase. That takes at least 200 completed windows per phase, roughly **2+ days of continuous running**, and the engine must beat the always-guess-the-base-rate baseline on windows it had not seen.
2. Its edge after Kalshi's fee is at least **3¢**.
3. Kalshi, Coinbase and the Kraken cross-check are all fresh.

Until then NO TRADE is the honest answer, and the reasons are listed under the verdict.

### 6. Still needed from you

- **Your stop-loss and ratchet numbers.** Once you have them, put them in `.env`, for example `CONTRACT_EXIT_PHASES=120:0.10` ("in the last 120s, sell if the bid falls to 10¢") and `CONTRACT_RATCHET=0.80:0.65` ("once the bid reaches 80¢, sell if it falls back to 65¢"). They are empty until you supply them.
- **Your panic-fade definition**, if your research has one. The `FADE_*` settings in `.env` control the current default.
- **A recent Kalshi fill receipt**, to confirm the fee rounding.

### 7. Re-testing rules on saved history

After changing `FADE_*` or `CALIBRATION_*` settings, run:

```sh
npm run contracts:rebuild
```

This re-scores the saved windows with the new settings and prints a calibration table, with the full report in `data/contract-rebuild.json`. Per-second history is kept for 30 days (`CONTRACT_TICK_RETENTION_DAYS`).

## Application

- **Kalshi 15m:** contract, strike vs proxy, engine cards, walk-forward calibration, fee-inclusive edge, verdict, proxy/official settlement agreement, simulated contract account and CSV exports. A headline strip sits on top of the Dashboard. See the owner's guide above.
- **Dashboard:** 20s extrapolation, 10s/30s regression velocities, acceleration, 20s/60s notional aggressor pressure, CVD, book imbalance/spread, long/short ATR scenarios, crypto breadth, independent feed health, four-candle wick analysis, interactive chart with OHLC/Heikin Ashi, EMA9/20, SuperTrend, signal markers and live delta.
- **Signal History:** original timestamped forecasts, pending/completed/missed outcomes, signal transitions, downloadable CSV. CSV includes up to 8,640 worker-retained forecasts; the UI holds the latest 1,000.
- **Backtesting & Analytics:** actual completed forecast error and directional agreement, sample sizes, descriptive velocity regimes, paper results after fees/slippage, and an isolated in-app chronological fixture runner. Fixture metrics are explicitly separate from live results.
- **Paper Trading:** manual long/short virtual orders, one open position, capped virtual buying power, configurable BTC size, fees/slippage, observed-price stops/targets, equity curve, daily realized P&L (ET day), trade journal. Auto entries require explicit Settings opt-in and reset to manual on worker restart.
- **Settings:** source comparison, current startup configuration, diagnostics, session-only worker token, paper execution settings.

There is no live order placement, wallet connection, brokerage API, funding flow or exchange trading key.

## Configuration

See [.env.example](.env.example). The worker reads `.env`, not Next.js-specific `.env.local`. Restart the worker after configuration changes. For a separately hosted frontend, set `NEXT_PUBLIC_WORKER_URL` at frontend build time to the worker's **HTTPS** origin; WebSockets automatically use WSS. Set `FRONTEND_ORIGINS` to an exact comma-separated allowlist.

`WATCHLIST` accepts Coinbase `BASE-USD` symbols (default 10 liquid crypto pairs). `FRESHNESS_MS`, `DIVERGENCE_PERCENT`, `ATR_PERIOD`, `SUPER_TREND_MULTIPLIER`, and `PAPER_BALANCE` are validated at startup. Unknown exchange products report subscription errors instead of invented values. Default confirmation is ≤0.20% divergence with both prices ≤5s old. Kraken maps `BTC-USD` to `BTC/USD`.

For a non-loopback worker set a long random `WORKER_API_TOKEN`, then enter it in Settings. Every POST requires that bearer token; without one, POSTs are permitted only from a loopback client. An origin allowlist, request-size limits, rate limits and WebSocket client/backpressure limits are included. Read-only market snapshots include the worker's single shared paper account: keep this application on a trusted/private network or add application identity and authorization before exposing it to multiple users. A shared bearer token is not multi-tenant authorization.

## Persistence

Without Supabase, the worker uses **local JSONL journals and atomic JSON checkpoints** in `LOCAL_DATA_DIR` (`./data`). UI status says LOCAL JOURNAL. Forecasts, outcomes, closed candles, signal transitions, 15s aggregates, paper transactions and health are journaled; raw ticks are held only in bounded memory. Checkpoints every 10s recover the recent UI history and paper account on restart. If local storage fails, errors are surfaced; an unwritable directory at startup selects MEMORY ONLY. Mount a persistent volume when hosting the worker.

To enable Supabase:

1. Create your own Supabase project and apply `supabase/migrations/20261113092438_pulseterminal.sql` using the SQL editor or your normal migration pipeline.
2. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` **only on the worker**. Never use a `NEXT_PUBLIC_` prefix.
3. Restart the worker. It journals locally and batch-upserts aggregate/event records to the database. Failed batches remain in a bounded retry queue and health reports failures.

All eight tables have RLS enabled. Browser roles receive no grants or policies; access is denied by default. The worker service role alone writes/reads. Forecast and signal update triggers reject edits to original records. Indexed envelope columns hold UTC event time, mode, record ID and a versioned JSON payload; forecast model version is inside the payload.

Run `select private.prune_terminal_history();` as a database administrator, or schedule it with your project's pg_cron: health 7d, aggregates 30d, forecasts/outcomes 180d, candles/signals 365d; paper journals are preserved. Local journals have a separate 180-day retention; archive needed history first. No hosted database or production deployment was modified during development.

## Tests and validation

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run replay
```

Tests cover regression/acceleration, projection deadlines, aggressor inversion and exchange wire fixtures, book snapshot/update reconciliation, freshness, UTC candle boundaries, incomplete-candle backfill, indicator warmup/no-lookahead, normalized scoring, long/short net P&L, gap fills, risk calculations, WebSocket/API integration, bearer authorization, checkpoint recovery, and the SQL migration/RLS/immutability using embedded PostgreSQL (PGlite).

`npm run replay` runs a deterministic synthetic one-hour stream, creates original forecasts chronologically and evaluates them after 20 seconds. Reports and records are written to `data/walk-forward*.json`. It validates mechanics, **not historical trading performance**. The analytics tab can run the same isolated fixture without changing the live engine or account.

For actual recorded historical trades:

```sh
npm run replay:historical -- path/to/trades.json
```

Input is a chronological JSON array of normalized records:

```json
[
  {
    "id": "unique-exchange-trade-id",
    "symbol": "BTC-USD",
    "time": 1794560400000,
    "price": 68000,
    "size": 0.01,
    "side": "buy"
  }
]
```

At least 60 records are required. `time` is UTC epoch milliseconds and `side` is the **aggressor** side (invert Coinbase maker side). Out-of-order files are rejected; trades are delivered only when their timestamp has been reached. Reports/forecast records go to `data/historical-*.json`. The runner does not reconstruct missing books or infer aggressor data from OHLC; strategy signals stay insufficient without full feature coverage. Historical 15m strategy performance requires a suitable full-feature dataset or accumulating closed signal-linked paper trades.

## Build and hosting

Frontend: `npm run build`, then `npm start`. Compatible with a standard Next.js/Vercel frontend deployment. Its market worker runs separately and persistently; serverless functions do not host feed connections. Do not put service-role credentials into the frontend project.

Worker:

```sh
docker build -f Dockerfile.worker -t pulseterminal-worker .
docker compose up --build worker
```

Or `npm run worker` on Node 22+. For Railway/equivalent use `Dockerfile.worker`, port `4100` (or `WORKER_PORT`), set `WORKER_HOST=0.0.0.0`, configure HTTPS/WSS, exact frontend origins, a worker bearer token, and a `/data` persistent volume. Run **one worker per account**. Docker runs as non-root and includes a process-health probe; inspect `/health`'s market field separately for stale data. No production deployment is performed by these setup commands unless you run them on a production host.

See [methodology](docs/METHODOLOGY.md), [implementation status](docs/STATUS.md), and [verification report](docs/VERIFICATION.md).

## Official references

- [Coinbase Exchange WebSocket channels](https://docs.cdp.coinbase.com/exchange/websocket-feed/channels): `matches` reports the maker side. Authenticated `level2` is replaced here with the documented public **`level2_batch`**, with the same snapshots and absolute quantity updates every 50ms, so no exchange keys are needed.
- [Coinbase historical candles](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles): closed historical 1m/15m OHLC warmup.
- [Kraken v2 trades](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/trade) and [ticker](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ticker): independent BTC/USD trade/last-price confirmation.
- [TradingView Lightweight Charts 5](https://tradingview.github.io/lightweight-charts/docs): client charting with attribution retained.
- [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) and [Next.js](https://nextjs.org/docs/app): security and runtime conventions.
