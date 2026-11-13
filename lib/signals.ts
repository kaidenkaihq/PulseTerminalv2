import { atr, boundary, clamp, ema, supertrend } from "./math";
import type {
  BookMetrics,
  Candle,
  Mode,
  Pressure,
  Projection,
  Signal,
} from "./types";
export function wickLean(candles: Candle[], range: number | null) {
  const c = candles.slice(-4);
  if (c.length < 4 || !range)
    return { score: null, label: "INSUFFICIENT DATA", candles: [] };
  const contributions = c.map((x, i) => {
    const r = x.high - x.low,
      body = Math.abs(x.close - x.open),
      upper = x.high - Math.max(x.open, x.close),
      lower = Math.min(x.open, x.close) - x.low;
    const score = r
      ? clamp((lower - upper) / r) *
        clamp(r / range, 0, 1) *
        clamp((lower + upper) / (body + range * 0.1), 0, 1)
      : 0;
    return {
      time: x.time,
      score,
      upper: r ? upper / r : 0,
      lower: r ? lower / r : 0,
      weight: i + 1,
    };
  });
  const score = contributions.reduce((s, x) => s + x.score * x.weight, 0) / 10;
  return {
    score,
    label:
      score > 0.15
        ? "BULLISH REJECTION"
        : score < -0.15
          ? "BEARISH REJECTION"
          : "NEUTRAL / AMBIGUOUS",
    candles: contributions,
  };
}
export function scoreFeatures(features: Record<string, number | null>) {
  const weights: Record<string, number> = {
    momentum: 0.25,
    aggressor: 0.25,
    book: 0.2,
    trend: 0.2,
    wick: 0.1,
  };
  let score = 0,
    coverage = 0;
  for (const [key, w] of Object.entries(weights))
    if (features[key] !== null && features[key] !== undefined) {
      score += clamp(features[key]!) * w;
      coverage += w;
    }
  return {
    score: coverage ? score / coverage : null,
    coverage: Math.round(coverage * 100) / 100,
  };
}
export function signal(
  c: Candle[],
  now: number,
  mode: Mode,
  p: Projection | null,
  flow: Pressure,
  book: BookMetrics | null,
  period = 14,
  multiplier = 3,
): Signal {
  const closed = c.filter((x) => x.complete && x.time + 900000 <= now),
    a = atr(closed, period),
    prices = closed.map((x) => x.close),
    e9 = closed.length >= 9 ? ema(prices, 9).at(-1)! : null,
    e20 = closed.length >= 20 ? ema(prices, 20).at(-1)! : null,
    st = supertrend(closed, period, multiplier),
    wick = wickLean(closed, a),
    recent = closed.slice(-6);
  const aligned =
    e9 !== null && e20 !== null && st
      ? e9 > e20 && st.bullish
        ? 1
        : e9 < e20 && !st.bullish
          ? -1
          : 0
      : null;
  const features = {
    momentum: p && a ? clamp((p.velocity30 * 30) / a) : null,
    aggressor:
      flow.buyPercent !== null && flow.coverage >= 0.95
        ? (flow.buyPercent - 50) / 50
        : null,
    book: book?.imbalance ?? null,
    trend: aligned,
    wick: wick.score,
  };
  const { score, coverage } = scoreFeatures(features);
  const ready =
    closed.length >= Math.max(period + 2, 21) &&
    closed.at(-1)?.time === boundary(now, 900) - 900000 &&
    closed
      .slice(-21)
      .every((x, i, arr) => !i || x.time - arr[i - 1].time === 900000) &&
    p !== null &&
    coverage >= 0.95;
  const state = !ready
    ? "INSUFFICIENT DATA"
    : score! > 0.22 &&
        aligned === 1 &&
        features.momentum! > 0 &&
        features.aggressor! > 0
      ? "LONG"
      : score! < -0.22 &&
          aligned === -1 &&
          features.momentum! < 0 &&
          features.aggressor! < 0
        ? "SHORT"
        : "NEUTRAL";
  return {
    id: `${mode}-${closed.at(-1)?.time ?? now}`,
    time: now,
    mode,
    state,
    score: ready ? score : null,
    coverage,
    features,
    reason: !ready
      ? "Waiting for 21 contiguous closed 15m candles, fresh regression, full order-flow window and book coverage."
      : state === "NEUTRAL"
        ? "Filters do not agree. Wait for trend, momentum and executed volume alignment."
        : `${state} alignment: completed-candle trend, momentum and aggressor volume agree.`,
    atr: a,
    reference: p?.price ?? null,
    ema9: e9,
    ema20: e20,
    supertrend: st?.value ?? null,
    swingHigh: recent.length ? Math.max(...recent.map((x) => x.high)) : null,
    swingLow: recent.length ? Math.min(...recent.map((x) => x.low)) : null,
  };
}
