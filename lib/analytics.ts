import type { Forecast, Outcome, PaperState } from "./types";
export function analytics(
  forecasts: Forecast[],
  outcomes: Outcome[],
  paper: PaperState,
) {
  const completed = outcomes.filter((x) => x.status === "COMPLETE"),
    errors = completed.map((x) => x.absoluteError!).sort((a, b) => a - b),
    median = errors.length
      ? (errors[Math.floor((errors.length - 1) / 2)] +
          errors[Math.floor(errors.length / 2)]) /
        2
      : null;
  const regimes = ["LOW", "NORMAL", "HIGH"].map((regime) => {
    const ids = new Set(
        forecasts.filter((f) => f.regime === regime).map((f) => f.id),
      ),
      o = completed.filter((x) => ids.has(x.id));
    return {
      regime,
      n: o.length,
      accuracy: o.length
        ? (o.filter((x) => x.correct).length / o.length) * 100
        : null,
    };
  });
  const strategy = paper.trades.filter((t) => t.signalId);
  return {
    n: completed.length,
    accuracy: completed.length
      ? (completed.filter((x) => x.correct).length / completed.length) * 100
      : null,
    mae: errors.length
      ? errors.reduce((a, b) => a + b, 0) / errors.length
      : null,
    median,
    missed: outcomes.filter((x) => x.status === "MISSED").length,
    regimes,
    net: paper.balance - paper.starting,
    drawdown: paper.maxDrawdown,
    rr: paper.trades.length
      ? paper.trades.reduce((a, t) => a + t.rr, 0) / paper.trades.length
      : null,
    signalN: strategy.length,
    signalHit: strategy.length
      ? (strategy.filter((t) => t.pnl > 0).length / strategy.length) * 100
      : null,
  };
}
