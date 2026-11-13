import { describe, it, expect } from "vitest";
import { calibrate, type Row } from "../lib/calibration";
import { decide, marketCost, type VerdictInput } from "../lib/verdict";
import type { ContractQuote, EngineReading } from "../lib/types";
const rand = (seed: number) => () =>
  ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
// A strongly informative history for fade in 5–2m; momentum has none.
const r = rand(5),
  rows: Row[] = Array.from({ length: 600 }, (_, i) => {
    const x = r() * 2 - 1;
    return {
      window: i * 900000,
      bucket: "5–2m",
      scores: { fade: x, momentum: x },
      y: r() < 0.5 + 0.45 * x ? 1 : 0,
      official: true,
    };
  }),
  cfg = { minN: 200, refitEvery: 4, recentN: 100 },
  fadeCell = calibrate(rows, "fade", "5–2m", cfg),
  momentumCell = calibrate(rows.slice(0, 150), "momentum", "5–2m", cfg);
const reading = (state: EngineReading["state"], score: number) => ({
  engine: "x",
  state,
  score,
  reason: "",
});
const quote = (yesAsk: number, noAsk: number) =>
  ({
    yesAsk,
    noAsk,
    yesBid: yesAsk - 0.01,
    noBid: noAsk - 0.01,
  }) as ContractQuote;
const base: VerdictInput = {
  bucket: "5–2m",
  readings: { momentum: reading("DOWN", -0.4), fade: reading("UP", 0.9) },
  cells: [fadeCell, momentumCell],
  quote: quote(0.5, 0.52),
  quoteFresh: true,
  coinbaseFresh: true,
  confirmation: "CONFIRMED",
  contracts: 10,
  fees: { rate: 0.07, multiplier: 1, precision: 0.01 },
  minEdge: 0.03,
};
describe("verdict gating", () => {
  it("market probability is the ask plus the per-contract fee", () => {
    const c = marketCost(0.39, 10, base.fees);
    expect(c.fee).toBe(0.017);
    expect(c.cost).toBeCloseTo(0.407, 10);
  });
  it("buys the side with edge from the calibrated engine and names the disagreement", () => {
    expect(fadeCell.status).toBe("CALIBRATED");
    const { verdict, engines } = decide(base);
    expect(verdict).toMatchObject({
      action: "BUY YES",
      side: "UP",
      engine: "fade",
    });
    expect(verdict.edge!).toBeGreaterThanOrEqual(0.03);
    expect(verdict.disagreement).toBe(
      "Momentum DOWN / Panic-Fade UP — Panic-Fade has the better Brier in this bucket",
    );
    const fade = engines.find((e) => e.name === "fade")!;
    expect(fade.up.edge! + fade.up.marketP!).toBeCloseTo(fade.p!);
    expect(fade.down.modelP).toBeCloseTo(1 - fade.p!);
  });
  it("NO TRADE when no engine is calibrated in the bucket", () => {
    const { verdict } = decide({ ...base, cells: [momentumCell] });
    expect(verdict.action).toBe("NO TRADE");
    expect(verdict.reasons.join()).toContain("panic-fade uncalibrated in 5–2m");
    expect(verdict.disagreement).toContain("neither is calibrated");
  });
  it("NO TRADE when edge after fees is below MIN_EDGE", () => {
    const { verdict } = decide({ ...base, quote: quote(0.97, 0.99) });
    expect(verdict.action).toBe("NO TRADE");
    expect(verdict.reasons.join()).toMatch(/edge -?\d\.\d\d < 0\.03/);
  });
  it("NO TRADE when Kalshi, Coinbase or confirmation are stale", () => {
    expect(decide({ ...base, quoteFresh: false }).verdict.reasons).toContain(
      "Kalshi stale",
    );
    expect(decide({ ...base, coinbaseFresh: false }).verdict.action).toBe(
      "NO TRADE",
    );
    expect(
      decide({ ...base, confirmation: "DIVERGENT" }).verdict.reasons,
    ).toContain("Confirmation divergent");
  });
});
