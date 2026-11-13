import { describe, it, expect } from "vitest";
import {
  calibrate,
  dataset,
  isotonic,
  predict,
  walkForward,
  type Row,
} from "../lib/calibration";
import type { ContractOutcome, ContractSnapshot } from "../lib/types";
// Deterministic pseudo-random sequence so tests never depend on Math.random.
const rand = (seed: number) => () =>
  ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
function synthetic(n: number, informative = true, seed = 7): Row[] {
  const r = rand(seed);
  return Array.from({ length: n }, (_, i) => {
    const x = r() * 2 - 1,
      p = informative ? 0.5 + 0.4 * x : 0.5;
    return {
      window: i * 900000,
      bucket: "5–2m",
      scores: { fade: x },
      y: r() < p ? 1 : 0,
      official: false,
    };
  });
}
describe("isotonic calibration", () => {
  it("is monotone non-decreasing and bounded", () => {
    const r = rand(3),
      pts = Array.from({ length: 300 }, () => {
        const x = r() * 2 - 1;
        return { x, y: r() < 0.5 + 0.3 * x ? 1 : 0 };
      }),
      m = isotonic(pts);
    let prev = -Infinity;
    for (let x = -1; x <= 1; x += 0.01) {
      const p = predict(m, x);
      expect(p).toBeGreaterThanOrEqual(prev);
      expect(p).toBeGreaterThanOrEqual(0.01);
      expect(p).toBeLessThanOrEqual(0.99);
      prev = p;
    }
    expect(
      predict(
        isotonic([
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ]),
        0.5,
      ),
    ).toBe(0.99);
  });
  it("walk-forward predictions never see their own or later windows", () => {
    const rows = synthetic(120).map((r) => ({
        window: r.window,
        x: r.scores.fade!,
        y: r.y,
      })),
      before = walkForward(rows, 4),
      altered = rows.map((r, i) =>
        i >= 60 ? { ...r, y: (1 - r.y) as 0 | 1 } : r,
      ),
      after = walkForward(altered, 4);
    // Window 60 is predicted from a model fit at index 60 on rows 0..59 only.
    const cut = before.findIndex((p) => p.window === rows[60].window);
    expect(after.slice(0, cut + 1).map((p) => p.p)).toEqual(
      before.slice(0, cut + 1).map((p) => p.p),
    );
    expect(before[0].window).toBe(rows[20].window);
  });
  it("is UNCALIBRATED below CALIBRATION_MIN_N or without beating the base rate", () => {
    const cfg = { minN: 200, refitEvery: 4, recentN: 100 };
    expect(calibrate(synthetic(150), "fade", "5–2m", cfg)).toMatchObject({
      status: "UNCALIBRATED",
    });
    const strong = calibrate(synthetic(600), "fade", "5–2m", cfg);
    expect(strong.status).toBe("CALIBRATED");
    expect(strong.n).toBe(580);
    expect(strong.brier!).toBeLessThan(strong.baselineBrier!);
    expect(strong.kind).toBe("isotonic");
    const noise = calibrate(synthetic(600, false, 11), "fade", "5–2m", cfg);
    expect(noise.status).toBe("UNCALIBRATED");
  });
});
describe("independence", () => {
  it("counts windows, not seconds: one row per window × bucket, official result preferred", () => {
    const snap = (time: number, window: number, eligible = true) =>
      ({
        time,
        window,
        bucket: "5–2m",
        eligible,
        engines: { fade: { score: 0.5 } },
      }) as unknown as ContractSnapshot;
    const outcome = (window: number, result: "UP" | "DOWN") =>
      ({ window, result, status: "COMPLETE" }) as ContractOutcome;
    const rows = dataset(
      [snap(5, 0), snap(3, 0), snap(4, 0), snap(6, 0, false), snap(9, 900000)],
      [outcome(0, "UP"), outcome(900000, "DOWN")],
      [
        {
          id: "k",
          ticker: "k",
          window: 900000,
          result: "UP",
          expirationValue: 1,
          strike: 1,
          settled: 1,
          source: "kalshi",
        },
      ],
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ y: 1, official: true });
  });
});
