# Calculation methodology · v1

## Price extrapolation

Exchange timestamps are parsed to UTC milliseconds. Once per second the worker samples the most recent fresh Coinbase price; a burst of ticks cannot dominate the regression. There must be at least 70% sample coverage over both 10s and 30s, at least 70% elapsed span, five observations minimum, and a usable 10s window ending 5s earlier. A gap in the worker sampling clock exceeding 2s clears regressions. Market data older than the configured 5s limit cannot publish projections.

OLS velocity is `sum((t-mean(t))*(price-mean(price))) / sum((t-mean(t))²)`, with t in seconds. Acceleration is `(velocity10(now) - velocity10(now−5s)) / 5`. Baseline projection is **current + velocity10 × 20**; acceleration is displayed separately and is not included in the model. UP/DOWN/FLAT uses a 0.002% flat tolerance, applied equally to predictions and realizations.

Every 10s a forecast captures UTC creation time, starting and extrapolated prices, 20s horizon, `ols10-v1`, input features, descriptive velocity regime, mode and freshness. The first subsequently observed exchange price at or after the deadline resolves the forecast, with a maximum 2s late tolerance. No qualifying observation means MISSED, excluded from numerical errors and directional accuracy. Signed realized movement is actual minus starting price; absolute error is |actual−projected|; percentage error uses actual as denominator. The ledger keeps original inputs; resolution never changes forecasts.

## Flow and liquidity

Coinbase match `side` is the maker side: sell maker means buy aggressor; buy maker means sell aggressor. A bounded ID set deduplicates matches. Executed volume is USD notional `size × price`; 20s/60s buy% is buy notional divided by total notional. Delta is buy−sell. CVD accumulates signed notional since this process session began; it is not reconstructed across downtime. Pressure trend compares signed notional ratios in the most recent and previous half-windows. The UI reports actual window coverage; strategy filters require a full 60s window.

Resting liquidity uses the nearest 20 bids and 20 asks. Imbalance is `(bidNotional−askNotional)/(bidNotional+askNotional)`; spread is best ask−best bid. Coinbase updates are **absolute sizes**, not additive deltas; zero removes a level. Reconnects reset the book until a new snapshot. Out-of-order book updates are skipped. Size validation and a hard 100,000-level cap per side prevent unbounded growth. Crossed, empty and stale books return no feature. Executed pressure and resting imbalance are distinct measurements; neither is a probability.

## Candles and strategy

UTC bucket starts are `floor(epochMs / durationMs) × durationMs` for 60s and 900s. Historical REST responses warm up closed candles. Live ticks update OHLC, BTC volume and signed USD delta. A candle partially collected at startup or across a detected gap is withheld from closed-signal features until REST backfill replaces it. Historical backfill runs every minute, never inserts a future candle, and does not invent historical aggressor delta.

EMA9/20 use recursive alpha `2/(period+1)`, seeded with the first close. ATR14 uses Wilder true range and smoothing, seeded by the first 14 true ranges after a prior close. SuperTrend uses ATR bands around HL2, persistent final bands and close-based band reversals. Warmup requires at least max(ATR period+2,21) contiguous closed 15m candles including the most recently due candle. Swing structure displays the last six closed candles' high/low extremes; it is not a future-confirmed pivot detector.

Feature scores in [−1,+1]:

| Feature          | Weight | Normalization                                                        |
| ---------------- | ------ | -------------------------------------------------------------------- |
| Momentum         | 25%    | clamp(30s velocity × 30 / 15m ATR)                                   |
| Aggressor volume | 25%    | (60s buy%−50)/50; full window required                               |
| Book             | 20%    | Nearest-20-level notional imbalance                                  |
| Trend alignment  | 20%    | +1 if EMA9>EMA20 and SuperTrend bullish; −1 for both bearish; else 0 |
| Wick rejection   | 10%    | Four-candle weighted rejection described below                       |

Scores are weighted and divided by available weight; active signals require at least 95% weight coverage, fresh projection inputs and contiguous completed candles. LONG additionally requires score>0.22, bullish trend, positive momentum and positive aggressor delta; SHORT requires score<−0.22 and all three opposite filters. Otherwise NEUTRAL. Missing required coverage produces INSUFFICIENT DATA. Only one direction can be active. Signal transitions are recorded with their original feature values; realtime flow may change state inside a candle, while all candle-derived features remain fixed until candle close.

Scenario entry is the current reference price, stop distance 1.5×ATR and target distance 3×ATR (nominal 1:2 before execution costs). These are informational, continuously refreshed scenarios, not guaranteed fill or exit prices. Auto paper entries freeze these values at entry and allow one entry per signal candle. Directional scenario score is `(1 ± signedScore)/2 × 100`; it is a heuristic visualization, not a calibrated probability.

## Wick lean

For the last four fully closed 15m candles: upper wick = high−max(open,close), lower = min(open,close)−low, body = |close−open|, range = high−low. Each rejection contribution is `clamp((lower−upper)/range) × clamp(range/ATR,0,1) × clamp((lower+upper)/(body+0.1×ATR),0,1)`. Weights are 1,2,3,4, divided by 10. Above +0.15 indicates bullish rejection, below −0.15 bearish; otherwise ambiguous. The visualization highlights contributing wick points. Wick alone never activates a trade.

## Breadth and independent confirmation

The configured Coinbase crypto watchlist uses each pair's latest fresh price and an actually observed anchor within ±1s of T−20s. No interpolation. Rising/falling tolerance is ±0.002%. At least 70% of configured pairs and at least six must have both a fresh price and usable anchor. Breadth = (rising−falling)/eligible markets. Above +0.25 is RISK-ON, below −0.25 RISK-OFF, otherwise MIXED. Missing coverage means INSUFFICIENT DATA. Only crypto is covered.

Confirmation compares Coinbase BTC-USD and Kraken BTC/USD last prices. Absolute price divergence is divided by Coinbase price, expressed as percent. Both prices must be fresh within 5s and divergence ≤0.20%. Kraken trades carry exchange timestamps; trade-triggered ticker updates carry receipt timestamps because the ticker schema supplies no exchange timestamp. Subscription snapshots never refresh freshness. Confirmation is price agreement, not directional corroboration or a trade guarantee. Replay has no independent Kraken price.

## Simulation and metrics

Long fills slip upward on entry and downward on exit; shorts reverse that convention. Fees charge notional at both fills. Net P&L = signed size×(exit−entry)−entry fee−exit fee. Balance deducts the entry fee immediately; equity adds unrealized mark-to-market P&L and estimates exit fees. Notional plus entry fee cannot exceed virtual balance. Stops/targets execute at the **next observed price**, so gaps can produce losses larger than the nominal stop. The simulation does not model queue position, partial fills, borrow fees, funding or real exchange liquidation.

Realized R = net P&L / frozen initial stop risk. Maximum drawdown measures observed equity decline from the running peak. Daily P&L is realized net trade P&L by UTC close date. 15m hit rate counts profitable closed **signal-linked** opt-in auto paper trades, not manual trades. Zero trades means insufficient data. Forecast analytics include completed sample size, mean/median error, directional accuracy and descriptive velocity regime. Overlapping 20s forecasts are dependent. No metric constitutes a validated trading edge or calibrated win probability.

# Contract methodology · v2 (Kalshi KXBTC15M)

Facts below were read from Kalshi's own API and documentation on 2026-11-13; see `docs/V2_PLAN.md` for the verbatim rule text.

## Contract, window and resolution

- Series `KXBTC15M`. The active market is discovered with the public `GET /trade-api/v2/markets?series_ticker=KXBTC15M&status=open`; open/close times come from the API, never from ticker text (tickers embed US Eastern time).
- Windows are `[open, open + 15m)` and coincide with our UTC `floor(epochMs / 900000)` buckets.
- **Strike** = Kalshi `floor_strike`: the simple average of 60 seconds of CF Benchmarks BRTI before `open`. **Settle** = the same average before `close`. **YES (UP) iff settle ≥ strike**, both rounded to 2 dp; ties resolve UP.
- **Settlement index is CF Benchmarks BRTI, not Coinbase.** BRTI is not observable here in real time. The **proxy** is the per-second mean of fresh Coinbase BTC-USD and Kraken BTC/USD prices (Coinbase alone when Kraken is stale, recorded as `CB`). The proxy strike/settle is the mean of observed proxy seconds in the same 60s span, and needs at least 45 of 60.
- **Basis** is measured where the official value is observable: `floor_strike − proxy strike` at each open, and `expiration_value − proxy settle` at each settlement.

## Feed

- Without a key the worker polls the public market endpoint once per second. With `KALSHI_API_KEY_ID` + `KALSHI_PRIVATE_KEY_PATH` it also opens the authenticated WebSocket `ticker` channel (`wss://external-api-ws.kalshi.com/trade-api/ws/v2`).
- Signing follows the Kalshi API Keys doc: the signed string is `timestamp(ms) + METHOD + path` (path includes `/trade-api/v2`, excludes the query string). RSA keys use RSA-PSS, SHA-256, MGF1-SHA-256 and a salt equal to the digest length. Ed25519 keys sign directly.
- The WS ticker carries YES top of book only. NO bid = 1 − YES ask; NO ask = 1 − YES bid.
- Quote freshness is receipt age ≤ `KALSHI_FRESHNESS_MS` (5s). REST polling refreshes it every second even when the book is unchanged.
- Official results are polled from `GET /markets/{ticker}` from close + 4s until `result` is `yes`/`no` (Kalshi typically settles about 5s after close), giving up after an hour.
- No order endpoint exists in the codebase.

## Fees

Kalshi quadratic fee (series `fee_type: quadratic`, `fee_multiplier` read live): `fee = ceil(KALSHI_FEE_RATE × multiplier × C × P × (1 − P))` to `KALSHI_FEE_PRECISION`. The defaults are 0.07 and $0.01 (non-direct member). Rounding is per order, not per contract. Example: 10 × $0.39 → $0.17. There is no settlement fee. Simulated entries pay the ask (taker); early exits receive the bid minus the same fee. Flag: the official fee-schedule PDF could not be fetched directly (bot checkpoint), so the formula was confirmed from Kalshi's indexed copy plus the Fee Rounding doc. Confirm the precision against a real fill.

## Snapshots, outcomes and independence

- Every observed second writes a `contract_snapshot`, which records:
  - window and seconds-to-close (`ttc`);
  - the bucket (default `15–10m`, `10–5m`, `5–2m`, `2–0m`; a bucket covers `(lower, upper]` seconds);
  - strike and source, and proxy price and source;
  - distance in $, % and 15m-ATR units;
  - all existing features (10s/30s velocity, acceleration, 20s/60s buy %, CVD slope as the 60s OLS of session CVD in $/s, book imbalance and spread, trend alignment, wick, breadth, confirmation and feed ages);
  - Kalshi quotes, and every engine's raw reading and configuration.
- Per-second snapshots go to `ticks-*.jsonl` (local only, `CONTRACT_TICK_RETENTION_DAYS`, default 30).
- The **first eligible second of each window × bucket** is the window's metric sample. Eligible means the strike is known and Coinbase is fresh. That sample goes to the long-lived journal and Supabase. **n counts windows, not seconds.**
- At close + 1s each observed window gets one immutable `contract_outcome`: the proxy settle vs the strike, or `MISSED` if the closing minute or the strike was not observed. The official Kalshi result is stored separately as a `contract_settlement`. Metrics use the official result when present; proxy/official mismatches are counted and shown.

## Engines (never averaged)

- **momentum-v1** is the unchanged 15m composite from `lib/signals.ts`. Its raw score is in [−1, +1]; LONG/SHORT map to UP/DOWN.
- **fade-v1** (`lib/fade.ts`). Default thresholds are configurable and recorded in every snapshot. Inputs are only seconds at or before `now`.
  - σ is the root-mean-square of the last `FADE_LOOKBACK_MIN` (15) one-minute log returns of the proxy. It needs 80% second coverage and 70% of the returns.
  - `z = ln(p_now / p_{now−FADE_WINDOW_S}) / (σ × √(FADE_WINDOW_S/60))`.
  - Trigger: `|z| ≥ FADE_SIGMA` (2.5) **and** `FADE_TTC_MIN ≤ ttc ≤ FADE_TTC_MAX` (30–600s).
  - Exhaustion is either of:
    - The 10s aggressor share in the move's direction peaked at ≥ 55% inside the move window and has since fallen by ≥ `FADE_EXHAUSTION` (25%, relative).
    - Book imbalance has flipped against the move, with |imbalance| ≥ 0.1.
  - Direction is opposite the move. Magnitude = `0.5 × min(1, |z| / 2σ) + 0.5 × exhaustion strength`, in [0, 1].
  - No trigger scores 0 (`NO SETUP`). Stale or short history gives `INSUFFICIENT DATA` (null).

## Calibration (`calib-isotonic-v1`)

- Per engine × bucket, raw score → P(UP) is fitted on completed windows. Isotonic regression (pool-adjacent-violators) is used from 100 training windows. Below that, 1-D logistic (Platt) regression. Below 20, no model. Predictions are clipped to [0.01, 0.99].
- **Walk-forward:** window _i_ is predicted by a model fit only on windows before the latest scheduled refit, which happens every `CALIBRATION_REFIT_EVERY` (4) windows.
- Out-of-sample metrics:
  - n windows and hit rate (P ≥ 0.5 → UP);
  - Brier score and log loss;
  - reliability deciles;
  - baseline Brier, which predicts the training base rate;
  - recent Brier over the last `CALIBRATION_RECENT_N` (100).
- **CALIBRATED** requires n ≥ `CALIBRATION_MIN_N` (200) **and** out-of-sample Brier < baseline. Otherwise the cell is `UNCALIBRATED (n=…)` and cannot drive a verdict.
- The live probability comes from a model fit on all completed windows.
- `npm run contracts:rebuild` re-scores fade from logged seconds with the current `.env` thresholds and recomputes calibration offline.

## Edge and verdict

- Market probability for UP = YES ask + fee per contract (at `CONTRACT_SIZE`). For DOWN it is NO ask + fee.
- Edge(side) = calibrated P(side) − market probability. It is shown for both sides.
- Verdict:
  - Among CALIBRATED engines in the current bucket, take the one with the lowest recent out-of-sample Brier.
  - Its better side must have edge ≥ `MIN_EDGE` (0.03).
  - Kalshi, Coinbase and confirmation must all be fresh and CONFIRMED.
  - Otherwise the verdict is **NO TRADE** with every applicable reason.
- Engine disagreement is stated explicitly.
- The old `(1 ± score)/2 × 100` figure is no longer shown. The raw score is labelled "raw score, not a probability".

## Contract paper account

- `lib/contractPaper.ts` is separate from the spot account. It buys YES/NO at the ask plus fee, subject to:
  - `CONTRACT_SIZE` contracts per trade;
  - `CONTRACT_MAX_STAKE` per window;
  - `CONTRACT_MAX_DAILY_LOSS` per UTC day;
  - one position per window.
- Settlement pays $1 per contract on the winning side and $0 otherwise, with no fee.
- Exits use `ExitPolicy` (`owner-exit-v1`):
  - **Take profit when the held side's bid ≥ 97¢** (owner rule, always on).
  - Phase stop-losses (`CONTRACT_EXIT_PHASES`, `ttc:stopBid`) and ratchet floors (`CONTRACT_RATCHET`, `peakTrigger:floor`) are **placeholders until the owner supplies them**. They are empty by default, so positions otherwise hold to settlement.
- Auto entries follow the verdict, require opt-in, and reset to manual on restart.
- If no official result arrives within an hour, the position settles on the proxy result and is labelled as such.
- Metrics: P&L, P&L per contract, hit rate, average edge at entry vs realized P&L per contract, and splits by engine and bucket.

## Official references (v2)

- Kalshi series and markets API (public): https://api.elections.kalshi.com/trade-api/v2/series/KXBTC15M
- Kalshi API keys and request signing: https://docs.kalshi.com/getting_started/api_keys
- Kalshi WebSocket quick start: https://docs.kalshi.com/getting_started/quick_start_websockets
- Kalshi ticker channel: https://docs.kalshi.com/websockets/market-ticker
- Kalshi fee rounding: https://docs.kalshi.com/getting_started/fee_rounding
- Kalshi fee schedule: https://kalshi.com/docs/kalshi-fee-schedule.pdf
- Kalshi rate limits: https://docs.kalshi.com/getting_started/rate_limits
- Contract terms (crypto): https://assets.kalshi.com/contract_terms/CRYPTO.pdf
