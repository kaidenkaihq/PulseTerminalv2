import type {
  Candle,
  Direction,
  Outcome,
  Forecast,
  Projection,
  Sample,
  Trade,
  Pressure,
} from "./types";
export const direction = (move: number, price: number): Direction =>
  Math.abs(move) / price < 0.00002 ? "FLAT" : move > 0 ? "UP" : "DOWN";
export const fresh = (
  time: number | undefined,
  now: number,
  threshold = 5000,
) => time !== undefined && now - time >= -1000 && now - time <= threshold;
export const boundary = (time: number, seconds: number) =>
  Math.floor(time / (seconds * 1000)) * seconds * 1000;
export const clamp = (n: number, lo = -1, hi = 1) =>
  Math.max(lo, Math.min(hi, n));
// OLS against seconds relative to the first observation. Samples are once/second, never tick weighted.
export function velocity(
  samples: Sample[],
  now: number,
  seconds: number,
): number | null {
  const s = samples.filter(
    (p) => p.time <= now && p.time >= now - seconds * 1000,
  );
  if (
    s.length < Math.max(5, seconds * 0.7) ||
    s.at(-1)!.time - s[0].time < seconds * 1000 * 0.7 ||
    !fresh(s.at(-1)?.time, now)
  )
    return null;
  const x = s.map((p) => (p.time - s[0].time) / 1000),
    mx = x.reduce((a, b) => a + b, 0) / s.length,
    my = s.reduce((a, b) => a + b.price, 0) / s.length;
  const denominator = x.reduce((a, b) => a + (b - mx) ** 2, 0);
  return denominator
    ? s.reduce((a, p, i) => a + (x[i] - mx) * (p.price - my), 0) / denominator
    : null;
}
export function project(samples: Sample[], now: number): Projection | null {
  const v10 = velocity(samples, now, 10),
    v30 = velocity(samples, now, 30),
    previous = velocity(samples, now - 5000, 10),
    last = samples.filter((s) => s.time <= now).at(-1);
  if (
    v10 === null ||
    v30 === null ||
    previous === null ||
    !last ||
    !fresh(last.time, now)
  )
    return null;
  const move = v10 * 20;
  return {
    price: last.price,
    velocity10: v10,
    velocity30: v30,
    acceleration: (v10 - previous) / 5,
    projected: last.price + move,
    move,
    percent: (move / last.price) * 100,
    direction: direction(move, last.price),
  };
}
export function evaluate(f: Forecast, sample: Sample): Outcome {
  const due = f.created + f.horizon * 1000;
  if (sample.time < due)
    throw new Error("Cannot resolve a forecast before its horizon");
  if (sample.time > due + 2000)
    return {
      id: f.id,
      evaluated: sample.time,
      actual: null,
      realized: null,
      correct: null,
      absoluteError: null,
      percentageError: null,
      status: "MISSED",
    };
  const realized = sample.price - f.starting,
    error = Math.abs(sample.price - f.projected);
  return {
    id: f.id,
    evaluated: sample.time,
    actual: sample.price,
    realized,
    correct:
      direction(realized, f.starting) ===
      direction(f.projected - f.starting, f.starting),
    absoluteError: error,
    percentageError: (error / sample.price) * 100,
    status: "COMPLETE",
  };
}
export const aggressor = (maker: "buy" | "sell") =>
  maker === "buy" ? "sell" : "buy";
export function pressure(
  trades: Trade[],
  now: number,
  seconds: number,
  cvd: number,
  started: number,
): Pressure {
  const s = trades.filter(
    (t) => t.time <= now && t.time > now - seconds * 1000,
  );
  const buy = s
      .filter((t) => t.side === "buy")
      .reduce((a, t) => a + t.price * t.size, 0),
    sell = s
      .filter((t) => t.side === "sell")
      .reduce((a, t) => a + t.price * t.size, 0);
  const recent = s.filter((t) => t.time > now - seconds * 500),
    prior = s.filter((t) => t.time <= now - seconds * 500);
  const signed = (ts: Trade[]) =>
    ts.reduce((a, t) => a + (t.side === "buy" ? 1 : -1) * t.price * t.size, 0) /
    Math.max(
      1,
      ts.reduce((a, t) => a + t.price * t.size, 0),
    );
  return {
    buy,
    sell,
    delta: buy - sell,
    cvd,
    buyPercent: buy + sell ? (buy / (buy + sell)) * 100 : null,
    trend:
      prior.length && recent.length ? signed(recent) - signed(prior) : null,
    count: s.length,
    coverage: clamp((now - started) / (seconds * 1000), 0, 1),
  };
}
export function ema(values: number[], period: number): number[] {
  let value = values[0];
  return values.map(
    (v, i) => (value = i ? value + ((v - value) * 2) / (period + 1) : v),
  );
}
export function atr(c: Candle[], period = 14): number | null {
  if (c.length < period + 1) return null;
  let value = 0;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close),
    );
    if (i <= period) value += tr / period;
    else value = (value * (period - 1) + tr) / period;
  }
  return value;
}
export function supertrend(
  c: Candle[],
  period = 14,
  multiplier = 3,
): { value: number; bullish: boolean } | null {
  if (c.length < period + 2) return null;
  let upper = 0,
    lower = 0,
    st = 0,
    bullish = true,
    range = 0;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close),
    );
    if (i <= period) range += tr / period;
    else range = (range * (period - 1) + tr) / period;
    if (i < period) continue;
    const mid = (c[i].high + c[i].low) / 2,
      bu = mid + range * multiplier,
      bl = mid - range * multiplier;
    if (i === period) {
      upper = bu;
      lower = bl;
      st = upper;
      bullish = false;
      continue;
    }
    const pu = upper,
      pl = lower;
    upper = bu < pu || c[i - 1].close > pu ? bu : pu;
    lower = bl > pl || c[i - 1].close < pl ? bl : pl;
    bullish = st === pu ? c[i].close > upper : c[i].close >= lower;
    st = bullish ? lower : upper;
  }
  return { value: st, bullish };
}
export function heikinAshi(c: Candle[]): Candle[] {
  let po = 0,
    pc = 0;
  return c.map((x, i) => {
    const close = (x.open + x.high + x.low + x.close) / 4,
      open = i ? (po + pc) / 2 : (x.open + x.close) / 2;
    po = open;
    pc = close;
    return {
      ...x,
      open,
      close,
      high: Math.max(x.high, open, close),
      low: Math.min(x.low, open, close),
    };
  });
}
