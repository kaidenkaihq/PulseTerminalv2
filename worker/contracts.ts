import type { ContractConfig } from "../lib/contractConfig";
import {
  bucketLabels,
  bucketOf,
  mean,
  resolve,
  secondsToClose,
  WINDOW_MS,
  windowStart,
} from "../lib/contracts";
import { fresh } from "../lib/math";
import { momentum } from "../lib/engines";
import { fade } from "../lib/fade";
import type {
  ContractOutcome,
  ContractQuote,
  ContractSettlement,
  ContractSnapshot,
  ContractView,
  Signal,
} from "../lib/types";
import type { Engine } from "./engine";
// One observed second. `proxy` stands in for CF Benchmarks BRTI, which is not observable in real time.
export type SecondBar = {
  time: number;
  price: number | null;
  proxy: number | null;
  source: "CB+KR" | "CB" | null;
  buy: number;
  sell: number;
  imbalance: number | null;
  cvd: number;
};
export type TickContext = {
  price: number | null;
  priceFresh: boolean;
  kraken: number | null;
  krakenFresh: boolean;
  imbalance: number | null;
  atr: number | null;
  signal: Signal;
  features: Record<string, number | string | null>;
};
const PROXY_MIN_SAMPLES = 45;
export type ContractCheckpoint = {
  samples: ContractSnapshot[];
  outcomes: ContractOutcome[];
  settlements: ContractSettlement[];
};
export class ContractEngine {
  quote: ContractQuote | null = null;
  bars: SecondBar[] = [];
  settlements: ContractSettlement[] = [];
  lastBar = 0;
  lastQuoteSaved = 0;
  lastSnapshot = 0;
  // Eligible (metric) snapshots and immutable window outcomes, bounded to ~200 days of windows.
  samples: ContractSnapshot[] = [];
  outcomes: ContractOutcome[] = [];
  taken = new Set<string>();
  windows = new Map<
    number,
    {
      strike: number | null;
      source: ContractSnapshot["strikeSource"];
      ticker: string | null;
    }
  >();
  constructor(
    public engine: Engine,
    public config: ContractConfig,
  ) {}
  get synthetic() {
    return this.engine.mode === "replay";
  }
  setQuote(q: ContractQuote) {
    if (this.synthetic && q.source !== "synthetic") return;
    this.quote = q;
  }
  // Mean of observed proxy seconds in [from, to); null below 45 of 60 observations.
  proxyAverage(from: number, to: number) {
    const v = this.bars
      .filter((b) => b.time >= from && b.time < to && b.proxy !== null)
      .map((b) => b.proxy!);
    return v.length >= PROXY_MIN_SAMPLES ? mean(v) : null;
  }
  settle(s: ContractSettlement) {
    if (this.settlements.some((x) => x.id === s.id)) return;
    const proxyStrike = this.proxyAverage(s.window - 60000, s.window),
      proxySettle = this.proxyAverage(
        s.window + WINDOW_MS - 60000,
        s.window + WINDOW_MS,
      ),
      record = { ...s, proxyStrike, proxySettle };
    this.settlements.push(record);
    this.settlements = this.settlements.slice(-20000);
    this.engine.persist("contract_settlements", record.id, s.settled, record);
  }
  bar(now: number, ctx: TickContext) {
    const second = Math.floor(now / 1000) * 1000;
    if (second <= this.lastBar) return;
    const trades = this.engine.trades.filter(
        (t) => t.time > this.lastBar && t.time <= now,
      ),
      notional = (side: string) =>
        trades
          .filter((t) => t.side === side)
          .reduce((a, t) => a + t.price * t.size, 0),
      cb = ctx.priceFresh ? ctx.price : null,
      both = cb !== null && ctx.krakenFresh && ctx.kraken !== null;
    this.bars.push({
      time: second,
      price: cb,
      proxy: cb === null ? null : both ? (cb + ctx.kraken!) / 2 : cb,
      source: cb === null ? null : both ? "CB+KR" : "CB",
      buy: notional("buy"),
      sell: notional("sell"),
      imbalance: ctx.imbalance,
      cvd: this.engine.cvd,
    });
    this.lastBar = second;
    while (this.bars.length && this.bars[0].time < second - 1500000)
      this.bars.shift();
  }
  // Replay only: a labelled synthetic contract priced from the fixture. Never presented as Kalshi.
  syntheticQuote(now: number) {
    const open = windowStart(now),
      close = open + WINDOW_MS,
      last = this.bars.at(-1)?.proxy;
    if (!last) return;
    const strike =
      this.proxyAverage(open - 60000, open) ??
      this.bars.find((b) => b.time >= open && b.proxy)?.proxy ??
      last;
    const returns = this.bars
        .slice(-300)
        .map((b, i, a) =>
          i && b.proxy && a[i - 1].proxy
            ? Math.log(b.proxy / a[i - 1].proxy!)
            : null,
        )
        .filter((x): x is number => x !== null),
      sigma = Math.max(
        1e-5,
        Math.sqrt(mean(returns.map((r) => r * r)) ?? 1e-8),
      ),
      ttc = Math.max(1, secondsToClose(now, close)),
      p = normal(Math.log(last / strike) / (sigma * Math.sqrt(ttc))),
      bid = Math.min(0.97, Math.max(0.01, Math.floor((p - 0.01) * 100) / 100));
    this.quote = {
      ticker: `SYNTHETIC-BTC15M-${new Date(open).toISOString().slice(0, 16)}`,
      event: "SYNTHETIC",
      series: "SYNTHETIC",
      open,
      close,
      strike: Math.round(strike * 100) / 100,
      yesBid: bid,
      yesAsk: Math.round((bid + 0.02) * 100) / 100,
      noBid: Math.round((0.98 - bid) * 100) / 100,
      noAsk: Math.round((1 - bid) * 100) / 100,
      last: null,
      volume: null,
      time: now,
      received: now,
      source: "synthetic",
    };
  }
  syntheticSettle(now: number) {
    const previous = windowStart(now) - WINDOW_MS,
      id = `SYNTHETIC-${previous}`;
    if (
      now < previous + WINDOW_MS + 5000 ||
      this.settlements.some((s) => s.id === id)
    )
      return;
    const strike = this.proxyAverage(previous - 60000, previous),
      settle = this.proxyAverage(
        previous + WINDOW_MS - 60000,
        previous + WINDOW_MS,
      );
    if (strike === null || settle === null) return;
    this.settle({
      id,
      ticker: id,
      window: previous,
      result: resolve(settle, strike),
      expirationValue: Math.round(settle * 100) / 100,
      strike: Math.round(strike * 100) / 100,
      settled: now,
      source: "synthetic",
    });
  }
  tick(now: number, ctx: TickContext): ContractView {
    this.bar(now, ctx);
    if (this.synthetic) {
      this.syntheticQuote(now);
      this.syntheticSettle(now);
      const h = this.engine.healthFor("kalshi");
      h.status = "SYNTHETIC CONTRACT (not Kalshi)";
      h.lastMessage = now;
    }
    const open = windowStart(now),
      close = open + WINDOW_MS,
      q = this.quote?.open === open ? this.quote : null,
      quoteAge = q ? now - q.received : null,
      quoteFresh = q
        ? fresh(q.received, now, this.config.kalshi.freshness)
        : false;
    if (q && quoteFresh && now - this.lastQuoteSaved >= 1000) {
      this.engine.persist(
        "kalshi_quotes",
        `${this.engine.mode}-${q.ticker}-${Math.floor(now / 1000)}`,
        now,
        q,
      );
      this.lastQuoteSaved = now;
    }
    const proxyStrike = this.proxyAverage(open - 60000, open),
      strike = q?.strike ?? proxyStrike,
      last = this.bars.at(-1),
      proxy = last && last.time > now - 2000 ? last.proxy : null,
      distance = strike !== null && proxy !== null ? proxy - strike : null,
      ttc = secondsToClose(now, close),
      latest = this.settlements.at(-1);
    const view: ContractView = {
      status: this.engine.healthFor("kalshi").status,
      synthetic: this.synthetic,
      quote: q,
      quoteAge,
      quoteFresh,
      window: open,
      close,
      ttc,
      bucket: bucketOf(ttc, this.config.buckets),
      buckets: bucketLabels(this.config.buckets),
      strike,
      strikeSource:
        q?.strike != null ? "kalshi" : strike !== null ? "proxy" : null,
      proxy,
      proxySource: proxy !== null ? last!.source : null,
      distance,
      distancePercent: distance !== null ? (distance / strike!) * 100 : null,
      distanceAtr: distance !== null && ctx.atr ? distance / ctx.atr : null,
      settlements: this.settlements.slice(-20),
      basis: {
        note: this.synthetic
          ? "Synthetic replay: settlement and proxy are the same fixture."
          : "Settlement source (CF Benchmarks BRTI) is not observable in real time. The model watches a Coinbase/Kraken proxy; basis is measured at each official strike and settlement.",
        lastOpen:
          q?.strike != null && proxyStrike !== null
            ? q.strike - proxyStrike
            : null,
        lastClose:
          latest?.expirationValue != null && latest.proxySettle != null
            ? latest.expirationValue - latest.proxySettle
            : null,
      },
      outcomes: [],
      agreement: { compared: 0, mismatches: 0 },
      engines: {},
    };
    view.engines = this.readings(now, view, ctx);
    this.record(now, view, ctx);
    this.resolveWindows(now);
    view.outcomes = this.outcomes.slice(-20);
    view.agreement = this.agreement();
    return view;
  }
  // OLS slope of session CVD over the last 60 observed seconds, USD per second.
  cvdSlope() {
    const b = this.bars.slice(-60);
    if (b.length < 30) return null;
    const x = b.map((v) => (v.time - b[0].time) / 1000),
      mx = mean(x)!,
      my = mean(b.map((v) => v.cvd))!,
      d = x.reduce((a, v) => a + (v - mx) ** 2, 0);
    return d
      ? b.reduce((a, v, i) => a + (x[i] - mx) * (v.cvd - my), 0) / d
      : null;
  }
  // Engines are evaluated independently and never averaged together.
  readings(now: number, view: ContractView, ctx: TickContext) {
    return {
      momentum: momentum(ctx.signal),
      fade: fade(this.bars, now, view.ttc, this.config.fade),
    };
  }
  record(now: number, view: ContractView, ctx: TickContext) {
    const second = Math.floor(now / 1000) * 1000;
    if (second <= this.lastSnapshot || view.proxy === null) return;
    this.lastSnapshot = second;
    const q = view.quote,
      bar = this.bars.at(-1)!,
      key = `${view.window}|${view.bucket}`,
      eligible =
        view.bucket !== null &&
        view.strike !== null &&
        ctx.priceFresh &&
        !this.taken.has(key);
    if (eligible) this.taken.add(key);
    if (view.strike !== null)
      this.windows.set(view.window, {
        strike: view.strike,
        source: view.strikeSource,
        ticker: q?.ticker ?? null,
      });
    else if (!this.windows.has(view.window))
      this.windows.set(view.window, {
        strike: null,
        source: null,
        ticker: null,
      });
    const snap: ContractSnapshot = {
      id: `${this.engine.mode}-${second}`,
      time: second,
      mode: this.engine.mode,
      window: view.window,
      close: view.close,
      ttc: view.ttc,
      bucket: view.bucket,
      eligible,
      ticker: q?.ticker ?? null,
      strike: view.strike,
      strikeSource: view.strikeSource,
      price: ctx.priceFresh ? ctx.price : null,
      proxy: view.proxy,
      proxySource: view.proxySource,
      distance: view.distance,
      distancePercent: view.distancePercent,
      distanceAtr: view.distanceAtr,
      features: { ...ctx.features, cvdSlope: this.cvdSlope() },
      quote: q
        ? {
            yesBid: q.yesBid,
            yesAsk: q.yesAsk,
            noBid: q.noBid,
            noAsk: q.noAsk,
            last: q.last,
            age: view.quoteAge,
            source: q.source,
          }
        : null,
      engines: view.engines,
      bar: {
        buy: bar.buy,
        sell: bar.sell,
        imbalance: bar.imbalance,
        cvd: bar.cvd,
      },
      config: { buckets: this.config.buckets, fade: this.config.fade },
    };
    this.engine.persist("contract_snapshots", snap.id, second, snap, !eligible);
    if (eligible) {
      this.samples.push(snap);
      this.samples = this.samples.slice(-20000);
    }
  }
  // Settle every observed window once, ≥1s after close, on the proxy 60s average. Never revised.
  resolveWindows(now: number) {
    for (const [window, w] of this.windows) {
      const close = window + WINDOW_MS;
      if (now < close + 1000) continue;
      this.windows.delete(window);
      const id = `${this.engine.mode}-${window}`;
      if (this.outcomes.some((o) => o.id === id)) continue;
      const tail = this.bars.filter(
          (b) => b.time >= close - 60000 && b.time < close && b.proxy !== null,
        ),
        settle = this.proxyAverage(close - 60000, close),
        complete = settle !== null && w.strike !== null,
        outcome: ContractOutcome = {
          id,
          window,
          close,
          evaluated: now,
          ticker: w.ticker,
          strike: w.strike,
          strikeSource: w.source,
          proxySettle: settle,
          proxySource: tail.some((b) => b.source === "CB")
            ? "CB"
            : tail.length
              ? "CB+KR"
              : null,
          samples: tail.length,
          result: complete ? resolve(settle!, w.strike!) : null,
          status: complete ? "COMPLETE" : "MISSED",
        };
      this.outcomes.push(outcome);
      this.outcomes = this.outcomes.slice(-20000);
      this.engine.persist("contract_outcomes", id, now, outcome);
      this.onOutcome?.(outcome);
    }
  }
  onOutcome?: (o: ContractOutcome) => void;
  restore(state: Partial<ContractCheckpoint> | null) {
    if (!state) return;
    this.samples = state.samples ?? [];
    this.outcomes = state.outcomes ?? [];
    this.settlements = state.settlements ?? [];
    for (const s of this.samples) this.taken.add(`${s.window}|${s.bucket}`);
  }
  checkpoint(): ContractCheckpoint {
    return {
      samples: this.samples,
      outcomes: this.outcomes,
      settlements: this.settlements,
    };
  }
  agreement() {
    let compared = 0,
      mismatches = 0;
    const official = new Map(this.settlements.map((s) => [s.window, s.result]));
    for (const o of this.outcomes)
      if (o.result && official.has(o.window)) {
        compared++;
        if (official.get(o.window) !== o.result) mismatches++;
      }
    return { compared, mismatches };
  }
}
// Abramowitz–Stegun 7.1.26 standard normal CDF, used only to price the synthetic replay contract.
export function normal(x: number) {
  const t = 1 / (1 + 0.3275911 * (Math.abs(x) / Math.SQRT2)),
    y =
      1 -
      ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
        t +
        0.254829592) *
        t *
        Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
