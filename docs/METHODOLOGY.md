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
