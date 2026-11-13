import { randomUUID } from "node:crypto";
import { CandleSeries } from "../lib/candles";
import { OrderBook } from "../lib/book";
import { boundary, evaluate, fresh, pressure, project } from "../lib/math";
import { signal, wickLean } from "../lib/signals";
import { PaperAccount } from "../lib/paper";
import type {
  Candle,
  Forecast,
  Market,
  Mode,
  Outcome,
  Sample,
  Signal,
  Snapshot,
  Trade,
} from "../lib/types";
import type { Store } from "./store";
export class Engine {
  mode: Mode;
  watchlist: string[];
  samples: Sample[] = [];
  trades: Trade[] = [];
  prices = new Map<string, Sample[]>();
  kraken: Sample | null = null;
  book = new OrderBook();
  minutes = new CandleSeries(60);
  candles = new CandleSeries(900);
  forecasts: Forecast[] = [];
  outcomes: Outcome[] = [];
  signals: Signal[] = [];
  cvd = 0;
  started = 0;
  lastSample = 0;
  lastForecast = 0;
  lastSignal = "";
  lastSavedCandle = 0;
  lastSavedMinute = 0;
  seededHistory = new Set<string>();
  lastAutoSignal = "";
  pulse: { time: number; value: number }[] = [];
  seen = new Set<string>();
  health: Snapshot["health"] = {};
  paper = new PaperAccount(Number(process.env.PAPER_BALANCE) || 10000);
  storageTasks: Promise<unknown>[] = [];
  freshness = Number(process.env.FRESHNESS_MS) || 5000;
  divergence = Number(process.env.DIVERGENCE_PERCENT) || 0.2;
  atrPeriod = Number(process.env.ATR_PERIOD) || 14;
  multiplier = Number(process.env.SUPER_TREND_MULTIPLIER) || 3;
  constructor(
    mode: Mode,
    public store: Store,
    watchlist?: string[],
  ) {
    this.mode = mode;
    this.watchlist =
      watchlist ??
      (
        process.env.WATCHLIST ||
        "BTC-USD,ETH-USD,SOL-USD,XRP-USD,DOGE-USD,ADA-USD,AVAX-USD,LINK-USD,LTC-USD,DOT-USD"
      ).split(",");
    this.watchlist = [...new Set(["BTC-USD", ...this.watchlist])].slice(0, 30);
  }
  persist(table: string, id: string, time: number, payload: unknown) {
    this.storageTasks.push(
      this.store.put({ table, id, time, mode: this.mode, payload }),
    );
  }
  async drain() {
    await Promise.all(this.storageTasks.splice(0));
  }
  healthFor(source: string) {
    return (this.health[source] ??= {
      status: "CONNECTING",
      lastMessage: 0,
      reconnects: 0,
      errors: [],
      latency: null,
      gaps: 0,
      outOfOrder: 0,
    });
  }
  error(source: string, error: string) {
    const h = this.healthFor(source);
    h.errors = [...h.errors, error].slice(-5);
  }
  price(symbol: string, price: number, time: number) {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(time)) return;
    const s = this.prices.get(symbol) ?? [];
    if (s.at(-1) && time < s.at(-1)!.time) return;
    s.push({ price, time });
    while (s.length > 10000 || (s.length && time - s[0].time > 120000))
      s.shift();
    this.prices.set(symbol, s);
  }
  trade(t: Trade, received: number) {
    if (this.seen.has(t.id)) return;
    this.seen.add(t.id);
    if (this.seen.size > 50000)
      this.seen.delete(this.seen.values().next().value!);
    if (t.time > received + 1000 || received - t.time > 5000) {
      this.healthFor("coinbase").outOfOrder++;
      return;
    }
    if (this.trades.at(-1) && t.time < this.trades.at(-1)!.time) {
      this.healthFor("coinbase").outOfOrder++;
      return;
    }
    this.price(t.symbol, t.price, t.time);
    if (t.symbol !== "BTC-USD") return;
    if (!this.started) this.started = received;
    this.trades.push(t);
    this.trades = this.trades
      .filter((x) => x.time > received - 120000)
      .slice(-50000);
    this.cvd += (t.side === "buy" ? 1 : -1) * t.price * t.size;
    this.minutes.add(t);
    this.candles.add(t);
  }
  seed(c: Candle[], minutes: Candle[], now: number) {
    this.candles.seed(c, now);
    this.minutes.seed(minutes, now);
  }
  tick(now: number): Snapshot {
    const latest = this.prices.get("BTC-USD")?.at(-1),
      isFresh = fresh(latest?.time, now, this.freshness),
      price = latest?.price ?? null;
    if (isFresh && latest && now - this.lastSample >= 950) {
      if (this.samples.at(-1) && now - this.lastSample > 2000)
        this.samples = [];
      this.samples.push({ time: now, price: latest.price });
      this.samples = this.samples.filter((x) => x.time > now - 120000);
      this.lastSample = now;
    }
    const projection = isFresh ? project(this.samples, now) : null;
    const pending = this.forecasts.filter(
      (f) =>
        !this.outcomes.some((o) => o.id === f.id) && now >= f.created + 20000,
    );
    for (const f of pending) {
      const outcome =
        isFresh && latest && latest.time >= f.created + 20000
          ? evaluate(f, latest)
          : now > f.created + 22000
            ? evaluate(f, { time: now, price: price ?? f.starting })
            : null;
      if (outcome) {
        this.outcomes.push(outcome);
        this.persist("forecast_outcomes", outcome.id, now, outcome);
      }
    }
    if (projection && now - this.lastForecast >= 10000) {
      const f: Forecast = {
        id: randomUUID(),
        created: now,
        starting: projection.price,
        projected: projection.projected,
        horizon: 20,
        model: "ols10-v1",
        mode: this.mode,
        freshness: now - latest!.time,
        features: projection,
        regime:
          (Math.abs(projection.velocity30) * 30) / projection.price > 0.001
            ? "HIGH"
            : (Math.abs(projection.velocity30) * 30) / projection.price < 0.0002
              ? "LOW"
              : "NORMAL",
      };
      this.forecasts.push(f);
      this.persist("forecast_events", f.id, now, f);
      this.lastForecast = now;
    }
    this.forecasts = this.forecasts.slice(-8640);
    this.outcomes = this.outcomes.slice(-8640);
    const p20 = pressure(this.trades, now, 20, this.cvd, this.started || now),
      p60 = pressure(this.trades, now, 60, this.cvd, this.started || now),
      book = this.book.metrics(now, this.freshness),
      closed = this.candles.closed(now),
      sig = signal(
        closed,
        now,
        this.mode,
        projection,
        p60,
        book,
        this.atrPeriod,
        this.multiplier,
      );
    const key = `${closed.at(-1)?.time}-${sig.state}`;
    if (key !== this.lastSignal) {
      const event = { ...sig, id: randomUUID() };
      this.signals.push(event);
      this.signals = this.signals.slice(-5000);
      this.persist("trading_signals", event.id, now, event);
      this.lastSignal = key;
    }
    if (isFresh && price) {
      const prev = this.paper.state.position;
      this.paper.mark(price, now);
      if (prev && !this.paper.state.position) {
        const t = this.paper.state.trades.at(-1)!;
        this.persist("paper_trades", t.id, now, t);
        this.persist("paper_positions", prev.id, now, { ...prev, closed: now });
      }
      if (
        this.paper.state.auto &&
        !this.paper.state.position &&
        sig.atr &&
        (sig.state === "LONG" || sig.state === "SHORT") &&
        this.lastAutoSignal !== sig.id
      ) {
        const sign = sig.state === "LONG" ? 1 : -1;
        try {
          this.paper.open(
            sig.state,
            Math.min(0.001, (this.paper.state.balance / price) * 0.05),
            price,
            price - sign * sig.atr * 1.5,
            price + sign * sig.atr * 3,
            now,
            this.mode,
            sig.id,
          );
          this.lastAutoSignal = sig.id;
          const p = this.paper.state.position!;
          this.persist("paper_positions", p.id, now, p);
        } catch (e) {
          this.error("paper", String(e));
        }
      }
    }
    const markets: Market[] = this.watchlist.map((symbol) => {
      const s = this.prices.get(symbol) ?? [],
        last = s.at(-1),
        anchor = last
          ? s.find((x) => x.time >= now - 21000 && x.time <= now - 19000)
          : undefined,
        ok = fresh(last?.time, now, this.freshness);
      return {
        symbol,
        price: last?.price ?? null,
        change:
          ok && anchor
            ? ((last!.price - anchor.price) / anchor.price) * 100
            : null,
        age: last ? Math.max(0, now - last.time) : null,
        source: "Coinbase",
        fresh: ok,
      };
    });
    const eligible = markets.filter((m) => m.fresh && m.change !== null),
      rising = eligible.filter((m) => m.change! > 0.002).length,
      falling = eligible.filter((m) => m.change! < -0.002).length,
      coverage = eligible.length / markets.length,
      enough = eligible.length >= Math.max(6, Math.ceil(markets.length * 0.7)),
      breadth = enough ? (rising - falling) / eligible.length : null;
    if (breadth !== null) {
      this.pulse.push({ time: now, value: breadth * 100 });
      this.pulse = this.pulse.slice(-180);
    }
    const cbAge = latest ? now - latest.time : null,
      krAge = this.kraken ? now - this.kraken.time : null,
      div =
        latest && this.kraken
          ? (Math.abs(latest.price - this.kraken.price) / latest.price) * 100
          : null,
      confirmed = isFresh && fresh(this.kraken?.time, now, this.freshness);
    if (now % 15000 < 1000) {
      this.persist(
        "market_aggregates",
        `${this.mode}-${boundary(now, 15)}-BTC`,
        now,
        { price, projection, pressure20: p20, pressure60: p60, book },
      );
      this.persist(
        "system_health",
        `${this.mode}-${boundary(now, 15)}`,
        now,
        this.health,
      );
    }
    const lastClosed = closed.at(-1);
    if (lastClosed && lastClosed.time > this.lastSavedCandle) {
      this.persist(
        "candle_history",
        `${this.mode}-BTC-USD-900-${lastClosed.time}`,
        lastClosed.time,
        lastClosed,
      );
      this.lastSavedCandle = lastClosed.time;
    }
    const lastMinute = this.minutes.closed(now).at(-1);
    if (lastMinute && lastMinute.time > this.lastSavedMinute) {
      this.persist(
        "candle_history",
        `${this.mode}-BTC-USD-60-${lastMinute.time}`,
        lastMinute.time,
        lastMinute,
      );
      this.lastSavedMinute = lastMinute.time;
    }
    return {
      time: now,
      mode: this.mode,
      connection: isFresh ? "STREAMING" : "STALE / WARMING UP",
      persistence: this.store.label,
      persistenceError: this.store.error,
      price,
      projection,
      pressure20: p20,
      pressure60: p60,
      book,
      signal: sig,
      candles: this.candles.candles,
      minutes: this.minutes.candles,
      forecasts: this.forecasts.slice(-1000),
      outcomes: this.outcomes.slice(-1000),
      signals: this.signals.slice(-500),
      markets,
      pulse: {
        state: !enough
          ? "INSUFFICIENT DATA"
          : breadth! > 0.25
            ? "RISK-ON"
            : breadth! < -0.25
              ? "RISK-OFF"
              : "MIXED",
        rising,
        falling,
        coverage,
        points: this.pulse,
      },
      confirmation: {
        coinbase: price,
        kraken: this.kraken?.price ?? null,
        coinbaseAge: cbAge,
        krakenAge: krAge,
        divergence: div,
        state: !confirmed
          ? "STALE"
          : div! <= this.divergence
            ? "CONFIRMED"
            : "DIVERGENT",
      },
      health: this.health,
      wick: wickLean(closed, sig.atr),
      paper: this.paper.state,
      settings: {
        freshness: this.freshness,
        divergence: this.divergence,
        atrPeriod: this.atrPeriod,
        multiplier: this.multiplier,
        watchlist: this.watchlist,
      },
      nextClose: boundary(now, 900) + 900000,
    };
  }
}
