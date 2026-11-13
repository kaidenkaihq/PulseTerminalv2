import { describe, it, expect } from "vitest";
import { fade, type FadeBar } from "../lib/fade";
import { momentum } from "../lib/engines";
import { contractConfig } from "../lib/contractConfig";
import type { Signal } from "../lib/types";
const cfg = contractConfig({}).fade,
  t0 = 1_800_000_000_000,
  N = 960,
  now = t0 + (N - 1) * 1000;
// Quiet 15.5 minutes, then a $180 panic drop over 30s whose selling peaks and then eases.
function panic(exhausting = true): FadeBar[] {
  return Array.from({ length: N }, (_, i) => {
    const drop = i >= 930 ? (i - 929) * 6 : 0,
      heavy = i >= 930 && (i <= 950 || !exhausting);
    return {
      time: t0 + i * 1000,
      proxy: 69000 + 3 * Math.sin(i / 7) - drop,
      buy: heavy ? 5 : i > 950 ? 30 : 10,
      sell: heavy ? 100 : i > 950 ? 20 : 10,
      imbalance: null,
    };
  });
}
describe("fade-v1", () => {
  it("fades an exhausted panic drop with a positive (UP) score, deterministically", () => {
    const a = fade(panic(), now, 300, cfg),
      b = fade(panic(), now, 300, cfg);
    expect(a.state).toBe("UP");
    expect(a.score).toBeGreaterThan(0);
    expect(a.score).toBeLessThanOrEqual(1);
    expect(a.details.z!).toBeLessThan(-cfg.sigma);
    expect(b).toEqual(a);
  });
  it("uses no lookahead: later seconds cannot change the reading at now", () => {
    const future = Array.from({ length: 60 }, (_, i) => ({
      time: now + (i + 1) * 1000,
      proxy: 60000,
      buy: 1e6,
      sell: 0,
      imbalance: 1,
    }));
    expect(fade([...panic(), ...future], now, 300, cfg)).toEqual(
      fade(panic(), now, 300, cfg),
    );
  });
  it("returns INSUFFICIENT DATA for stale or short history", () => {
    expect(fade(panic(), now + 5000, 300, cfg).state).toBe("INSUFFICIENT DATA");
    expect(fade(panic().slice(-300), now, 300, cfg).state).toBe(
      "INSUFFICIENT DATA",
    );
    const gappy = panic().map((b, i) => (i % 3 ? b : { ...b, proxy: null }));
    expect(fade(gappy, now, 300, cfg).score).toBeNull();
  });
  it("stays out outside its seconds-to-close window and without exhaustion", () => {
    expect(fade(panic(), now, 800, cfg)).toMatchObject({
      state: "NO SETUP",
      score: 0,
    });
    expect(fade(panic(false), now, 300, cfg)).toMatchObject({
      state: "NO SETUP",
      score: 0,
    });
    const flipped = panic(false).map((b, i) =>
      i === N - 1 ? { ...b, imbalance: 0.4 } : b,
    );
    expect(fade(flipped, now, 300, cfg).state).toBe("UP");
  });
});
describe("momentum-v1", () => {
  it("wraps the existing signal without changing its score", () => {
    const base = { score: 0.31, reason: "x" } as Signal;
    expect(momentum({ ...base, state: "LONG" })).toMatchObject({
      engine: "momentum-v1",
      state: "UP",
      score: 0.31,
    });
    expect(momentum({ ...base, state: "SHORT" }).state).toBe("DOWN");
    expect(momentum({ ...base, state: "NEUTRAL" }).state).toBe("NEUTRAL");
    expect(
      momentum({ ...base, state: "INSUFFICIENT DATA", score: null }).score,
    ).toBeNull();
  });
});
