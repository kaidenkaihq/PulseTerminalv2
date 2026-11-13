import { predict, type CalibrationCell } from "./calibration";
import { kalshiFee } from "./contracts";
import { ENGINE_LABEL, type EngineName } from "./engines";
import type { ContractQuote, EngineReading } from "./types";
export type Fees = { rate: number; multiplier: number; precision: number };
export type SideEdge = {
  side: "UP" | "DOWN";
  modelP: number | null;
  ask: number | null;
  fee: number | null;
  marketP: number | null;
  edge: number | null;
};
export type EngineView = {
  name: EngineName;
  label: string;
  reading: EngineReading;
  status: CalibrationCell["status"];
  n: number;
  p: number | null;
  recentBrier: number | null;
  up: SideEdge;
  down: SideEdge;
};
export type Verdict = {
  action: "BUY YES" | "BUY NO" | "NO TRADE";
  side: "UP" | "DOWN" | null;
  engine: EngineName | null;
  edge: number | null;
  modelP: number | null;
  marketP: number | null;
  reasons: string[];
  disagreement: string | null;
};
export type VerdictInput = {
  bucket: string | null;
  readings: Partial<Record<EngineName, EngineReading>>;
  cells: CalibrationCell[];
  quote: ContractQuote | null;
  quoteFresh: boolean;
  coinbaseFresh: boolean;
  confirmation: string;
  contracts: number;
  fees: Fees;
  minEdge: number;
};
// Market probability is what a buyer actually pays: the ask plus Kalshi's per-contract fee.
export function marketCost(ask: number | null, contracts: number, f: Fees) {
  if (ask == null || ask <= 0 || ask >= 1) return { fee: null, cost: null };
  const fee =
    kalshiFee(contracts, ask, f.rate, f.multiplier, f.precision) / contracts;
  return { fee, cost: ask + fee };
}
function side(
  s: "UP" | "DOWN",
  modelP: number | null,
  ask: number | null,
  input: VerdictInput,
): SideEdge {
  const { fee, cost } = marketCost(ask, input.contracts, input.fees);
  return {
    side: s,
    modelP,
    ask,
    fee,
    marketP: cost,
    edge: modelP !== null && cost !== null ? modelP - cost : null,
  };
}
const pct = (v: number) => v.toFixed(2);
export function decide(input: VerdictInput): {
  engines: EngineView[];
  verdict: Verdict;
} {
  const engines: EngineView[] = (
    Object.keys(input.readings) as EngineName[]
  ).map((name) => {
    const reading = input.readings[name]!,
      cell = input.cells.find(
        (c) => c.engine === name && c.bucket === input.bucket,
      ),
      p =
        cell?.model && reading.score !== null
          ? predict(cell.model, reading.score)
          : null;
    return {
      name,
      label: ENGINE_LABEL[name],
      reading,
      status: cell?.status ?? "UNCALIBRATED",
      n: cell?.n ?? 0,
      p,
      recentBrier: cell?.recentBrier ?? null,
      up: side("UP", p, input.quote?.yesAsk ?? null, input),
      down: side(
        "DOWN",
        p === null ? null : 1 - p,
        input.quote?.noAsk ?? null,
        input,
      ),
    };
  });
  const directional = engines.filter(
      (e) => e.reading.state === "UP" || e.reading.state === "DOWN",
    ),
    calibrated = engines.filter(
      (e) => e.status === "CALIBRATED" && e.p !== null,
    ),
    best = [...calibrated].sort(
      (a, b) => (a.recentBrier ?? 1) - (b.recentBrier ?? 1),
    )[0];
  let disagreement: string | null = null;
  if (
    directional.length === 2 &&
    directional[0].reading.state !== directional[1].reading.state
  ) {
    const head = directional
      .map((e) => `${e.label} ${e.reading.state}`)
      .join(" / ");
    disagreement = best
      ? `${head} — ${best.label} has the better Brier in this bucket`
      : `${head} — neither is calibrated in this bucket`;
  }
  const reasons: string[] = [];
  if (!input.bucket) reasons.push("Between windows");
  if (!input.quote || !input.quoteFresh) reasons.push("Kalshi stale");
  if (!input.coinbaseFresh) reasons.push("Coinbase stale");
  if (input.confirmation !== "CONFIRMED")
    reasons.push(`Confirmation ${input.confirmation.toLowerCase()}`);
  for (const e of engines)
    if (e.status !== "CALIBRATED" && input.bucket)
      reasons.push(
        `${e.label.toLowerCase()} uncalibrated in ${input.bucket} (n=${e.n})`,
      );
  const pick =
    best && (best.up.edge ?? -1) >= (best.down.edge ?? -1)
      ? best.up
      : best?.down;
  if (best && pick && (pick.edge ?? -1) < input.minEdge)
    reasons.push(
      `edge ${pick.edge === null ? "unavailable" : pct(pick.edge)} < ${pct(input.minEdge)}`,
    );
  const blocking =
    !best ||
    !pick ||
    (pick.edge ?? -1) < input.minEdge ||
    !input.bucket ||
    !input.quoteFresh ||
    !input.quote ||
    !input.coinbaseFresh ||
    input.confirmation !== "CONFIRMED";
  if (blocking)
    return {
      engines,
      verdict: {
        action: "NO TRADE",
        side: null,
        engine: best?.name ?? null,
        edge: pick?.edge ?? null,
        modelP: pick?.modelP ?? null,
        marketP: pick?.marketP ?? null,
        reasons: reasons.length ? reasons : ["No calibrated engine"],
        disagreement,
      },
    };
  return {
    engines,
    verdict: {
      action: pick!.side === "UP" ? "BUY YES" : "BUY NO",
      side: pick!.side,
      engine: best!.name,
      edge: pick!.edge,
      modelP: pick!.modelP,
      marketP: pick!.marketP,
      reasons: [
        `${best!.label} calibrated in ${input.bucket} (n=${best!.n}), edge ${pct(pick!.edge!)} ≥ ${pct(input.minEdge)}`,
      ],
      disagreement,
    },
  };
}
