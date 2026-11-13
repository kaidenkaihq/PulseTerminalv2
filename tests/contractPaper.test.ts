import { afterEach, describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ContractPaper,
  contractMetrics,
  OwnerExitPolicy,
  TAKE_PROFIT,
} from "../lib/contractPaper";
import { createServer } from "../worker/index";
import { Store } from "../worker/store";
import type { ContractQuote } from "../lib/types";
const open = Date.parse("2026-11-13T10:00:00Z"),
  fees = () => ({ rate: 0.07, multiplier: 1, precision: 0.01 }),
  cfg = { balance: 1000, contracts: 10, maxStake: 50, maxDailyLoss: 100 },
  meta = {
    engine: "fade",
    bucket: "5–2m",
    edge: 0.05,
    modelP: 0.45,
    marketP: 0.407,
    auto: false,
  };
const quote = (yesBid: number, yesAsk: number, at = open): ContractQuote => ({
  ticker: "KXBTC15M-TEST",
  event: "KXBTC15M",
  series: "KXBTC15M",
  open: at,
  close: at + 900000,
  strike: 69000,
  yesBid,
  yesAsk,
  noBid: Math.round((1 - yesAsk) * 100) / 100,
  noAsk: Math.round((1 - yesBid) * 100) / 100,
  last: null,
  volume: null,
  time: at,
  received: at,
  source: "synthetic",
});
const account = (policy = new OwnerExitPolicy()) =>
  new ContractPaper(cfg, policy, fees);
describe("contract P&L", () => {
  it("pays $1 per contract at settlement on a win and $0 on a loss, after the entry fee", () => {
    const a = account();
    a.open("UP", quote(0.38, 0.39), open + 1000, "replay", meta);
    expect(a.state.position?.cost).toBeCloseTo(4.07);
    const win = a.settle(open, "UP", open + 900000, "kalshi")!;
    expect(win.pnl).toBeCloseTo(5.93);
    expect(win.reason).toBe("SETTLED WIN (kalshi)");
    const b = account();
    b.open("DOWN", quote(0.38, 0.39), open + 1000, "replay", meta);
    expect(b.state.position?.entry).toBe(0.62);
    const loss = b.settle(open, "UP", open + 900000, "kalshi")!;
    expect(loss.pnl).toBeCloseTo(-(6.2 + 0.17));
    expect(b.state.balance).toBeCloseTo(1000 - 6.37);
  });
  it("always takes profit at a 97¢ bid, selling at the bid minus the taker fee", () => {
    const a = account();
    a.open("UP", quote(0.38, 0.39), open + 1000, "replay", meta);
    expect(a.mark(quote(0.96, 0.97), 300, open + 2000)).toBeNull();
    const t = a.mark(quote(TAKE_PROFIT, 0.98), 200, open + 3000)!;
    expect(t.reason).toBe("TAKE PROFIT 97¢");
    expect(t.exit).toBe(0.97);
    expect(t.exitFee).toBe(0.03);
    expect(t.pnl).toBeCloseTo(9.7 - 0.03 - 4.07);
  });
  it("manual early exit sells at the bid", () => {
    const a = account();
    a.open("UP", quote(0.38, 0.39), open + 1000, "replay", meta);
    const t = a.sell(quote(0.5, 0.52), open + 5000);
    expect(t.proceeds).toBeCloseTo(5 - 0.18);
    expect(t.reason).toBe("MANUAL");
  });
});
describe("exit policy", () => {
  it("placeholder applies no stop-loss or ratchet until the owner supplies them", () => {
    const p = new OwnerExitPolicy();
    expect(p.placeholder).toBe(true);
    expect(p.rules().join(" ")).toContain("NOT SUPPLIED");
    const a = account(p);
    a.open("UP", quote(0.38, 0.39), open + 1000, "replay", meta);
    a.mark(quote(0.9, 0.91), 400, open + 2000);
    expect(a.mark(quote(0.02, 0.03), 30, open + 3000)).toBeNull();
    expect(a.state.position).not.toBeNull();
  });
  it("ratchet stops a winner from round-tripping once its trigger was reached", () => {
    const p = new OwnerExitPolicy([], [[0.8, 0.65]]);
    expect(p.placeholder).toBe(false);
    expect(
      p.decide({
        side: "UP",
        entry: 0.4,
        bid: 0.64,
        peakBid: 0.79,
        ttc: 300,
        contracts: 1,
      }).exit,
    ).toBe(false);
    const a = account(p);
    a.open("UP", quote(0.38, 0.39), open + 1000, "replay", meta);
    a.mark(quote(0.85, 0.86), 400, open + 2000);
    const t = a.mark(quote(0.64, 0.66), 350, open + 3000)!;
    expect(t.reason).toBe("RATCHET floor 0.65");
  });
  it("phase stop applies only inside its seconds-to-close phase", () => {
    const p = new OwnerExitPolicy([[120, 0.1]]),
      c = {
        side: "UP" as const,
        entry: 0.4,
        bid: 0.09,
        peakBid: 0.4,
        contracts: 1,
      };
    expect(p.decide({ ...c, ttc: 200 }).exit).toBe(false);
    expect(p.decide({ ...c, ttc: 100 })).toEqual({
      exit: true,
      reason: "STOP ≤120s at 0.10",
    });
  });
});
describe("contract account limits and metrics", () => {
  it("enforces one position per window, max stake and daily loss", () => {
    const a = account();
    a.open("UP", quote(0.38, 0.39), open + 1000, "replay", meta);
    a.settle(open, "DOWN", open + 900000, "kalshi");
    expect(() =>
      a.open("UP", quote(0.38, 0.39), open + 2000, "replay", meta),
    ).toThrow("One position per window");
    const big = new ContractPaper(
      { ...cfg, contracts: 200 },
      new OwnerExitPolicy(),
      fees,
    );
    expect(() =>
      big.open("UP", quote(0.38, 0.39), open + 1000, "replay", meta),
    ).toThrow("exceeds max");
    const tight = new ContractPaper(
      { ...cfg, maxDailyLoss: 3 },
      new OwnerExitPolicy(),
      fees,
    );
    tight.open("UP", quote(0.38, 0.39), open + 1000, "replay", meta);
    tight.settle(open, "DOWN", open + 900000, "kalshi");
    const next = open + 900000;
    expect(() =>
      tight.open("UP", quote(0.38, 0.39, next), next + 1000, "replay", meta),
    ).toThrow("Daily loss limit");
  });
  it("reports P&L, ROI per contract, hit rate, edge and splits by engine and bucket", () => {
    const a = account();
    a.open("UP", quote(0.38, 0.39), open + 1000, "replay", meta);
    a.settle(open, "UP", open + 900000, "kalshi");
    const next = open + 900000;
    a.open("UP", quote(0.38, 0.39, next), next + 1000, "replay", {
      ...meta,
      engine: "momentum",
    });
    a.settle(next, "DOWN", next + 900000, "kalshi");
    const m = contractMetrics(a.state.trades);
    expect(m.n).toBe(2);
    expect(m.pnl).toBeCloseTo(5.93 - 4.07);
    expect(m.roiPerContract).toBeCloseTo((5.93 - 4.07) / 20);
    expect(m.hitRate).toBe(0.5);
    expect(m.edgeAtEntry).toBeCloseTo(0.05);
    expect(m.byEngine.map((x) => x.name).sort()).toEqual(["fade", "momentum"]);
  });
});
describe("contract API", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
    );
  });
  it("opens and closes a simulated position, exports trades and restores manual mode", async () => {
    const s = new Store();
    s.dir = await mkdtemp(path.join(tmpdir(), "pulse-contract-"));
    dirs.push(s.dir);
    await s.init();
    const { app, engine } = await createServer({
      mode: "replay",
      startFeeds: false,
      store: s,
    });
    const now = Date.now(),
      at = Math.floor(now / 900000) * 900000;
    engine.contracts.setQuote({
      ...quote(0.38, 0.39, at),
      received: now,
      time: now,
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/contracts/open",
          payload: { side: "SIDEWAYS" },
        })
      ).statusCode,
    ).toBe(400);
    const opened = await app.inject({
      method: "POST",
      url: "/api/contracts/open",
      payload: { side: "UP" },
    });
    expect(opened.statusCode).toBe(200);
    expect(engine.contracts.paper.state.position?.side).toBe("UP");
    engine.contracts.setQuote({
      ...quote(0.5, 0.52, at),
      received: Date.now(),
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/contracts/close",
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject("/api/contracts/trades.csv")).body).toContain(
      "MANUAL",
    );
    expect((await app.inject("/api/contracts/samples.csv")).body).toContain(
      "fade_raw_score",
    );
    engine.contracts.paper.state.auto = true;
    await app.close();
    const second = await createServer({
      mode: "replay",
      startFeeds: false,
      store: s,
    });
    expect(second.engine.contracts.paper.state.trades).toHaveLength(1);
    expect(second.engine.contracts.paper.state.auto).toBe(false);
    await second.app.close();
  });
});
