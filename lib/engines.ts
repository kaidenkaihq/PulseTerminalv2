import type { EngineReading, Signal } from "./types";
export const ENGINES = ["momentum", "fade"] as const;
export type EngineName = (typeof ENGINES)[number];
export const ENGINE_LABEL: Record<EngineName, string> = {
  momentum: "Momentum",
  fade: "Panic-Fade",
};
// momentum-v1 is the unchanged lib/signals.ts composite, read per seconds-to-close bucket.
export function momentum(s: Signal): EngineReading {
  return {
    engine: "momentum-v1",
    state:
      s.state === "LONG"
        ? "UP"
        : s.state === "SHORT"
          ? "DOWN"
          : s.state === "NEUTRAL"
            ? "NEUTRAL"
            : "INSUFFICIENT DATA",
    score: s.score,
    reason: s.reason,
  };
}
