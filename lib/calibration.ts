import type {
  ContractOutcome,
  ContractSettlement,
  ContractSnapshot,
} from "./types";
// calib-v1: raw engine score → P(UP) per engine × seconds-to-close bucket, walk-forward only.
export const CALIBRATION_VERSION = "calib-isotonic-v1";
export type Row = {
  window: number;
  bucket: string;
  scores: Record<string, number | null>;
  y: 0 | 1;
  official: boolean;
};
export type Model =
  | { kind: "base"; p: number }
  | { kind: "logistic"; a: number; b: number }
  | { kind: "isotonic"; xs: number[]; ys: number[] };
export type CalibrationCell = {
  engine: string;
  bucket: string;
  status: "CALIBRATED" | "UNCALIBRATED";
  n: number;
  windows: number;
  hitRate: number | null;
  brier: number | null;
  logLoss: number | null;
  baselineBrier: number | null;
  recentBrier: number | null;
  recentBaseline: number | null;
  reliability: {
    lo: number;
    hi: number;
    n: number;
    predicted: number;
    observed: number;
  }[];
  kind: Model["kind"] | null;
  model: Model | null;
};
export type CalibrationSettings = {
  minN: number;
  refitEvery: number;
  recentN: number;
};
const MIN_TRAIN = 20,
  ISOTONIC_MIN = 100,
  P_MIN = 0.01,
  P_MAX = 0.99;
// One row per window × bucket (the earliest eligible snapshot). The official Kalshi result wins over the proxy.
export function dataset(
  samples: ContractSnapshot[],
  outcomes: ContractOutcome[],
  settlements: ContractSettlement[],
): Row[] {
  const proxy = new Map(
      outcomes.filter((o) => o.result).map((o) => [o.window, o.result!]),
    ),
    official = new Map(settlements.map((s) => [s.window, s.result])),
    first = new Map<string, ContractSnapshot>();
  for (const s of samples) {
    if (!s.eligible || !s.bucket) continue;
    const key = `${s.window}|${s.bucket}`,
      seen = first.get(key);
    if (!seen || s.time < seen.time) first.set(key, s);
  }
  const rows: Row[] = [];
  for (const s of first.values()) {
    const result = official.get(s.window) ?? proxy.get(s.window);
    if (!result) continue;
    rows.push({
      window: s.window,
      bucket: s.bucket!,
      scores: Object.fromEntries(
        Object.entries(s.engines).map(([k, v]) => [k, v.score]),
      ),
      y: result === "UP" ? 1 : 0,
      official: official.has(s.window),
    });
  }
  return rows.sort((a, b) => a.window - b.window);
}
// Pool-adjacent-violators: the least-squares non-decreasing step function of score.
export function isotonic(points: { x: number; y: number }[]): Model {
  const sorted = [...points].sort((a, b) => a.x - b.x),
    blocks: { sum: number; w: number; hi: number }[] = [];
  for (const p of sorted) {
    blocks.push({ sum: p.y, w: 1, hi: p.x });
    while (
      blocks.length > 1 &&
      blocks.at(-2)!.sum / blocks.at(-2)!.w >=
        blocks.at(-1)!.sum / blocks.at(-1)!.w
    ) {
      const b = blocks.pop()!,
        a = blocks.at(-1)!;
      a.sum += b.sum;
      a.w += b.w;
      a.hi = b.hi;
    }
  }
  return {
    kind: "isotonic",
    xs: blocks.map((b) => b.hi),
    ys: blocks.map((b) => b.sum / b.w),
  };
}
// 1-D logistic (Platt) regression by Newton's method with a small ridge penalty, for small n.
export function logistic(points: { x: number; y: number }[]): Model {
  let a = 0,
    b = 0;
  for (let it = 0; it < 50; it++) {
    let ga = 0,
      gb = 0,
      haa = 1e-3,
      hab = 0,
      hbb = 1e-3;
    for (const { x, y } of points) {
      const p = 1 / (1 + Math.exp(-(a + b * x))),
        w = p * (1 - p);
      ga += p - y;
      gb += (p - y) * x;
      haa += w;
      hab += w * x;
      hbb += w * x * x;
    }
    ga += 1e-3 * a;
    gb += 1e-3 * b;
    const det = haa * hbb - hab * hab;
    if (!det) break;
    const da = (hbb * ga - hab * gb) / det,
      db = (haa * gb - hab * ga) / det;
    a -= da;
    b -= db;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  return { kind: "logistic", a, b };
}
export function fit(points: { x: number; y: number }[]): Model {
  if (points.length < MIN_TRAIN)
    return {
      kind: "base",
      p: points.length
        ? points.reduce((s, p) => s + p.y, 0) / points.length
        : 0.5,
    };
  return points.length < ISOTONIC_MIN ? logistic(points) : isotonic(points);
}
export function predict(model: Model, x: number) {
  let p: number;
  if (model.kind === "base") p = model.p;
  else if (model.kind === "logistic")
    p = 1 / (1 + Math.exp(-(model.a + model.b * x)));
  else {
    const i = model.xs.findIndex((hi) => x <= hi);
    p = model.ys[i === -1 ? model.ys.length - 1 : i];
  }
  return Math.min(P_MAX, Math.max(P_MIN, p));
}
// Each window is predicted by a model fit only on windows before the latest scheduled refit.
export function walkForward(
  rows: { window: number; x: number; y: 0 | 1 }[],
  refitEvery: number,
) {
  const preds: { window: number; p: number; base: number; y: 0 | 1 }[] = [];
  let model: Model | null = null,
    base = 0.5,
    fittedAt = -1;
  for (let i = 0; i < rows.length; i++) {
    const at = Math.floor(i / refitEvery) * refitEvery;
    if (at !== fittedAt) {
      const train = rows.slice(0, at);
      fittedAt = at;
      model = train.length >= MIN_TRAIN ? fit(train) : null;
      base = train.length
        ? train.reduce((s, r) => s + r.y, 0) / train.length
        : 0.5;
    }
    if (model)
      preds.push({
        window: rows[i].window,
        p: predict(model, rows[i].x),
        base: Math.min(P_MAX, Math.max(P_MIN, base)),
        y: rows[i].y,
      });
  }
  return preds;
}
const avg = (v: number[]) =>
  v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
export function metrics(preds: { p: number; base: number; y: 0 | 1 }[]) {
  const brier = avg(preds.map((r) => (r.p - r.y) ** 2)),
    baselineBrier = avg(preds.map((r) => (r.base - r.y) ** 2)),
    logLoss = avg(preds.map((r) => -(r.y ? Math.log(r.p) : Math.log(1 - r.p)))),
    hitRate = avg(preds.map((r) => ((r.p >= 0.5 ? 1 : 0) === r.y ? 1 : 0))),
    reliability = Array.from({ length: 10 }, (_, i) => {
      const lo = i / 10,
        hi = (i + 1) / 10,
        bin = preds.filter(
          (r) => r.p >= lo && (i === 9 ? r.p <= hi : r.p < hi),
        );
      return {
        lo,
        hi,
        n: bin.length,
        predicted: avg(bin.map((r) => r.p)) ?? (lo + hi) / 2,
        observed: avg(bin.map((r) => r.y)) ?? 0,
      };
    }).filter((b) => b.n);
  return { brier, baselineBrier, logLoss, hitRate, reliability };
}
export function calibrate(
  all: Row[],
  engine: string,
  bucket: string,
  cfg: CalibrationSettings,
): CalibrationCell {
  const rows = all
      .filter((r) => r.bucket === bucket && r.scores[engine] != null)
      .map((r) => ({ window: r.window, x: r.scores[engine]!, y: r.y })),
    preds = walkForward(rows, cfg.refitEvery),
    m = metrics(preds),
    recent = metrics(preds.slice(-cfg.recentN)),
    // No live probability until there are enough windows to fit anything but a raw base rate.
    model = rows.length >= MIN_TRAIN ? fit(rows) : null,
    calibrated =
      preds.length >= cfg.minN &&
      m.brier !== null &&
      m.baselineBrier !== null &&
      m.brier < m.baselineBrier;
  return {
    engine,
    bucket,
    status: calibrated ? "CALIBRATED" : "UNCALIBRATED",
    n: preds.length,
    windows: rows.length,
    hitRate: m.hitRate,
    brier: m.brier,
    logLoss: m.logLoss,
    baselineBrier: m.baselineBrier,
    recentBrier: recent.brier,
    recentBaseline: recent.baselineBrier,
    reliability: m.reliability,
    kind: model?.kind ?? null,
    model,
  };
}
export function calibrationTable(
  rows: Row[],
  engines: readonly string[],
  buckets: string[],
  cfg: CalibrationSettings,
) {
  return engines.flatMap((e) => buckets.map((b) => calibrate(rows, e, b, cfg)));
}
