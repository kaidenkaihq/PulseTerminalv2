import type { Candle } from "../lib/types";
import type { Engine } from "./engine";
import { boundary } from "../lib/math";
// Deterministic synthetic fixture, not historical market prices. No generated future samples are exposed.
export function fixturePrice(second: number) {
  return (
    96000 +
    Math.sin(second / 47) * 130 +
    Math.sin(second / 11) * 24 +
    second * 0.07
  );
}
export function seedReplay(engine: Engine, now: number) {
  const rows: Candle[] = [];
  const end = boundary(now, 900);
  for (let i = 120; i > 0; i--) {
    const time = end - i * 900000,
      base = 96000 + (120 - i) * 8,
      open = base + Math.sin(i) * 40,
      close = base + Math.cos(i) * 50;
    rows.push({
      time,
      open,
      close,
      high: Math.max(open, close) + 40,
      low: Math.min(open, close) - 55,
      volume: 100 + i,
      delta: 0,
      complete: true,
    });
  }
  engine.seed(rows, [], now);
}
export function replayStep(engine: Engine, now: number, second: number) {
  const price = fixturePrice(second);
  for (let i = 0; i < engine.watchlist.length; i++) {
    const symbol = engine.watchlist[i],
      p =
        (price /
          [1, 30, 500, 40000, 200000, 100000, 3000, 6000, 1000, 20000][
            i % 10
          ]) *
        (1 + Math.sin(second / 18 + i) * 0.0003);
    engine.price(symbol, p, now);
  }
  engine.trade(
    {
      id: `replay-${second}`,
      symbol: "BTC-USD",
      price,
      size: 0.025 + Math.abs(Math.sin(second)) * 0.1,
      side: Math.cos(second / 11) > 0.1 ? "buy" : "sell",
      time: now,
    },
    now,
  );
  engine.kraken = null;
  engine.book.snapshot(
    Array.from({ length: 20 }, (_, i) => [
      (price - 1 - i).toFixed(2),
      (0.8 + 0.3 * Math.sin(second / 12)).toString(),
    ]),
    Array.from({ length: 20 }, (_, i) => [
      (price + 1 + i).toFixed(2),
      (0.8 - 0.3 * Math.sin(second / 12)).toString(),
    ]),
    now,
  );
  engine.healthFor("replay").status = "SYNTHETIC REPLAY";
  engine.healthFor("replay").lastMessage = now;
}
