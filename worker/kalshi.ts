import { constants, createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ContractConfig } from "../lib/contractConfig";
import {
  applyTicker,
  quoteFromMarket,
  restMarket,
  type RestMarket,
} from "../lib/contracts";
import type { Engine } from "./engine";
import { Socket, type MarketAdapter } from "./feeds";
// docs.kalshi.com "API Keys": sign timestamp + METHOD + path (with /trade-api/v2, without query).
// RSA keys use RSA-PSS/SHA-256, MGF1-SHA-256, salt = digest length; Ed25519 keys sign directly.
export function signKalshi(
  key: KeyObject,
  timestamp: number,
  method: string,
  path: string,
) {
  const message = Buffer.from(`${timestamp}${method}${path.split("?")[0]}`);
  return (
    key.asymmetricKeyType === "ed25519"
      ? sign(null, message, key)
      : sign("sha256", message, {
          key,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
        })
  ).toString("base64");
}
export function kalshiHeaders(
  keyId: string,
  key: KeyObject,
  method: string,
  path: string,
  now = Date.now(),
) {
  return {
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": String(now),
    "KALSHI-ACCESS-SIGNATURE": signKalshi(key, now, method, path),
  };
}
const marketList = z.object({ markets: z.array(z.unknown()) });
const marketOne = z.object({ market: z.unknown() });
// Read-only market data client. There is deliberately no order endpoint anywhere in this file.
export class KalshiFeed implements MarketAdapter {
  key: KeyObject | null = null;
  socket?: Socket;
  poll?: NodeJS.Timeout;
  settleTimer?: NodeJS.Timeout;
  stopped = false;
  inflight = false;
  failures = 0;
  nextPoll = 0;
  pending = new Map<string, { window: number; close: number }>();
  subscribed = "";
  commandId = 1;
  constructor(
    public engine: Engine,
    public config: ContractConfig["kalshi"],
  ) {}
  get base() {
    return new URL(this.config.rest);
  }
  async start() {
    this.stopped = false;
    const h = this.engine.healthFor("kalshi");
    if (!this.config.enabled) {
      h.status = "NOT CONFIGURED (disabled)";
      return;
    }
    if (this.config.keyId && this.config.keyPath) {
      try {
        this.key = createPrivateKey(await readFile(this.config.keyPath));
      } catch (e) {
        this.engine.error("kalshi", `Private key: ${String(e)}`);
      }
    }
    h.status = this.key ? "CONNECTING (key)" : "PUBLIC REST (no key)";
    if (this.key) {
      this.socket = new Socket(
        this.engine,
        "kalshi-ws",
        this.config.ws,
        () => (this.subscribed ? [this.subscribe(this.subscribed)] : []),
        (raw, now) => this.onSocket(raw, now),
        () =>
          kalshiHeaders(
            this.config.keyId!,
            this.key!,
            "GET",
            new URL(this.config.ws).pathname,
          ),
      );
      this.socket.start();
    }
    this.poll = setInterval(() => void this.refresh(), 1000);
    this.settleTimer = setInterval(() => void this.settlements(), 5000);
    void this.refresh();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.poll);
    clearInterval(this.settleTimer);
    this.socket?.stop();
  }
  subscribe(ticker: string) {
    return {
      id: this.commandId++,
      cmd: "subscribe",
      params: { channels: ["ticker"], market_tickers: [ticker] },
    };
  }
  async get(path: string) {
    const full = `${this.base.pathname.replace(/\/$/, "")}${path}`;
    const response = await fetch(`${this.base.origin}${full}`, {
      signal: AbortSignal.timeout(5000),
      headers: {
        "User-Agent": "PulseTerminal/2.0",
        ...(this.key
          ? kalshiHeaders(this.config.keyId!, this.key, "GET", full)
          : {}),
      },
    });
    if (response.status === 429) throw Error("Kalshi rate limited (429)");
    if (!response.ok) throw Error(`Kalshi HTTP ${response.status}`);
    return response.json();
  }
  // Public REST polling at 1/s keeps receipt freshness honest even when the WS ticker is quiet.
  async refresh() {
    const now = Date.now();
    if (this.inflight || this.stopped || now < this.nextPoll) return;
    this.inflight = true;
    const h = this.engine.healthFor("kalshi");
    try {
      const body = marketList.parse(
        await this.get(
          `/markets?series_ticker=${this.config.series}&status=open&limit=10`,
        ),
      );
      const markets = body.markets
          .map((m) => restMarket.safeParse(m))
          .filter((m) => m.success)
          .map((m) => m.data),
        received = Date.now(),
        active = pickActive(markets, received);
      if (!active) {
        h.status = "NO ACTIVE MARKET";
        return;
      }
      const quote = quoteFromMarket(
        active,
        this.config.series,
        received,
        "kalshi-rest",
      );
      const current = this.engine.contracts.quote;
      // A newer WS push for the same market keeps its book; REST refreshes strike and receipt age.
      this.engine.contracts.setQuote(
        current?.ticker === quote.ticker &&
          current.source === "kalshi-ws" &&
          received - current.received < 1500
          ? { ...current, strike: quote.strike, volume: quote.volume }
          : quote,
      );
      this.pending.set(quote.ticker, {
        window: quote.open,
        close: quote.close,
      });
      if (this.socket && this.subscribed !== quote.ticker) {
        this.subscribed = quote.ticker;
        if (this.socket.socket?.readyState === 1)
          this.socket.socket.send(JSON.stringify(this.subscribe(quote.ticker)));
      }
      h.status = this.key
        ? this.engine.healthFor("kalshi-ws").status === "CONNECTED"
          ? "STREAMING (key)"
          : "REST (key, WS reconnecting)"
        : "PUBLIC REST (no key)";
      h.lastMessage = received;
      h.latency = received - now;
      this.failures = 0;
    } catch (e) {
      this.failures++;
      this.nextPoll = Date.now() + Math.min(30000, 1000 * 2 ** this.failures);
      h.status = "DISCONNECTED";
      this.engine.error("kalshi", String(e));
    } finally {
      this.inflight = false;
    }
  }
  onSocket(raw: unknown, now: number) {
    const msg = raw as { type?: string; msg?: unknown };
    if (msg.type === "error") {
      this.engine.error("kalshi-ws", JSON.stringify(msg.msg));
      return;
    }
    if (msg.type !== "ticker") return;
    const q = this.engine.contracts.quote;
    if (!q) return;
    const next = applyTicker(q, raw, now);
    if (next) this.engine.contracts.setQuote(next);
  }
  // Official results arrive ~5s after close. Poll each closed market until Kalshi publishes a result.
  async settlements() {
    const now = Date.now();
    for (const [ticker, w] of this.pending) {
      if (now < w.close + 4000) continue;
      if (now > w.close + 3600000) {
        this.pending.delete(ticker);
        this.engine.error("kalshi", `No official result for ${ticker}`);
        continue;
      }
      try {
        const m = restMarket.parse(
          marketOne.parse(await this.get(`/markets/${ticker}`)).market,
        );
        if (m.result === "yes" || m.result === "no") {
          this.engine.contracts.settle({
            id: m.ticker,
            ticker: m.ticker,
            window: Date.parse(m.open_time),
            result: m.result === "yes" ? "UP" : "DOWN",
            expirationValue: m.expiration_value,
            strike: m.floor_strike,
            settled: now,
            source: "kalshi",
          });
          this.pending.delete(ticker);
        }
      } catch (e) {
        this.engine.error("kalshi", `Settlement ${ticker}: ${String(e)}`);
      }
    }
  }
}
export function pickActive(markets: RestMarket[], now: number) {
  return (
    markets.find(
      (m) => Date.parse(m.open_time) <= now && now < Date.parse(m.close_time),
    ) ??
    markets
      .filter((m) => Date.parse(m.close_time) > now)
      .sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time))[0]
  );
}
