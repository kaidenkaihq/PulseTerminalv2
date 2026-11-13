import { it, expect } from "vitest";
import fixture from "./fixtures/coinbase.json";
import { Engine } from "../worker/engine";
import { Store } from "../worker/store";
import { coinbaseAdapter, krakenAdapter } from "../worker/feeds";
it("replays Coinbase wire messages with maker inversion, dedupe and absolute book updates", () => {
  const store = new Store();
  store.label = "MEMORY ONLY";
  const e = new Engine("live", store),
    adapter = coinbaseAdapter(e),
    now = Date.parse("2026-11-13T09:00:00.000Z");
  adapter.handle(fixture[0], now);
  adapter.handle(fixture[1], now);
  adapter.handle(fixture[1], now);
  adapter.handle(fixture[2], now + 100);
  adapter.handle(fixture[3], now + 200);
  expect(e.trades).toHaveLength(2);
  expect(e.trades[0].side).toBe("buy");
  expect(e.trades[1].side).toBe("sell");
  expect(e.book.metrics(now + 200)?.bid).toBe(10000);
  expect(e.healthFor("coinbase").gaps).toBe(0);
  expect(() => adapter.handle({ ...fixture[1], price: "NaN" }, now)).toThrow();
});
it("Kraken v2 maps BTC/USD and does not refresh last price from a subscription snapshot", () => {
  const store = new Store();
  store.label = "MEMORY ONLY";
  const e = new Engine("live", store),
    adapter = krakenAdapter(e),
    now = Date.parse("2026-11-13T09:00:00Z");
  adapter.handle(
    {
      channel: "ticker",
      type: "snapshot",
      data: [{ symbol: "BTC/USD", last: 100 }],
    },
    now,
  );
  expect(e.kraken).toBeNull();
  adapter.handle(
    {
      channel: "trade",
      type: "update",
      data: [
        {
          symbol: "BTC/USD",
          price: 100,
          qty: 1,
          side: "buy",
          timestamp: "2026-11-13T09:00:00.000Z",
          trade_id: 1,
        },
      ],
    },
    now,
  );
  expect(e.kraken).toEqual({ time: now, price: 100 });
  expect(e.tick(now + 6000).confirmation.state).toBe("STALE");
});
