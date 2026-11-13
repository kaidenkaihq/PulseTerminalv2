import { describe, it, expect } from "vitest";
import {
  aggressor,
  atr,
  boundary,
  ema,
  evaluate,
  fresh,
  heikinAshi,
  pressure,
  project,
  supertrend,
  velocity,
} from "../lib/math";
import { OrderBook } from "../lib/book";
import { CandleSeries } from "../lib/candles";
import { PaperAccount } from "../lib/paper";
import { scoreFeatures, signal, wickLean } from "../lib/signals";
import type { Candle, Forecast, Trade } from "../lib/types";
const samples = Array.from({ length: 61 }, (_, i) => ({
  time: 100000 + i * 1000,
  price: 10000 + 2 * i,
}));
const candles: Candle[] = Array.from({ length: 40 }, (_, i) => ({
  time: i * 900000,
  open: 100 + i * 3,
  high: 105 + i * 3,
  low: 98 + i * 3,
  close: 103 + i * 3,
  volume: 10,
  delta: 0,
  complete: true,
}));
const trade = (
  time: number,
  side: "buy" | "sell",
  price = 100,
  size = 2,
): Trade => ({ time, side, price, size, id: `${time}`, symbol: "BTC-USD" });
describe("regression and horizon", () => {
  it("OLS recovers dollars/second independent of price origin", () => {
    expect(velocity(samples, 160000, 10)).toBeCloseTo(2);
    expect(velocity(samples, 160000, 30)).toBeCloseTo(2);
  });
  it("linear acceleration is zero and quadratic acceleration is correct", () => {
    expect(project(samples, 160000)?.acceleration).toBeCloseTo(0);
    const curved = samples.map((s, i) => ({ ...s, price: 10000 + i * i }));
    expect(project(curved, 160000)?.acceleration).toBeCloseTo(2);
  });
  it("projects exactly twenty seconds without adding acceleration", () => {
    const p = project(samples, 160000)!;
    expect(p.projected).toBe(10160);
    expect(p.move).toBe(40);
  });
  it("rejects sparse, stale and future samples", () => {
    expect(project(samples.slice(0, 4), 160000)).toBeNull();
    expect(project(samples, 180000)).toBeNull();
    expect(velocity(samples, 105000, 30)).toBeNull();
  });
  it("resolves only observed horizons and excludes missed horizons", () => {
    const features = project(samples, 160000)!;
    const f: Forecast = {
      id: "test",
      created: 160000,
      starting: 10120,
      projected: 10160,
      horizon: 20,
      model: "ols10-v1",
      mode: "replay",
      freshness: 0,
      features,
      regime: "LOW",
    };
    expect(() => evaluate(f, { time: 179999, price: 10150 })).toThrow();
    const o = evaluate(f, { time: 180000, price: 10150 });
    expect(o.correct).toBe(true);
    expect(o.absoluteError).toBe(10);
    expect(evaluate(f, { time: 183000, price: 10150 }).status).toBe("MISSED");
  });
});
describe("executed flow and book", () => {
  it("inverts Coinbase maker side", () => {
    expect(aggressor("sell")).toBe("buy");
    expect(aggressor("buy")).toBe("sell");
  });
  it("uses notional weighting and excludes future trades", () => {
    const p = pressure(
      [
        trade(9000, "buy", 100, 2),
        trade(9500, "sell", 100, 1),
        trade(11000, "sell", 100, 100),
      ],
      10000,
      20,
      100,
      0,
    );
    expect(p.buyPercent).toBeCloseTo((200 / 300) * 100);
    expect(p.delta).toBe(100);
  });
  it("reconciles absolute quantities, zero deletes and resets snapshots", () => {
    const b = new OrderBook();
    b.update([["buy", "99", "1"]], 100);
    expect(b.metrics(100)).toBeNull();
    b.snapshot([["99", "2"]], [["101", "1"]], 100);
    expect(b.metrics(100)?.spread).toBe(2);
    b.update(
      [
        ["buy", "99", "0"],
        ["buy", "100", "3"],
      ],
      200,
    );
    expect(b.metrics(200)?.bid).toBe(100);
    expect(b.bids.has(99)).toBe(false);
    b.snapshot([["98", "1"]], [["102", "1"]], 300);
    expect(b.bids.has(100)).toBe(false);
    expect(b.metrics(6000)).toBeNull();
  });
  it("rejects crossed books and out-of-order changes", () => {
    const b = new OrderBook();
    b.snapshot([["101", "1"]], [["100", "1"]], 200);
    expect(b.metrics(200)).toBeNull();
    b.update([["buy", "101", "1"]], 200);
    b.update([["buy", "101", "0"]], 100);
    expect(b.bids.has(101)).toBe(true);
  });
  it("freshness rejects old and far-future times", () => {
    expect(fresh(5000, 10000)).toBe(true);
    expect(fresh(4999, 10000)).toBe(false);
    expect(fresh(12000, 10000)).toBe(false);
  });
});
describe("completed candles and indicators", () => {
  it("uses UTC 15m boundaries exactly", () => {
    expect(boundary(Date.parse("2026-01-01T00:14:59.999Z"), 900)).toBe(
      Date.parse("2026-01-01T00:00:00Z"),
    );
    expect(boundary(Date.parse("2026-01-01T00:15:00Z"), 900)).toBe(
      Date.parse("2026-01-01T00:15:00Z"),
    );
  });
  it("builds OHLC and closes only after boundary", () => {
    const c = new CandleSeries(900);
    c.seed([{ ...candles[0], time: -900000 }], 0);
    c.add(trade(1000, "buy", 100));
    c.add(trade(2000, "sell", 105));
    expect(c.closed(899999)).toHaveLength(1);
    expect(c.closed(900000).at(-1)).toMatchObject({
      open: 100,
      high: 105,
      low: 100,
      close: 105,
      volume: 4,
    });
    c.add(trade(900000, "buy", 110));
    expect(c.candles).toHaveLength(3);
  });
  it("warms up ATR and SuperTrend and produces finite results", () => {
    expect(atr(candles.slice(0, 14))).toBeNull();
    expect(supertrend(candles.slice(0, 14))).toBeNull();
    expect(atr(candles)).toBeCloseTo(7);
    expect(supertrend(candles)?.bullish).toBe(true);
    expect(ema([10, 10, 10], 2)).toEqual([10, 10, 10]);
  });
  it("ignores open and future candles for closed-confirmation features", () => {
    const now = 40 * 900000,
      p = project(samples, 160000)!,
      flow = pressure([], now, 60, 0, 0);
    const a = signal(candles, now, "replay", p, flow, null),
      b = signal(
        [
          ...candles,
          { ...candles[0], time: now, close: 1000000, complete: false },
        ],
        now,
        "replay",
        p,
        flow,
        null,
      );
    expect(a.ema20).toBe(b.ema20);
    expect(a.supertrend).toBe(b.supertrend);
    expect(a.state).toBe("INSUFFICIENT DATA");
  });
  it("wick rejection is recency weighted and normalized", () => {
    const c = candles
      .slice(0, 4)
      .map((c) => ({ ...c, open: 108, close: 109, high: 110, low: 100 }));
    const w = wickLean(c, 10);
    expect(w.score).toBeGreaterThan(0.15);
    expect(w.candles.map((x) => x.weight)).toEqual([1, 2, 3, 4]);
  });
  it("Heikin Ashi uses only prior transformed candle", () => {
    const a = heikinAshi(candles.slice(0, 4)),
      b = heikinAshi([...candles.slice(0, 4), { ...candles[4], close: 1e9 }]);
    expect(a).toEqual(b.slice(0, 4));
  });
  it("scores all normalized weights and tracks missing coverage", () => {
    expect(
      scoreFeatures({ momentum: 1, aggressor: 1, book: 1, trend: 1, wick: 1 }),
    ).toEqual({ score: 1, coverage: 1 });
    expect(
      scoreFeatures({
        momentum: 99,
        aggressor: null,
        book: null,
        trend: null,
        wick: null,
      }),
    ).toEqual({ score: 1, coverage: 0.25 });
  });
});
describe("paper risk and execution accounting", () => {
  it("charges both fees and adverse slippage on long", () => {
    const p = new PaperAccount(10000);
    p.open("LONG", 1, 100, 90, 120, 1000, "replay");
    expect(p.state.position?.entry).toBeCloseTo(100.02);
    p.close(110, 2000);
    const t = p.state.trades[0];
    expect(t.exit).toBeCloseTo(109.978);
    expect(t.pnl).toBeCloseTo(
      109.978 - 100.02 - 100.02 * 0.0006 - 109.978 * 0.0006,
    );
    expect(p.state.balance).toBeCloseTo(10000 + t.pnl);
    expect(t.rr).toBeCloseTo(t.pnl / t.risk);
  });
  it("supports short gains, rejects excessive size and inverted stops", () => {
    const p = new PaperAccount(1000);
    p.state.feeBps = 0;
    p.state.slippageBps = 0;
    expect(() => p.open("LONG", 20, 100, 90, 120, 0, "replay")).toThrow();
    expect(() => p.open("SHORT", 1, 100, 90, 120, 0, "replay")).toThrow();
    p.open("SHORT", 1, 100, 110, 80, 0, "replay");
    p.close(90, 1000);
    expect(p.state.balance).toBe(1010);
  });
  it("executes gaps at observed price and tracks drawdown", () => {
    const p = new PaperAccount(1000);
    p.state.feeBps = 0;
    p.state.slippageBps = 0;
    p.open("LONG", 1, 100, 90, 120, 0, "replay");
    p.mark(80, 1000);
    expect(p.state.trades[0].reason).toBe("STOP");
    expect(p.state.trades[0].pnl).toBe(-20);
    expect(p.state.maxDrawdown).toBeCloseTo(2);
  });
});
it("excludes a partial startup candle until historical backfill closes its coverage", () => {
  const series = new CandleSeries(900);
  series.add(trade(300000, "buy", 100));
  expect(series.closed(900000)).toHaveLength(0);
  series.seed([{ ...candles[0], open: 90, close: 110 }], 900000);
  expect(series.closed(900000)[0].close).toBe(110);
});
it("does not invalidate fully closed REST history when a connection opens", () => {
  const series = new CandleSeries(900);
  series.seed(candles, 40 * 900000);
  series.markGap();
  expect(series.closed(40 * 900000)).toHaveLength(40);
});
it("activates only the aligned direction and blocks contradictory momentum", () => {
  const now = 40 * 900000,
    p = { ...project(samples, 160000)!, velocity30: 1 },
    flow = {
      ...pressure(
        [trade(now - 1000, "buy", 100, 4), trade(now - 900, "sell", 100, 1)],
        now,
        60,
        0,
        now - 60000,
      ),
      coverage: 1,
    },
    book = { bid: 100, ask: 101, spread: 1, imbalance: 0.8, age: 0, depth: 20 };
  const long = signal(candles, now, "replay", p, flow, book);
  expect(long.state).toBe("LONG");
  const conflict = signal(
    candles,
    now,
    "replay",
    { ...p, velocity30: -1 },
    flow,
    book,
  );
  expect(conflict.state).toBe("NEUTRAL");
});
