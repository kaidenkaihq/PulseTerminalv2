import { mkdir, writeFile } from "node:fs/promises";
import { Engine } from "../worker/engine";
import { Store } from "../worker/store";
import { seedReplay, replayStep } from "../worker/replay";
import { analytics } from "../lib/analytics";
const store = new Store();
store.label = "MEMORY ONLY";
const e = new Engine("replay", store),
  start = 1800000000000;
seedReplay(e, start);
for (let second = 0; second < 3600; second++) {
  const now = start + second * 1000;
  replayStep(e, now, second);
  e.tick(now);
  await e.drain();
}
const report = {
  fixture: "deterministic synthetic, not historical exchange data",
  model: "ols10-v1",
  durationSeconds: 3600,
  ...analytics(e.forecasts, e.outcomes, e.paper.state),
};
await mkdir("data", { recursive: true });
await writeFile("data/walk-forward.json", JSON.stringify(report, null, 2));
await writeFile(
  "data/walk-forward-forecasts.json",
  JSON.stringify({ forecasts: e.forecasts, outcomes: e.outcomes }, null, 2),
);
console.log(JSON.stringify(report, null, 2));
