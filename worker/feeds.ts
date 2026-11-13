import WebSocket from "ws";
import { z } from "zod";
import { aggressor } from "../lib/math";
import type { Candle } from "../lib/types";
import type { Engine } from "./engine";
const numeric = z.coerce.number().finite().positive();
const match = z.object({
  type: z.literal("match"),
  product_id: z.string(),
  price: numeric,
  size: numeric,
  side: z.enum(["buy", "sell"]),
  trade_id: z.number().int(),
  time: z.string().datetime({ offset: true }),
});
const ticker = z.object({
  type: z.literal("ticker"),
  product_id: z.string(),
  price: numeric,
  time: z.string().datetime({ offset: true }),
});
const bookSnapshot = z.object({
  type: z.literal("snapshot"),
  bids: z.array(z.array(z.string()).length(2)),
  asks: z.array(z.array(z.string()).length(2)),
  product_id: z.string(),
});
const bookUpdate = z.object({
  type: z.literal("l2update"),
  product_id: z.string(),
  time: z.string().datetime({ offset: true }),
  changes: z.array(z.tuple([z.enum(["buy", "sell"]), z.string(), z.string()])),
});
export interface MarketAdapter {
  start(): void;
  stop(): void;
}
export class Socket implements MarketAdapter {
  socket?: WebSocket;
  retry?: NodeJS.Timeout;
  monitor?: NodeJS.Timeout;
  stopped = false;
  attempt = 0;
  last = 0;
  constructor(
    public engine: Engine,
    public source: string,
    public url: string,
    public subscriptions: unknown[] | (() => unknown[]),
    public handle: (raw: unknown, now: number) => void,
    // Authenticated venues sign each handshake; headers are rebuilt on every connect.
    public headers?: () => Record<string, string>,
  ) {}
  start() {
    this.stopped = false;
    this.connect();
    this.monitor = setInterval(() => {
      if (
        this.socket?.readyState === WebSocket.OPEN &&
        Date.now() - this.last > 15000
      )
        this.socket.terminate();
    }, 5000);
  }
  connect() {
    if (this.stopped) return;
    const h = this.engine.healthFor(this.source);
    h.status = "CONNECTING";
    try {
      this.socket = new WebSocket(this.url, {
        maxPayload: 16 * 1024 * 1024,
        handshakeTimeout: 15000,
        headers: this.headers?.(),
      });
    } catch (e) {
      this.engine.error(this.source, String(e));
      h.status = "DISCONNECTED";
      return;
    }
    this.socket.on("open", () => {
      h.status = "CONNECTED";
      this.last = Date.now();
      this.socket!._socketStart = this.last;
      if (this.source === "coinbase") {
        this.engine.book.reset();
        this.engine.started = 0;
        this.engine.trades = [];
        this.engine.samples = [];
        this.engine.candles.markGap();
        this.engine.minutes.markGap();
      }
      const subscriptions =
        typeof this.subscriptions === "function"
          ? this.subscriptions()
          : this.subscriptions;
      for (const s of subscriptions) this.socket!.send(JSON.stringify(s));
    });
    // Venues that ping only when idle (Kalshi) are alive while pinging.
    this.socket.on("ping", () => (this.last = Date.now()));
    this.socket.on("message", (raw) => {
      const now = Date.now();
      this.last = now;
      h.lastMessage = now;
      if (this.attempt && now - (this.socket?._socketStart ?? now) > 30000)
        this.attempt = 0;
      try {
        this.handle(JSON.parse(raw.toString()), now);
      } catch (e) {
        this.engine.error(this.source, String(e));
        if (this.source === "coinbase") this.engine.book.reset();
        this.socket?.terminate();
      }
    });
    this.socket.on("error", (e) => this.engine.error(this.source, e.message));
    this.socket.on("close", () => {
      h.status = "DISCONNECTED";
      if (this.source === "coinbase") this.engine.book.reset();
      if (!this.stopped) {
        h.reconnects++;
        const delay =
          Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5)) *
          (0.75 + Math.random() * 0.5);
        this.retry = setTimeout(() => this.connect(), delay);
      }
    });
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.monitor);
    this.socket?.close();
  }
}
// Keep transport state outside exchange event payloads.
declare module "ws" {
  interface WebSocket {
    _socketStart?: number;
  }
}
export function coinbaseAdapter(engine: Engine) {
  const lastIds = new Map<string, number>();
  return new Socket(
    engine,
    "coinbase",
    "wss://ws-feed.exchange.coinbase.com",
    [
      {
        type: "subscribe",
        product_ids: engine.watchlist,
        channels: ["ticker", "heartbeat"],
      },
      {
        type: "subscribe",
        product_ids: ["BTC-USD"],
        channels: ["matches", "level2_batch"],
      },
    ],
    (raw, now) => {
      if (typeof raw !== "object" || raw === null) return;
      const msg = raw as Record<string, unknown>,
        h = engine.healthFor("coinbase");
      if (msg.type === "error") {
        engine.error("coinbase", String(msg.message));
        return;
      }
      if (msg.type === "heartbeat") {
        const id = Number(msg.last_trade_id),
          last = lastIds.get(String(msg.product_id));
        if (last !== undefined && id > last) h.gaps++;
        return;
      }
      if (msg.type === "ticker") {
        const t = ticker.parse(msg);
        const time = Date.parse(t.time);
        engine.price(t.product_id, t.price, time);
        h.latency = Math.max(0, now - time);
      }
      if (msg.type === "match") {
        const t = match.parse(msg),
          last = lastIds.get(t.product_id);
        if (last !== undefined && t.trade_id > last + 1) {
          h.gaps++;
          engine.started = now;
          engine.trades = [];
          engine.candles.markGap();
          engine.minutes.markGap();
        }
        lastIds.set(t.product_id, Math.max(last ?? 0, t.trade_id));
        engine.trade(
          {
            id: `coinbase-${t.product_id}-${t.trade_id}`,
            symbol: t.product_id,
            time: Date.parse(t.time),
            price: t.price,
            size: t.size,
            side: aggressor(t.side),
          },
          now,
        );
        h.latency = Math.max(0, now - Date.parse(t.time));
      }
      if (msg.type === "snapshot") {
        const s = bookSnapshot.parse(msg);
        if (s.product_id === "BTC-USD")
          engine.book.snapshot(s.bids, s.asks, now);
      }
      if (msg.type === "l2update") {
        const u = bookUpdate.parse(msg);
        if (u.product_id === "BTC-USD") {
          const time = Date.parse(u.time);
          if (time < engine.book.lastExchangeTime) h.outOfOrder++;
          if (time > now + 1000)
            throw Error("Book timestamp ahead of local clock");
          engine.book.update(u.changes, time);
        }
      }
    },
  );
}
const krTrade = z.object({
  symbol: z.string(),
  price: numeric,
  qty: numeric,
  side: z.enum(["buy", "sell"]),
  timestamp: z.string().datetime({ offset: true }),
  trade_id: z.number().int(),
});
export function krakenAdapter(engine: Engine) {
  return new Socket(
    engine,
    "kraken",
    "wss://ws.kraken.com/v2",
    [
      {
        method: "subscribe",
        params: { channel: "trade", symbol: ["BTC/USD"], snapshot: false },
      },
      {
        method: "subscribe",
        params: {
          channel: "ticker",
          symbol: ["BTC/USD"],
          event_trigger: "trades",
          snapshot: true,
        },
      },
    ],
    (raw, now) => {
      if (typeof raw !== "object" || raw === null) return;
      const msg = raw as Record<string, unknown>;
      if (msg.success === false) {
        engine.error("kraken", String(msg.error));
        return;
      }
      if (msg.channel === "trade" && Array.isArray(msg.data)) {
        for (const r of msg.data) {
          const t = krTrade.parse(r),
            time = Date.parse(t.timestamp);
          if (
            t.symbol === "BTC/USD" &&
            time <= now + 1000 &&
            (!engine.kraken || time >= engine.kraken.time)
          ) {
            engine.kraken = { time, price: t.price };
            engine.healthFor("kraken").latency = Math.max(0, now - time);
          }
        }
      }
      // Only trade-triggered ticker updates refresh last-price receipt age; snapshots do not attest freshness.
      if (
        msg.channel === "ticker" &&
        msg.type !== "snapshot" &&
        Array.isArray(msg.data)
      ) {
        for (const r of msg.data) {
          const t = z.object({ symbol: z.string(), last: numeric }).parse(r);
          if (t.symbol === "BTC/USD")
            engine.kraken = { time: now, price: t.last };
        }
      }
    },
  );
}
export async function seedHistory(engine: Engine) {
  async function fetchCandles(granularity: number): Promise<Candle[]> {
    const response = await fetch(
      `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${granularity}`,
      {
        signal: AbortSignal.timeout(15000),
        headers: { "User-Agent": "PulseTerminal/1.0" },
      },
    );
    if (!response.ok) throw Error(`Historical candles HTTP ${response.status}`);
    const rows = z
      .array(
        z.tuple([
          z.number(),
          numeric,
          numeric,
          numeric,
          numeric,
          z.number().nonnegative(),
        ]),
      )
      .parse(await response.json());
    return rows.map(([time, low, high, open, close, volume]) => ({
      time: time * 1000,
      low,
      high,
      open,
      close,
      volume,
      delta: 0,
      complete: true,
    }));
  }
  try {
    const candles = await fetchCandles(900),
      minutes = await fetchCandles(60);
    engine.seed(candles, minutes, Date.now());
    for (const [rows, seconds] of [
      [candles, 900],
      [minutes, 60],
    ] as const)
      for (const c of rows) {
        const id = `live-BTC-USD-${seconds}-${c.time}`;
        if (
          c.time + seconds * 1000 <= Date.now() &&
          !engine.seededHistory.has(id)
        ) {
          engine.seededHistory.add(id);
          engine.persist("candle_history", id, c.time, c);
        }
      }
    if (engine.seededHistory.size > 2000)
      engine.seededHistory = new Set([...engine.seededHistory].slice(-1500));
  } catch (e) {
    engine.error("coinbase", `History: ${String(e)}`);
  }
}
