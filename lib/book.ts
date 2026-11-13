import type { BookMetrics } from "./types";
export class OrderBook {
  bids = new Map<number, number>();
  asks = new Map<number, number>();
  ready = false;
  time = 0;
  lastExchangeTime = 0;
  reset() {
    this.bids.clear();
    this.asks.clear();
    this.ready = false;
    this.time = 0;
    this.lastExchangeTime = 0;
  }
  snapshot(bids: string[][], asks: string[][], time: number) {
    this.reset();
    this.apply("buy", bids);
    this.apply("sell", asks);
    this.time = time;
    this.ready = true;
  }
  private apply(side: string, levels: (string | number)[][]) {
    const map = side === "buy" ? this.bids : this.asks;
    for (const [p, q] of levels) {
      const price = Number(p),
        size = Number(q);
      if (
        !Number.isFinite(price) ||
        !Number.isFinite(size) ||
        price <= 0 ||
        size < 0
      )
        throw Error("Invalid book level");
      if (size === 0) map.delete(price);
      else map.set(price, size);
      if (map.size > 100000) {
        this.reset();
        throw Error("Order book capacity exceeded; snapshot required");
      }
    }
  }
  update(changes: string[][], time: number) {
    if (!this.ready || time < this.lastExchangeTime) return;
    for (const [side, p, q] of changes) this.apply(side, [[p, q]]);
    this.time = time;
    this.lastExchangeTime = time;
  }
  metrics(now: number, threshold = 5000): BookMetrics | null {
    if (!this.ready || now - this.time > threshold) return null;
    const bids = [...this.bids].sort((a, b) => b[0] - a[0]).slice(0, 20),
      asks = [...this.asks].sort((a, b) => a[0] - b[0]).slice(0, 20);
    if (!bids.length || !asks.length || bids[0][0] >= asks[0][0]) return null;
    const b = bids.reduce((s, [p, q]) => s + p * q, 0),
      a = asks.reduce((s, [p, q]) => s + p * q, 0);
    return {
      bid: bids[0][0],
      ask: asks[0][0],
      spread: asks[0][0] - bids[0][0],
      imbalance: (b - a) / (b + a),
      age: now - this.time,
      depth: Math.min(bids.length, asks.length),
    };
  }
}
