# Verification report

Verified locally on 2026-11-13 with Node 24.14.1 and npm 11.11.0. No production resources were deployed or changed.

**Story:** Coinbase/Kraken public feeds → persistent compiled worker → validated calculations and journal records → WebSocket → production Next.js UI → inspect original forecasts against observed outcomes.

| Boundary / check         | Result                 | Evidence                                                                                                                                            |
| ------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency compatibility | Pass                   | Pinned Next 16.4.6 + React 19.3.1, Lightweight Charts 5.3.0, Fastify 5.12.8; Node engines checked                                                   |
| Lint                     | Pass                   | `npm run lint`, no errors or warnings                                                                                                               |
| TypeScript               | Pass                   | `npm run typecheck`                                                                                                                                 |
| Automated tests          | Pass                   | 29 tests across four files: mathematics, indicators/risk, wire adapters, API/WebSocket/persistence and embedded PostgreSQL                          |
| Production frontend      | Pass                   | `npm run build`, static App Router page produced; `npm start` served successfully                                                                   |
| Compiled worker          | Pass                   | `npm run build:worker`; `NODE_ENV=production npm run start:worker` started and delivered live data                                                  |
| Dependency audit         | Pass                   | `npm audit`: zero vulnerabilities. Narrow minimatch override patches a transitive lint-tool advisory                                                |
| Coinbase → worker        | Pass                   | Actual live BTC prices, maker-inverted trades, L2 snapshot/updates, latency and freshness; no keys                                                  |
| Kraken → worker          | Pass                   | Actual BTC/USD trades/ticker; independently observed freshness and divergence                                                                       |
| Worker → UI              | Pass                   | Live browser price, regression/acceleration, executed pressure and book metrics updated; feed confirmation observed                                 |
| Forecast → outcome       | Pass                   | Original forecast IDs matched outcomes after the horizon; missed data excluded                                                                      |
| Signal features          | Pass                   | Real closed REST candle warmup and live feature coverage; valid neutral/long/short/insufficient transitions; contradiction blocking tested          |
| Persistence              | Pass locally           | JSONL records, atomic checkpoints and mode-specific recovery tested; event CSV served                                                               |
| Supabase migration       | Pass in PGlite         | All eight tables created with RLS, browser role denied, original forecast update rejected, old aggregates pruned                                    |
| Hosted Supabase          | Not exercised          | Credentials unavailable; no remote changes made                                                                                                     |
| Paper trading            | Pass in isolated tests | Authenticated API long open/close and net P&L, short returns, adverse fees/slippage, stops/gaps, sizing, drawdown, restart recovery                 |
| Fixture walk-forward     | Pass                   | One-hour chronological synthetic stream, 356 completed forecasts; in-app run visibly returned separately labeled fixture metrics                    |
| Historical replay        | Implemented            | Accepts chronological normalized user-supplied real BTC trades; no genuine historical trade dataset was supplied for an external performance study  |
| Mobile                   | Pass                   | 390×844 viewport; document scroll width 385px, viewport 390px; stacked cards and scrolling navigation                                               |
| Desktop                  | Pass                   | Dark dashboard, visible real-time metrics, all tabs, chart and Heikin Ashi toggle                                                                   |
| Browser runtime          | Pass after repair      | Initial clock hydration mismatch fixed with deterministic initial clock; no subsequent hydration errors after reload, including production frontend |
| Container image          | Not exercised          | Docker daemon unavailable; Dockerfile/compose supplied and the same compiled Node artifact executed directly                                        |

## Example actual production-path forecast

At approximately 09:40:31 UTC, a live `ols10-v1` forecast was created:

- ID `ca73e672-6ef2-45c4-bcd1-fce764ba0c39`
- Starting price $69,002.37; extrapolated T+20s price $68,977.4648
- Data age at creation 133ms
- Real observed price at approximately 09:40:52 UTC: $68,984.36
- Realized movement −$18.01; absolute error $6.8952; directional agreement true

The running ledger contained 76 original forecasts and 73 completed outcomes at 09:40:54 UTC, spanning development and compiled-worker runs with checkpoint recovery. These are small-sample observations, not evidence of predictive edge. Intermediate restarts produce missed horizons when an applicable observation is unavailable.

At the same observation, Coinbase was $68,984.36 and Kraken $68,997.60, divergence approximately 0.0192%, both fresh within 1s: CONFIRMED. Agreement status changes with actual source age; it is never forced to confirmed.

## Operational limits

The local system is a single trusted worker/account. Hosted auth, multi-tenant authorization, failover, disaster recovery, an external historical strategy study and container runtime validation remain deployment work. Synthetic fixture results must never be presented as historical trading accuracy or a calibrated probability. See STATUS.md and METHODOLOGY.md for exact formulas and limits.

# v2 verification (2026-11-13, Node 24.14.1)

| Check                     | Result         | Evidence                                                                                                                                                                                                                                                            |
| ------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lint / typecheck / build  | Pass           | At every phase commit                                                                                                                                                                                                                                               |
| Automated tests           | Pass           | 69 tests in 10 files. New: Kalshi signing (RSA-PSS, Ed25519), recorded market/settlement fixtures, ticker parsing, fees, resolution, buckets and DST display, snapshots/outcomes, engines, calibration, verdict gating, contract P&L/exits, contract API, migration |
| Live Kalshi (public REST) | Pass           | Worker on :4100 reported `PUBLIC REST (no key)`, active `KXBTC15M-26NOV130600-00`, Kalshi strike $69,251.11, YES 0.66/0.67, proxy CB+KR, bucket 10–5m                                                                                                               |
| Kalshi WebSocket with key | Not exercised  | Owner key not supplied to the development session; signing verified against generated keys                                                                                                                                                                          |
| Contract migration        | Pass in PGlite | 14 tables with RLS; immutable snapshots/outcomes/settlements; anon denied; `prune_contract_history()`                                                                                                                                                               |
| UI desktop / phone        | Pass           | 1440px and 390px via Chrome DevTools emulation; `scrollWidth` equals viewport on Dashboard and Kalshi tab                                                                                                                                                           |
| Hosted Supabase / Docker  | Not exercised  | As in v1                                                                                                                                                                                                                                                            |
