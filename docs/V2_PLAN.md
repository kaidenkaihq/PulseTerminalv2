# PulseTerminal v2 plan: Kalshi 15m contracts + calibration

Phase 0 deliverable, written 2026-11-13. **Status: implemented in Phases 1–7** (see `docs/STATUS.md`).

Owner answers (2026-11-13): has a Kalshi API key; take profit is always at 97¢. No written panic-fade definition and no stop-loss/ratchet numbers were supplied, so fade uses the configurable default and those exit rules are labelled placeholders.

## 1. Gap analysis, checked against the code

| Claim                | Verdict   | Evidence / correction                                                                                                                                                                                                                                                          |
| -------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No Kalshi layer      | Confirmed | No contract, fee, settlement or binary-P&L code anywhere. `lib/paper.ts` is spot-only (notional × bps fees, ATR stop/target).                                                                                                                                                  |
| No calibration       | Confirmed | `(1 ± score)/2 × 100` is rendered at `components/terminal.tsx:625` and `:637` ("Directional heuristic … / 100") and documented as heuristic in `METHODOLOGY.md`. Nothing maps a score to an observed frequency.                                                                |
| Momentum-only logic  | Confirmed | `lib/signals.ts` LONG requires score > 0.22 **and** bullish EMA/SuperTrend **and** positive 30s velocity **and** positive 60s aggressor share (SHORT mirrors). No fade logic, no seconds-to-close input.                                                                       |
| Additional gap (new) | Found     | **No 15m outcome ledger at all.** The 15m "signal" is a state machine; nothing records whether the window actually closed up. Only the 20s forecasts have outcomes.                                                                                                            |
| Additional gap (new) | Found     | **Wrong reference price.** Kalshi's strike is a 60-second _average_ of a different index (below), not the 15m candle open and not a last trade. Comparing price to `candle.open` would mislabel close calls.                                                                   |
| Additional gap (new) | Found     | **Buffers too short for fade.** `worker/engine.ts` keeps 1s samples and trades for only 120s (`:92`, `:113`, `:132`). A rolling 1m-return σ and a "peak then exhaustion" check need ≥ 15 min of 1s samples. The buffer will be widened for samples only (trades stay bounded). |
| Additional gap (new) | Found     | **Feature persistence is coarse.** `market_aggregates` is written roughly every 15s (`now % 15000 < 1000`), and CVD is a session-cumulative level, not a slope. Phase 2 needs a 1/s snapshot and a CVD slope.                                                                  |

## 2. Kalshi facts, resolved from official sources

All of the following were read from Kalshi's own public API on 2026-11-13 (`GET https://api.elections.kalshi.com/trade-api/v2/series/KXBTC15M` and `/markets?series_ticker=KXBTC15M`) and docs.kalshi.com, not from blogs.

### Series and market discovery

- Series ticker: **`KXBTC15M`** ("BTC 15 min", category Crypto, `frequency: fifteen_min`).
- Each window is one event with one binary market, e.g. event `KXBTC15M-26NOV130545`, market `KXBTC15M-26NOV130545-45`. The date/time in the ticker is the **close time in US Eastern** (05:45 EST = 10:45 UTC). We never parse times out of tickers; we use the API's `open_time` / `close_time`.
- Discovery: `GET /trade-api/v2/markets?series_ticker=KXBTC15M&status=open` returns the active market. **This and the other market-data REST endpoints are public, no key needed.** Settled results come from `GET /markets/{ticker}` or `status=settled`.

### Strike and resolution rule (verbatim from `rules_primary`)

> "If the simple average of the sixty seconds of CF Benchmarks' BRTI before 5:45 AM EST on Nov 13, 2026 is at least the simple average of the sixty seconds of CF Benchmarks' BRTI before 5:30 AM EST on November 13, 2026, then the market resolves to Yes."

- **Strike** (`floor_strike`) = 60-second simple average of BRTI over `[open − 60s, open)`, rounded to 2 dp. It equals the previous window's `expiration_value` (verified: settled `…0530-30` had `expiration_value 69225.46`; the next market's `floor_strike` was `69225.46`).
- **Settle value** (`expiration_value`) = 60-second simple average of BRTI over `[close − 60s, close)`, 2 dp.
- **YES (= UP) iff settle ≥ strike** (`strike_type: greater_or_equal`). An exact tie is UP.
- Kalshi settles ~4.6s after close (`settlement_ts` observed `10:30:04.6Z`). `result` is `"yes"`/`"no"`; `settlement_value_dollars` is `1.0000`/`0.0000`.
- `can_close_early: true` is set on these markets. Early closure will be recorded as its own outcome status, never forced into UP/DOWN.

### Settlement index: not Coinbase

- Settlement source is **CF Benchmarks' Bitcoin Real Time Index (BRTI)** (`settlement_sources: CF Benchmarks`). BRTI aggregates several USD exchanges; Coinbase and Kraken are constituents, but BRTI is not either of them.
- BRTI is **not freely observable in real time**, so we cannot compute a continuous `coinbase − BRTI` basis. Instead:
  - The proxy settle price is the 60s simple average of 1s samples of the **mean of Coinbase and Kraken** (Coinbase alone when Kraken is stale), recorded as `proxySource`.
  - **Basis is observable twice per window**: at open (`floor_strike` vs our proxy 60s average) and at settlement (`expiration_value` vs our proxy). Both are journaled and shown as "proxy vs official basis".
  - Continuous display is labelled **"settlement source not observable in real time — model watches a Coinbase/Kraken proxy"**.

### Window alignment

- Observed `open_time 10:30:00Z`, `close_time 10:45:00Z`. These are exactly our UTC `floor(epoch/900000)` 15m buckets, so a window id is the same `boundary(now, 900)` the candles already use.
- **Important difference:** the strike is the average over the 60s _before_ open, so the strike is known (to Kalshi) at open, while our 15m candle `open` is the first trade _after_ open. Distance-to-strike always uses `floor_strike` when Kalshi supplies it, else the proxy 60s average.
- DST affects only the Eastern time inside ticker strings and display. All logic is UTC. (Since 2026-11-13 every displayed time and export is in ET.)

### Fees

- The series reports `fee_type: "quadratic"`, `fee_multiplier: 1`.
- Kalshi's fee schedule (PDF dated July 7, 2026; the PDF itself sits behind a bot checkpoint and could not be fetched directly, so the formula was confirmed from Kalshi's indexed copy of it) gives the general taker fee as
  **`fee = ceil( multiplier × 0.07 × C × P × (1 − P) )`**, with `C` the number of contracts and `P` the price in dollars. No fee at settlement; no fee to cancel.
- Rounding (docs.kalshi.com "Fee Rounding"): the model fee is rounded up to $0.000001; the balance change is then aligned to the member's precision, **$0.01 for non-direct (normal retail) members** and $0.0001 for direct members. So, for a normal account, the total for an order is effectively rounded **up to the next cent per order**, not per contract.
- Implementation: `KALSHI_FEE_RATE` (default 0.07), the multiplier read live from the series, and `KALSHI_FEE_PRECISION` (default 0.01). **Flagged:** confirm the precision against one of your real Kalshi fills; the 0.0175 maker rate is not used because simulated entries take the ask.
- Worked example: 10 contracts at $0.39 → 0.07 × 10 × 0.39 × 0.61 = $0.1665 → **$0.17**, i.e. $0.017/contract on top of the $0.39.

### Request signing (docs.kalshi.com "API Keys")

- Headers: `KALSHI-ACCESS-KEY` (key id), `KALSHI-ACCESS-TIMESTAMP` (ms), `KALSHI-ACCESS-SIGNATURE` (base64).
- Signed string: `timestamp + METHOD + path`, no separators; path **includes** `/trade-api/v2`, **excludes** the query string. Timestamp must be within 30s of Kalshi's clock.
- RSA keys: **RSA-PSS, SHA-256, MGF1-SHA-256, salt length = 32 (digest length)**. Kalshi now also issues Ed25519 keys (signs the string directly). The client will detect the key type from the parsed key, as Kalshi's sample code does, so either works.
- WebSocket: `wss://external-api-ws.kalshi.com/trade-api/ws/v2`. **The connection requires those same three headers, even for public channels**, signing `timestamp + "GET" + "/trade-api/ws/v2"`. The `ticker` channel flushes changed markets about once per second with `yes_bid_dollars`, `yes_ask_dollars`, `price_dollars`, sizes and `ts_ms`. No ask = 1 − yes bid, and no bid = 1 − yes ask (consistent with the REST snapshot: yes bid 0.38 ↔ no ask 0.62).
- Rate limits: Basic tier has 200 read tokens/s at 10 tokens per request (≈ 20 req/s). 1/s polling is well inside it.

## 3. Proposed design decisions

1. **Credentials become optional.** Because market data is public over REST, the worker will:
   - with a key: use the authenticated WebSocket `ticker` channel (≈1/s pushes);
   - without a key: poll the public REST market endpoint at 1/s, labelled `KALSHI: PUBLIC REST (no key)`;
   - with neither working: show `KALSHI: NOT CONFIGURED / UNAVAILABLE`.

   This deviates slightly from "missing credentials → NOT CONFIGURED", but it means you get real quotes on day one without creating a key. The key only buys lower latency.

2. **Outcomes.** Each window gets an immutable `contract_outcome` with our proxy result. Kalshi's official `result`/`expiration_value` are attached in a separate `contract_settlement` record, because the outcome is written at close (~5s before Kalshi settles) and originals are never edited. Metrics use the **official** result where present and count proxy/official mismatches.
3. **Independence.** Metrics use one snapshot per window per bucket (the bucket's first eligible second), so n = windows.
4. **Strict versioning.** `momentum-v1`, `fade-v1`, `calib-isotonic-v1`. Every snapshot stores the engine config used.

## 4. Phase-by-phase outline

| Phase | Output                                                                                                                                                                                                                        |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `worker/kalshi.ts` (signing, discovery, WS/REST, health, roll-over at window boundaries), `kalshi_quotes` journal + new Supabase migration, replay contract generator labelled `SYNTHETIC CONTRACT`, signing/parse/fee tests. |
| 2     | Per-second `contract_snapshots`, `contract_outcomes`, `contract_settlements`, bucket config, 15-min sample buffer, CVD slope.                                                                                                 |
| 3     | `lib/engines.ts` wrapping `signal()` unchanged as `momentum-v1`; `lib/fade.ts` `fade-v1`; no-lookahead and stale-input tests.                                                                                                 |
| 4     | `lib/calibration.ts` (PAV isotonic, logistic fallback, walk-forward refit every 4 windows, Brier/log-loss/reliability), `scripts/contract-replay.ts` to rebuild from journals.                                                |
| 5     | `lib/verdict.ts`: market P = ask + fee per contract, edge both sides, gating with explicit NO TRADE reasons; raw-score percentage removed from headline.                                                                      |
| 6     | `lib/contractPaper.ts`, `ExitPolicy` interface, labelled placeholder policy + ratchet, journal tables, metrics.                                                                                                               |
| 7     | `components/kalshi-strip.tsx`, `components/kalshi-tab.tsx`, new tab; mobile check; docs and README section.                                                                                                                   |

## 5. Questions for the owner (answers change the build)

1. **Panic-fade definition.** Do you have a written definition from your research (trigger size, time window, what counts as exhaustion, which part of the window)? If not, I'll ship the configurable default in the prompt.
2. **Your exit rules.** The stop-loss / profit-taking rules by phase and the ratchet levels. If you don't have them handy, I'll ship a clearly labelled placeholder and a TODO, as specified.
3. **Kalshi API key.** Do you want to create one now (faster WebSocket quotes), or start on public REST polling? Either works.
4. **Fee precision.** If you have a recent Kalshi fill receipt, its fee lets me confirm the $0.01 rounding. Otherwise it stays as the configurable default.

## Sources

- Kalshi API, series `KXBTC15M` and markets (public endpoints, read 2026-11-13): https://api.elections.kalshi.com/trade-api/v2/series/KXBTC15M
- Kalshi contract terms (linked from the series): https://assets.kalshi.com/contract_terms/CRYPTO.pdf
- Kalshi API keys and signing: https://docs.kalshi.com/getting_started/api_keys
- Kalshi WebSocket quick start: https://docs.kalshi.com/getting_started/quick_start_websockets
- Kalshi ticker channel: https://docs.kalshi.com/websockets/market-ticker
- Kalshi fee rounding: https://docs.kalshi.com/getting_started/fee_rounding
- Kalshi fee schedule (July 7, 2026): https://kalshi.com/docs/kalshi-fee-schedule.pdf
- Kalshi rate limits: https://docs.kalshi.com/getting_started/rate_limits
