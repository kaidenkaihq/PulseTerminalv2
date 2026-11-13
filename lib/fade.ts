import { clamp } from "./math";
import type { EngineReading } from "./types";
// fade-v1: fade a statistically large move once aggressor flow is exhausting or the book flips.
// Default thresholds are the configurable starting point from the v2 brief, not the owner's research.
export type FadeConfig = {
  sigma: number;
  windowS: number;
  exhaustion: number;
  ttcMin: number;
  ttcMax: number;
  lookbackMin: number;
};
export type FadeBar = {
  time: number;
  proxy: number | null;
  buy: number;
  sell: number;
  imbalance: number | null;
};
export type FadeReading = EngineReading & {
  details: {
    z: number | null;
    sigma1m: number | null;
    move: number | null;
    peakShare: number | null;
    latestShare: number | null;
    imbalance: number | null;
  };
};
export function fade(
  all: FadeBar[],
  now: number,
  ttc: number,
  cfg: FadeConfig,
): FadeReading {
  const empty: FadeReading["details"] = {
      z: null,
      sigma1m: null,
      move: null,
      peakShare: null,
      latestShare: null,
      imbalance: null,
    },
    out = (
      state: EngineReading["state"],
      score: number | null,
      reason: string,
      details = empty,
    ): FadeReading => ({ engine: "fade-v1", state, score, reason, details });
  const span = cfg.lookbackMin * 60000,
    // No lookahead: only seconds at or before `now` are visible.
    bars = all.filter((b) => b.time <= now && b.time > now - span - 60000),
    last = bars.at(-1);
  if (!last || now - last.time > 2000 || last.proxy === null)
    return out("INSUFFICIENT DATA", null, "Proxy price is stale.");
  const observed = bars.filter(
    (b) => b.time > now - span && b.proxy !== null,
  ).length;
  if (observed < 0.8 * cfg.lookbackMin * 60)
    return out(
      "INSUFFICIENT DATA",
      null,
      `Needs ${cfg.lookbackMin} minutes of 1s prices (80% coverage).`,
    );
  const at = (t: number) => {
    for (let i = bars.length - 1; i >= 0; i--)
      if (bars[i].time <= t) {
        return t - bars[i].time <= 2000 ? bars[i].proxy : null;
      }
    return null;
  };
  const returns: number[] = [];
  for (let k = 1; k <= cfg.lookbackMin; k++) {
    const a = at(now - k * 60000),
      b = at(now - (k - 1) * 60000);
    if (a && b) returns.push(Math.log(b / a));
  }
  const sigma = Math.sqrt(
    returns.reduce((s, r) => s + r * r, 0) / Math.max(1, returns.length),
  );
  const base = at(now - cfg.windowS * 1000);
  if (returns.length < 0.7 * cfg.lookbackMin || !sigma || !base)
    return out("INSUFFICIENT DATA", null, "Not enough 1-minute returns.");
  const move = Math.log(last.proxy / base),
    z = move / (sigma * Math.sqrt(cfg.windowS / 60)),
    details: FadeReading["details"] = {
      ...empty,
      z,
      sigma1m: sigma,
      move,
      imbalance: last.imbalance,
    };
  if (ttc < cfg.ttcMin || ttc > cfg.ttcMax)
    return out(
      "NO SETUP",
      0,
      `Outside fade window (${cfg.ttcMin}–${cfg.ttcMax}s to close).`,
      details,
    );
  if (Math.abs(z) < cfg.sigma)
    return out(
      "NO SETUP",
      0,
      `Move ${z.toFixed(1)}σ is below ${cfg.sigma}σ.`,
      details,
    );
  const dir = Math.sign(move),
    share = (t: number) => {
      let w = 0,
        total = 0;
      for (const b of bars)
        if (b.time > t - 10000 && b.time <= t) {
          w += dir > 0 ? b.buy : b.sell;
          total += b.buy + b.sell;
        }
      return total ? w / total : null;
    };
  const shares = bars
      .filter((b) => b.time > now - cfg.windowS * 1000)
      .map((b) => share(b.time))
      .filter((x): x is number => x !== null),
    peak = shares.length ? Math.max(...shares) : null,
    latest = share(now),
    drop = peak && latest !== null ? (peak - latest) / peak : 0,
    flow = peak !== null && peak >= 0.55 && drop >= cfg.exhaustion,
    flip =
      last.imbalance !== null &&
      Math.sign(last.imbalance) === -dir &&
      Math.abs(last.imbalance) >= 0.1;
  details.peakShare = peak;
  details.latestShare = latest;
  if (!flow && !flip)
    return out(
      "NO SETUP",
      0,
      `${z.toFixed(1)}σ move, but flow is not exhausting and the book has not flipped.`,
      details,
    );
  const strength = Math.max(
      flow ? Math.min(1, drop / (2 * cfg.exhaustion)) : 0,
      flip ? Math.min(1, Math.abs(last.imbalance!)) : 0,
    ),
    magnitude = clamp(
      0.5 * Math.min(1, Math.abs(z) / (2 * cfg.sigma)) + 0.5 * strength,
      0,
      1,
    ),
    score = -dir * magnitude;
  return out(
    score > 0 ? "UP" : "DOWN",
    score,
    `Fade ${dir > 0 ? "rally" : "drop"}: ${z.toFixed(1)}σ move with ${flow ? "aggressor exhaustion" : "book flip"}.`,
    details,
  );
}
