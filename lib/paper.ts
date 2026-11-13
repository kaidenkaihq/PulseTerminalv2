import { randomUUID } from "node:crypto";
import type { Mode, PaperState, Position } from "./types";
import { etDay } from "./time";
export class PaperAccount {
  state: PaperState;
  constructor(balance = 10000) {
    this.state = {
      starting: balance,
      balance,
      equity: balance,
      feeBps: 6,
      slippageBps: 2,
      auto: false,
      position: null,
      trades: [],
      curve: [],
      dailyPnl: 0,
      maxDrawdown: 0,
      peakEquity: balance,
    };
  }
  configure(feeBps: number, slippageBps: number, auto: boolean) {
    if (this.state.position)
      throw Error("Close the position before changing execution settings");
    this.state.feeBps = feeBps;
    this.state.slippageBps = slippageBps;
    this.state.auto = auto;
  }
  open(
    direction: Position["direction"],
    size: number,
    price: number,
    stop: number,
    target: number,
    time: number,
    mode: Mode,
    signalId?: string,
  ) {
    const s = this.state;
    if (s.position) throw Error("Only one position may be open");
    if (
      ![size, price, stop, target].every(Number.isFinite) ||
      size <= 0 ||
      price <= 0 ||
      stop <= 0 ||
      target <= 0
    )
      throw Error("Invalid risk parameters");
    const sign = direction === "LONG" ? 1 : -1,
      entry = price * (1 + (sign * s.slippageBps) / 10000),
      fee = (entry * size * s.feeBps) / 10000;
    if (sign * (entry - stop) <= 0 || sign * (target - entry) <= 0)
      throw Error("Stop and target must bracket the slipped entry");
    if (entry * size + fee > s.balance)
      throw Error("Position exceeds available virtual buying power");
    s.balance -= fee;
    s.position = {
      id: randomUUID(),
      direction,
      size,
      entry,
      reference: price,
      stop,
      target,
      opened: time,
      fee,
      mode,
      risk: Math.abs(entry - stop) * size,
      signalId,
    };
    this.mark(price, time);
  }
  close(price: number, time: number, reason = "MANUAL") {
    const s = this.state,
      p = s.position;
    if (!p) throw Error("No position to close");
    const sign = p.direction === "LONG" ? 1 : -1,
      exit = price * (1 - (sign * s.slippageBps) / 10000),
      exitFee = (exit * p.size * s.feeBps) / 10000,
      gross = (exit - p.entry) * p.size * sign,
      pnl = gross - p.fee - exitFee;
    s.balance += gross - exitFee;
    s.trades.push({
      ...p,
      exit,
      closed: time,
      pnl,
      exitFee,
      reason,
      rr: pnl / p.risk,
    });
    s.trades = s.trades.slice(-5000);
    s.position = null;
    this.mark(price, time);
  }
  mark(price: number, time: number) {
    const s = this.state,
      p = s.position;
    if (p) {
      const sign = p.direction === "LONG" ? 1 : -1;
      if (sign * (price - p.stop) <= 0) {
        this.close(price, time, "STOP");
        return;
      }
      if (sign * (price - p.target) >= 0) {
        this.close(price, time, "TARGET");
        return;
      }
    }
    s.equity =
      s.balance +
      (p
        ? (price - p.entry) * p.size * (p.direction === "LONG" ? 1 : -1) -
          (price * p.size * s.feeBps) / 10000
        : 0);
    const day = etDay(time);
    s.dailyPnl = s.trades
      .filter((t) => etDay(t.closed) === day)
      .reduce((a, t) => a + t.pnl, 0);
    const last = s.curve.at(-1);
    if (!last || time - last.time >= 10000)
      s.curve.push({ time, equity: s.equity });
    s.curve = s.curve.slice(-8640);
    const peak = Math.max(
      s.peakEquity ?? s.starting,
      s.equity,
      ...s.curve.map((x) => x.equity),
    );
    s.peakEquity = peak;
    s.maxDrawdown = Math.max(s.maxDrawdown, ((peak - s.equity) / peak) * 100);
  }
}
