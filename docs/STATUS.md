# Implementation status

Implemented application code, not a mockup. No existing application or production resource was modified.

| Area                                                                       | Status                                                                                                                                                          |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next.js / React / TypeScript / Tailwind / shadcn-style Radix UI primitives | Implemented, production build verified                                                                                                                          |
| Dark responsive dashboard and all five tabs                                | Implemented, desktop and mobile browser review                                                                                                                  |
| Persistent Fastify/WebSocket worker                                        | Implemented with heartbeat timeout, exponential reconnect/jitter, validated exchange payloads, bounded buffers, client limits and stale protection              |
| Coinbase keyless feed                                                      | Live verified: ticker, matches, heartbeat, public level2_batch snapshots/updates                                                                                |
| Kraken v2 confirmation                                                     | Live verified: BTC/USD trades and trade-triggered ticker; no fake replay confirmation                                                                           |
| 20s OLS forecasts and outcomes                                             | Live verified, original creation records, complete/missed horizons, model/features/freshness, CSV                                                               |
| Pressure and order book                                                    | Maker inversion, 20s/60s notional volume, delta/CVD, pressure trend, nearest-20-level imbalance/spread                                                          |
| 1m / 15m candles and strategy                                              | Historical REST warmup + live aggregation, incomplete candle recovery, EMA, ATR, SuperTrend, swing extremes, normalized score, exclusive state                  |
| Wick analysis                                                              | Four fully closed 15m candles, weighted rejection, annotated candle visualization                                                                               |
| Crypto breadth                                                             | 10 configured markets, actual observed 20s anchors, freshness/coverage gating; can truthfully show insufficient data in quiet markets                           |
| Interactive chart                                                          | Lightweight Charts 5, OHLC/Heikin Ashi, EMA/SuperTrend overlays, signal markers, live delta                                                                     |
| Forecast analytics                                                         | Actual observed prediction outcomes, errors, sample sizes, velocity regimes                                                                                     |
| Backtesting                                                                | In-app isolated synthetic fixture runner, CLI fixture runner, CLI chronological user-supplied historical trades runner                                          |
| Paper account                                                              | Manual default, explicit auto opt-in, long/short, fees/slippage, stops/targets, equity, journal, UTC P&L, net realized R and drawdown                           |
| Supabase                                                                   | All eight table migrations, indexes, RLS deny-by-default, immutable originals, retention function, worker batch writer; migration tested on embedded PostgreSQL |
| Local persistence                                                          | JSONL journals, atomic checkpoints, crash-tail forecast recovery, separate live/replay state; memory fallback with visible error                                |
| Delivery                                                                   | Lockfile, environment example, Docker worker, compose, setup/deployment docs, methodology, verification report                                                  |

## Practical limitations

- No Supabase credentials were supplied. Hosted Supabase connectivity, service-role authorization and deployment-specific advisors could not be tested against a real project. The SQL was applied and exercised in embedded PostgreSQL; no remote project was changed.
- No screenshot was attached to this task. The UI follows the requested layout, colors and hierarchy rather than a pixel comparison against a missing reference.
- The historical trade replay runner requires the operator's genuine recorded dataset. The bundled fixture is synthetic and explicitly labeled. A full historical 15m strategy study needs historical order books plus aggressor trades; the app does not fabricate those from candles. Signal hit rate remains insufficient until actual signal-linked paper positions close.
- Paper-account ownership is one trusted worker instance, not per-user identity. Read-only snapshots expose that shared virtual account. Multi-tenant/public operation needs user authentication/authorization before exposure.
- Feed reconnects and gaps suspend full pressure coverage. Partly observed candles wait for REST backfill. Coinbase REST availability can therefore affect indicator readiness without affecting fresh ticker display.
- Regressions are extrapolations, scoring is heuristic, and execution is a simplified simulator. No probability calibration or profitability claim is made. Costs omit borrow/funding, partial fills and queue position.
- Local journal retention is 180 days, evaluated at startup. Checkpoints are every 10s and after manual account mutations. A mounted volume is required for recovery on host replacement. Supabase's bounded retry queue is in memory; the local journal is the recovery source for rows not synced before a crash.
- The Docker image/configuration is supplied; the local Docker daemon was unavailable, so the image itself could not be built here. The compiled worker artifact was started and checked directly on Node. Frontend and worker were executed directly on Node during verification.
