import { describe, it, expect } from "vitest";
import { Engine } from "../worker/engine";
import { Store } from "../worker/store";
import { replayStep, seedReplay } from "../worker/replay";
import { resolve } from "../lib/contracts";
const memory = () => {
  const s = new Store();
  s.label = "MEMORY ONLY";
  return s;
};
// Starts 2 minutes before a UTC 15m boundary and runs through two full windows.
export function runReplay(
  seconds: number,
  start = Date.parse("2026-11-13T09:58:00Z"),
) {
  const e = new Engine("replay", memory());
  seedReplay(e, start);
  for (let i = 0; i < seconds; i++) {
    const now = start + i * 1000;
    replayStep(e, now, i);
    e.tick(now);
  }
  return e;
}
describe("contract-outcome dataset", () => {
  const e = runReplay(1960);
  it("takes exactly one eligible metric snapshot per window × bucket", () => {
    const full = e.contracts.samples.filter(
      (s) => s.window === Date.parse("2026-11-13T10:00:00Z"),
    );
    expect(full.map((s) => s.bucket)).toEqual([
      "15–10m",
      "10–5m",
      "5–2m",
      "2–0m",
    ]);
    expect(
      new Set(e.contracts.samples.map((s) => `${s.window}|${s.bucket}`)).size,
    ).toBe(e.contracts.samples.length);
    for (const s of full) {
      expect(s.strike).not.toBeNull();
      expect(s.features).toHaveProperty("velocity10");
      expect(s.features).toHaveProperty("cvdSlope");
      expect(s.engines.momentum.engine).toBe("momentum-v1");
      expect(s.quote?.source).toBe("synthetic");
    }
  });
  it("writes one immutable outcome per observed window using the proxy 60s average", () => {
    const done = e.contracts.outcomes.filter((o) => o.status === "COMPLETE");
    expect(done.length).toBeGreaterThanOrEqual(2);
    for (const o of done)
      expect(o.result).toBe(resolve(o.proxySettle!, o.strike!));
    const before = JSON.stringify(e.contracts.outcomes);
    const t = Date.parse("2026-11-13T09:58:00Z") + 1960 * 1000;
    e.tick(t);
    e.tick(t + 1000);
    expect(JSON.stringify(e.contracts.outcomes.slice(0, done.length))).toBe(
      JSON.stringify(JSON.parse(before).slice(0, done.length)),
    );
    expect(new Set(e.contracts.outcomes.map((o) => o.id)).size).toBe(
      e.contracts.outcomes.length,
    );
  });
  it("compares proxy outcomes with official (here synthetic) settlements", () => {
    const view = e.tick(
      Date.parse("2026-11-13T09:58:00Z") + 1965 * 1000,
    ).contract;
    expect(view.agreement.compared).toBeGreaterThanOrEqual(1);
    expect(view.agreement.mismatches).toBe(0);
  });
  it("marks a window MISSED when the closing minute was not observed", () => {
    const m = new Engine("replay", memory()),
      start = Date.parse("2026-11-13T10:00:00Z");
    for (let i = 0; i < 600; i++) {
      m.price("BTC-USD", 69000 + i * 0.1, start + i * 1000);
      m.tick(start + i * 1000);
    }
    m.tick(start + 902000);
    const o = m.contracts.outcomes.find((x) => x.window === start)!;
    expect(o.status).toBe("MISSED");
    expect(o.result).toBeNull();
  });
});
describe("end-to-end synthetic replay", () => {
  it("drives the full contract pipeline and stays at NO TRADE while uncalibrated", () => {
    const e = runReplay(1000),
      view = e.tick(Date.parse("2026-11-13T09:58:00Z") + 1000 * 1000).contract;
    expect(view.synthetic).toBe(true);
    expect(view.status).toContain("not Kalshi");
    expect(view.engineViews.map((x) => x.name)).toEqual(["momentum", "fade"]);
    expect(view.calibration).toHaveLength(8);
    expect(view.verdict?.action).toBe("NO TRADE");
    expect(view.verdict?.reasons.join(" ")).toContain("uncalibrated");
    expect(view.paper.position).toBeNull();
    expect(view.paper.policy.rules[0]).toContain("97¢");
  });
});
describe("signal history", () => {
  it("records only the first UP/DOWN per window and source, never a duplicate", () => {
    const e = new Engine("replay", memory()),
      w = Date.parse("2026-11-13T10:00:00Z");
    const view = (state: "UP" | "DOWN" | "NEUTRAL", window = w) =>
      ({
        window,
        ttc: 400,
        bucket: "10–5m",
        strike: 1,
        proxy: 1,
        quote: null,
        verdict: null,
        engineViews: [
          {
            name: "fade",
            label: "Panic-Fade",
            status: "UNCALIBRATED",
            reading: { state, score: 0.4 },
            up: { modelP: null, marketP: 0.5 },
            down: { modelP: null, marketP: 0.52 },
          },
        ],
      }) as never;
    e.contracts.recordSignals(w + 1000, view("NEUTRAL"));
    e.contracts.recordSignals(w + 2000, view("UP"));
    e.contracts.recordSignals(w + 3000, view("UP"));
    e.contracts.recordSignals(w + 4000, view("DOWN"));
    expect(e.contracts.signals).toHaveLength(1);
    expect(e.contracts.signals[0]).toMatchObject({
      time: w + 2000,
      direction: "UP",
      source: "fade",
    });
    e.contracts.recordSignals(w + 901000, view("DOWN", w + 900000));
    expect(e.contracts.signals).toHaveLength(2);
    const restored = new Engine("replay", memory());
    restored.contracts.restore(e.contracts.checkpoint());
    restored.contracts.recordSignals(w + 902000, view("UP", w + 900000));
    expect(restored.contracts.signals).toHaveLength(2);
  });
});
