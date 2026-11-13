import { describe, it, expect } from "vitest";
import { constants, generateKeyPairSync, verify } from "node:crypto";
import fixture from "./fixtures/kalshi.json";
import {
  applyTicker,
  bucketOf,
  easternLabel,
  kalshiFee,
  quoteFromMarket,
  resolve,
  restMarket,
  windowStart,
} from "../lib/contracts";
import { contractConfig } from "../lib/contractConfig";
import { kalshiHeaders, pickActive, signKalshi } from "../worker/kalshi";
import { Engine } from "../worker/engine";
import { Store } from "../worker/store";
const memory = () => {
  const s = new Store();
  s.label = "MEMORY ONLY";
  return s;
};
describe("Kalshi request signing", () => {
  it("RSA-PSS SHA-256 with digest-length salt over timestamp+method+path, query stripped", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const sig = signKalshi(
      privateKey,
      1794560400000,
      "GET",
      "/trade-api/v2/portfolio/orders?limit=5",
    );
    const ok = (path: string, saltLength: number) =>
      verify(
        "sha256",
        Buffer.from(`1794560400000GET${path}`),
        {
          key: publicKey,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength,
        },
        Buffer.from(sig, "base64"),
      );
    expect(ok("/trade-api/v2/portfolio/orders", 32)).toBe(true);
    expect(ok("/trade-api/v2/portfolio/orders?limit=5", 32)).toBe(false);
  });
  it("Ed25519 keys sign the string directly and headers carry key id and ms timestamp", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const h = kalshiHeaders(
      "key-id",
      privateKey,
      "GET",
      "/trade-api/ws/v2",
      42,
    );
    expect(h["KALSHI-ACCESS-KEY"]).toBe("key-id");
    expect(h["KALSHI-ACCESS-TIMESTAMP"]).toBe("42");
    expect(
      verify(
        null,
        Buffer.from("42GET/trade-api/ws/v2"),
        publicKey,
        Buffer.from(h["KALSHI-ACCESS-SIGNATURE"], "base64"),
      ),
    ).toBe(true);
  });
});
describe("Kalshi market data", () => {
  const m = restMarket.parse(fixture.open.markets[0]);
  it("parses a recorded KXBTC15M market and its 15-minute UTC-aligned window", () => {
    const q = quoteFromMarket(m, "KXBTC15M", 1, "kalshi-rest");
    expect(q.close - q.open).toBe(900000);
    expect(windowStart(q.open)).toBe(q.open);
    expect(windowStart(q.close - 1)).toBe(q.open);
    expect(q.strike).toBeGreaterThan(1000);
    expect(q.yesAsk! + q.noBid!).toBeCloseTo(1, 2);
    expect(pickActive([m], q.open + 1000)?.ticker).toBe(m.ticker);
  });
  it("parses an official settled result", () => {
    const s = restMarket.parse(fixture.settled.market);
    expect(["yes", "no"]).toContain(s.result);
    expect(s.expiration_value).toBeGreaterThan(1000);
  });
  it("applies WebSocket ticker pushes, deriving NO from YES, and ignores other markets", () => {
    const q = quoteFromMarket(m, "KXBTC15M", 1, "kalshi-rest");
    const push = {
      type: "ticker",
      sid: 1,
      msg: {
        market_id: "x",
        market_ticker: m.ticker,
        price_dollars: "0.4100",
        yes_bid_dollars: "0.4000",
        yes_ask_dollars: "0.4200",
        volume_fp: "10.00",
        ts_ms: 5,
      },
    };
    const next = applyTicker(q, push, 9)!;
    expect(next.noAsk).toBe(0.6);
    expect(next.noBid).toBe(0.58);
    expect(next.source).toBe("kalshi-ws");
    expect(
      applyTicker(
        q,
        { ...push, msg: { ...push.msg, market_ticker: "OTHER" } },
        9,
      ),
    ).toBeNull();
    expect(() => applyTicker(q, { type: "ticker", msg: {} }, 9)).toThrow();
  });
});
describe("contract rules", () => {
  it("fee formula rounds the order total up to the cent", () => {
    expect(kalshiFee(10, 0.39)).toBe(0.17);
    expect(kalshiFee(1, 0.5)).toBe(0.02);
    expect(kalshiFee(100, 0.5)).toBe(1.75);
    expect(kalshiFee(100, 0.1)).toBe(0.63);
    expect(kalshiFee(10, 0.39, 0.07, 1, 0.0001)).toBe(0.1666);
    expect(kalshiFee(10, 1)).toBe(0);
  });
  it("resolves ties UP after 2 dp rounding", () => {
    expect(resolve(100.004, 100)).toBe("UP");
    expect(resolve(99.994, 100)).toBe("DOWN");
    expect(resolve(100, 100)).toBe("UP");
  });
  it("buckets by seconds to close; DST changes only the Eastern display label", () => {
    const edges = contractConfig({}).buckets;
    expect(bucketOf(900, edges)).toBe("15–10m");
    expect(bucketOf(601, edges)).toBe("15–10m");
    expect(bucketOf(600, edges)).toBe("10–5m");
    expect(bucketOf(599, edges)).toBe("10–5m");
    expect(bucketOf(1, edges)).toBe("2–0m");
    expect(bucketOf(0, edges)).toBeNull();
    const edt = Date.parse("2026-10-31T14:00:00Z"),
      est = Date.parse("2026-11-02T14:00:00Z");
    expect(windowStart(edt) % 900000).toBe(0);
    expect(windowStart(est) % 900000).toBe(0);
    expect(easternLabel(edt)).toContain("EDT");
    expect(easternLabel(est)).toContain("EST");
  });
  it("rejects invalid contract configuration", () => {
    expect(() => contractConfig({ CONTRACT_BUCKETS: "600,900,0" })).toThrow();
    expect(() =>
      contractConfig({ FADE_TTC_MIN: "600", FADE_TTC_MAX: "30" }),
    ).toThrow();
    expect(
      contractConfig({ CONTRACT_RATCHET: ".8:.65,.9:.8" }).paper.ratchet,
    ).toEqual([
      [0.8, 0.65],
      [0.9, 0.8],
    ]);
  });
});
describe("contract engine", () => {
  it("replay builds a labelled synthetic contract and settles it from the fixture, never as Kalshi", () => {
    const e = new Engine("replay", memory());
    e.contracts.setQuote({
      ...quoteFromMarket(
        restMarket.parse(fixture.open.markets[0]),
        "KXBTC15M",
        0,
        "kalshi-rest",
      ),
    });
    expect(e.contracts.quote).toBeNull();
    const start = Date.parse("2026-11-13T10:14:00Z");
    for (let i = 0; i < 1000; i++) {
      const now = start + i * 1000;
      e.price("BTC-USD", 69000 + Math.sin(i / 30) * 40, now);
      e.tick(now);
    }
    const view = e.tick(start + 1000000).contract;
    expect(view.synthetic).toBe(true);
    expect(view.quote?.source).toBe("synthetic");
    expect(view.quote?.ticker).toMatch(/^SYNTHETIC/);
    expect(e.contracts.settlements[0].source).toBe("synthetic");
    expect(e.contracts.settlements[0].window).toBe(
      Date.parse("2026-11-13T10:15:00Z"),
    );
  });
  it("live without quotes reports no contract and never invents one", () => {
    const e = new Engine("live", memory());
    const view = e.tick(Date.now()).contract;
    expect(view.quote).toBeNull();
    expect(view.quoteFresh).toBe(false);
    expect(view.strike).toBeNull();
  });
});
describe("Eastern time display", () => {
  it("formats ET with the correct EST/EDT offset and ET calendar day", async () => {
    const { etDateTime, etDay, etIso, etTime, etZone } =
      await import("../lib/time");
    const est = Date.parse("2026-11-13T15:05:09Z"),
      edt = Date.parse("2026-07-01T15:05:09Z"),
      lateUtc = Date.parse("2026-11-14T03:30:00Z");
    expect(etTime(est)).toBe("10:05:09");
    expect(etTime(edt, false)).toBe("11:05");
    expect(etZone(est)).toBe("EST");
    expect(etZone(edt)).toBe("EDT");
    expect(etIso(est)).toBe("2026-11-13T10:05:09-05:00");
    expect(etIso(edt)).toBe("2026-07-01T11:05:09-04:00");
    expect(etDay(lateUtc)).toBe("2026-11-13");
    expect(etDateTime(Date.parse("2026-11-13T05:00:00Z"))).toBe(
      "2026-11-13 00:00:00",
    );
  });
});
