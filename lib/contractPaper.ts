import { randomUUID } from "node:crypto";
import { kalshiFee } from "./contracts";
import type { Fees } from "./verdict";
import type {
  ContractPaperState,
  ContractPosition,
  ContractQuote,
  ContractTrade,
  Mode,
} from "./types";
// Simulated Kalshi contract account. Separate from the spot PaperAccount; never places real orders.
export type ExitContext = {
  side: "UP" | "DOWN";
  entry: number;
  bid: number | null;
  peakBid: number;
  ttc: number;
  contracts: number;
};
export interface ExitPolicy {
  name: string;
  // True while the owner's stop-loss phases / ratchet levels have not been supplied.
  placeholder: boolean;
  rules(): string[];
  decide(ctx: ExitContext): { exit: boolean; reason: string };
}
// Owner rule (confirmed 2026-11-13): always take profit when the held side's bid reaches 97¢.
export const TAKE_PROFIT = 0.97;
// TODO(owner): supply the stop-loss phase rules and ratchet levels from your Kalshi exit engine.
// Until then CONTRACT_EXIT_PHASES and CONTRACT_RATCHET are empty and positions hold to settlement
// unless the 97¢ take-profit fires. No numbers are invented here.
export class OwnerExitPolicy implements ExitPolicy {
  name = "owner-exit-v1";
  constructor(
    // [secondsToCloseAtOrBelow, stopBid]: inside that phase, exit if bid ≤ stopBid.
    public phases: [number, number][] = [],
    // [peakBidTrigger, floorBid]: once the bid has reached the trigger, exit if it falls to the floor.
    public ratchet: [number, number][] = [],
  ) {}
  get placeholder() {
    return !this.phases.length && !this.ratchet.length;
  }
  rules() {
    return [
      `Take profit: sell when bid ≥ ${Math.round(TAKE_PROFIT * 100)}¢ (owner rule)`,
      this.phases.length
        ? `Stop-loss phases: ${this.phases.map(([t, s]) => `≤${t}s → bid ≤ ${s}`).join(", ")}`
        : "Stop-loss phases: NOT SUPPLIED (placeholder: none applied)",
      this.ratchet.length
        ? `Ratchet: ${this.ratchet.map(([t, f]) => `peak ≥ ${t} → floor ${f}`).join(", ")}`
        : "Ratchet: NOT SUPPLIED (placeholder: none applied)",
      "Otherwise hold to settlement ($1 / $0)",
    ];
  }
  decide(c: ExitContext) {
    if (c.bid === null) return { exit: false, reason: "No bid" };
    if (c.bid >= TAKE_PROFIT)
      return {
        exit: true,
        reason: `TAKE PROFIT ${Math.round(TAKE_PROFIT * 100)}¢`,
      };
    const floor = Math.max(
      -Infinity,
      ...this.ratchet.filter(([t]) => c.peakBid >= t).map(([, f]) => f),
    );
    if (c.bid <= floor)
      return { exit: true, reason: `RATCHET floor ${floor.toFixed(2)}` };
    const phase = this.phases
      .filter(([t]) => c.ttc <= t)
      .sort((a, b) => a[0] - b[0])[0];
    if (phase && c.bid <= phase[1])
      return {
        exit: true,
        reason: `STOP ≤${phase[0]}s at ${phase[1].toFixed(2)}`,
      };
    return { exit: false, reason: "Hold" };
  }
}
export type EntryMeta = {
  engine: string;
  bucket: string | null;
  edge: number | null;
  modelP: number | null;
  marketP: number | null;
  auto: boolean;
};
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
export class ContractPaper {
  state: ContractPaperState;
  constructor(
    cfg: {
      balance: number;
      contracts: number;
      maxStake: number;
      maxDailyLoss: number;
    },
    public policy: ExitPolicy,
    public fees: () => Fees,
  ) {
    this.state = {
      starting: cfg.balance,
      balance: cfg.balance,
      equity: cfg.balance,
      auto: false,
      contracts: cfg.contracts,
      maxStake: cfg.maxStake,
      maxDailyLoss: cfg.maxDailyLoss,
      position: null,
      trades: [],
      curve: [],
      dailyPnl: 0,
      traded: [],
      policy: this.describe(),
    };
  }
  describe() {
    return {
      name: this.policy.name,
      placeholder: this.policy.placeholder,
      rules: this.policy.rules(),
    };
  }
  fee(contracts: number, price: number) {
    const f = this.fees();
    return kalshiFee(contracts, price, f.rate, f.multiplier, f.precision);
  }
  configure(c: {
    contracts: number;
    maxStake: number;
    maxDailyLoss: number;
    auto: boolean;
  }) {
    if (this.state.position)
      throw Error("Close the position before changing contract settings");
    Object.assign(this.state, c);
  }
  open(
    side: "UP" | "DOWN",
    quote: ContractQuote,
    now: number,
    mode: Mode,
    meta: EntryMeta,
  ) {
    const s = this.state,
      ask = side === "UP" ? quote.yesAsk : quote.noAsk;
    if (s.position) throw Error("Only one contract position may be open");
    if (s.traded.includes(quote.open))
      throw Error("One position per window: this window was already traded");
    if (now >= quote.close || now < quote.open)
      throw Error("Contract window is not open");
    if (ask == null || ask <= 0 || ask >= 1)
      throw Error("No tradable ask for that side");
    this.updateDaily(now);
    if (s.dailyPnl <= -s.maxDailyLoss)
      throw Error(
        "Daily loss limit reached; entries paused until UTC midnight",
      );
    const entryFee = this.fee(s.contracts, ask),
      cost = s.contracts * ask + entryFee;
    if (cost > s.maxStake)
      throw Error(
        `Stake $${cost.toFixed(2)} exceeds max $${s.maxStake} per window`,
      );
    if (cost > s.balance) throw Error("Stake exceeds virtual balance");
    s.balance -= cost;
    s.traded = [...s.traded, quote.open].slice(-200);
    s.position = {
      id: randomUUID(),
      window: quote.open,
      ticker: quote.ticker,
      side,
      contracts: s.contracts,
      entry: ask,
      entryFee,
      cost,
      opened: now,
      mode,
      ...meta,
      peakBid: (side === "UP" ? quote.yesBid : quote.noBid) ?? 0,
    };
    return s.position;
  }
  private finish(exit: number, exitFee: number, now: number, reason: string) {
    const s = this.state,
      p = s.position!,
      proceeds = p.contracts * exit - exitFee,
      pnl = proceeds - p.cost,
      trade: ContractTrade = {
        ...p,
        exit,
        exitFee,
        proceeds,
        pnl,
        closed: now,
        reason,
        realizedEdge: pnl / p.contracts,
      };
    s.balance += proceeds;
    s.trades = [...s.trades, trade].slice(-5000);
    s.position = null;
    this.updateDaily(now);
    return trade;
  }
  // Early exit sells the held side at its bid, paying the taker fee.
  sell(quote: ContractQuote, now: number, reason = "MANUAL") {
    const p = this.state.position;
    if (!p) throw Error("No contract position to close");
    if (quote.open !== p.window)
      throw Error("Position's market is closed; awaiting settlement");
    const bid = p.side === "UP" ? quote.yesBid : quote.noBid;
    if (bid == null || bid <= 0) throw Error("No bid to sell into");
    return this.finish(bid, this.fee(p.contracts, bid), now, reason);
  }
  // Settlement pays $1 per contract on the winning side and $0 otherwise; no settlement fee.
  settle(window: number, result: "UP" | "DOWN", now: number, source: string) {
    const p = this.state.position;
    if (!p || p.window !== window) return null;
    const win = p.side === result;
    return this.finish(
      win ? 1 : 0,
      0,
      now,
      `SETTLED ${win ? "WIN" : "LOSS"} (${source})`,
    );
  }
  mark(quote: ContractQuote | null, ttc: number, now: number) {
    const s = this.state,
      p = s.position;
    let closed: ContractTrade | null = null;
    const live =
        p && quote && quote.open === p.window && ttc > 0 ? quote : null,
      bid = live ? (p!.side === "UP" ? live.yesBid : live.noBid) : null;
    if (p && live && bid != null) {
      p.peakBid = Math.max(p.peakBid, bid);
      const d = this.policy.decide({
        side: p.side,
        entry: p.entry,
        bid,
        peakBid: p.peakBid,
        ttc,
        contracts: p.contracts,
      });
      if (d.exit) closed = this.sell(live, now, d.reason);
    }
    const open = s.position;
    s.equity =
      s.balance +
      (open
        ? bid != null && open === p
          ? open.contracts * bid - this.fee(open.contracts, bid)
          : open.cost
        : 0);
    this.updateDaily(now);
    const last = s.curve.at(-1);
    if (!last || now - last.time >= 10000)
      s.curve = [...s.curve, { time: now, equity: s.equity }].slice(-8640);
    return closed;
  }
  updateDaily(now: number) {
    const today = day(now);
    this.state.dailyPnl = this.state.trades
      .filter((t) => day(t.closed) === today)
      .reduce((a, t) => a + t.pnl, 0);
  }
}
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
export function contractMetrics(trades: ContractTrade[]) {
  const group = (key: (t: ContractTrade) => string) =>
    Object.entries(
      trades.reduce<Record<string, ContractTrade[]>>((g, t) => {
        (g[key(t)] ??= []).push(t);
        return g;
      }, {}),
    ).map(([name, ts]) => ({
      name,
      n: ts.length,
      pnl: sum(ts.map((t) => t.pnl)),
      hitRate: ts.filter((t) => t.pnl > 0).length / ts.length,
    }));
  const withEdge = trades.filter((t) => t.edge !== null),
    contracts = sum(trades.map((t) => t.contracts));
  return {
    n: trades.length,
    pnl: sum(trades.map((t) => t.pnl)),
    roiPerContract: contracts
      ? sum(trades.map((t) => t.pnl)) / contracts
      : null,
    hitRate: trades.length
      ? trades.filter((t) => t.pnl > 0).length / trades.length
      : null,
    edgeAtEntry: withEdge.length
      ? sum(withEdge.map((t) => t.edge!)) / withEdge.length
      : null,
    realizedEdge: withEdge.length
      ? sum(withEdge.map((t) => t.realizedEdge)) / withEdge.length
      : null,
    byEngine: group((t) => t.engine),
    byBucket: group((t) => t.bucket ?? "—"),
  };
}
