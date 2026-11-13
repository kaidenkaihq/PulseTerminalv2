import { boundary } from "./math";
import type { Candle, Trade } from "./types";
export class CandleSeries {
  candles: Candle[] = [];
  firstLive = true;
  constructor(
    public seconds: number,
    public limit = 600,
  ) {}
  seed(rows: Candle[], now: number) {
    const map = new Map(this.candles.map((c) => [c.time, c]));
    for (const c of rows)
      if (
        c.time + this.seconds * 1000 <= now &&
        (!map.has(c.time) || map.get(c.time)?.partial)
      )
        map.set(c.time, { ...c, complete: true, partial: false });
    this.candles = [...map.values()]
      .sort((a, b) => a.time - b.time)
      .slice(-this.limit);
  }
  markGap() {
    const last = this.candles.at(-1);
    if (last && !last.complete) last.partial = true;
  }
  add(t: Trade) {
    const time = boundary(t.time, this.seconds),
      last = this.candles.at(-1);
    if (last && time < last.time) return;
    if (!last || last.time !== time) {
      if (last) last.complete = true;
      this.candles.push({
        time,
        open: t.price,
        high: t.price,
        low: t.price,
        close: t.price,
        volume: t.size,
        delta: 0,
        complete: false,
        partial:
          (this.firstLive && t.time - time > 1000) ||
          (!this.firstLive &&
            (!last || time - last.time !== this.seconds * 1000)),
      });
    }
    this.firstLive = false;
    const c = this.candles.at(-1)!;
    c.high = Math.max(c.high, t.price);
    c.low = Math.min(c.low, t.price);
    c.close = t.price;
    c.volume += last === c ? t.size : 0;
    c.delta += (t.side === "buy" ? 1 : -1) * t.price * t.size;
    this.candles = this.candles.slice(-this.limit);
  }
  closed(now: number) {
    return this.candles
      .filter((c) => !c.partial && c.time + this.seconds * 1000 <= now)
      .map((c) => ({ ...c, complete: true }));
  }
}
