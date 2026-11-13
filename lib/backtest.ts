import { analytics } from "./analytics";
import { Engine } from "../worker/engine";
import { Store } from "../worker/store";
import { replayStep, seedReplay } from "../worker/replay";
// Chunking yields to live feed IO. The backtest owns a separate engine and account.
export async function runFixtureBacktest(seconds = 3600) {
  const store = new Store();
  store.label = "MEMORY ONLY";
  const engine = new Engine("replay", store),
    start = 1800000000000;
  seedReplay(engine, start);
  for (let i = 0; i < seconds; i++) {
    const now = start + i * 1000;
    replayStep(engine, now, i);
    engine.tick(now);
    await engine.drain();
    if (i % 100 === 0)
      await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return {
    fixture:
      "Deterministic synthetic fixture; not evidence of market performance",
    model: "ols10-v1",
    seconds,
    created: Date.now(),
    ...analytics(engine.forecasts, engine.outcomes, engine.paper.state),
  };
}
