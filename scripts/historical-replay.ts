import { readFile, mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { Engine } from "../worker/engine";
import { Store } from "../worker/store";
import { analytics } from "../lib/analytics";
const file = process.argv[2];
if (!file)
  throw Error("Usage: npm run replay:historical -- path/to/trades.json");
// Input must contain already normalized aggressor-side BTC trades, UTC epoch milliseconds.
const positive = z.number().finite().positive();
const trades = z
  .array(
    z.object({
      id: z.string(),
      symbol: z.literal("BTC-USD"),
      time: z.number().int().positive(),
      price: positive,
      size: positive,
      side: z.enum(["buy", "sell"]),
    }),
  )
  .min(60)
  .parse(JSON.parse(await readFile(file, "utf8")));
if (trades.some((t, i) => i > 0 && t.time < trades[i - 1].time))
  throw Error("Input must be chronological; out-of-order input is rejected");
const store = new Store();
store.label = "MEMORY ONLY";
const engine = new Engine("replay", store);
let tick = trades[0].time,
  index = 0;
for (; tick <= trades.at(-1)!.time; tick += 1000) {
  while (index < trades.length && trades[index].time <= tick) {
    engine.trade(trades[index], trades[index].time);
    index++;
  }
  engine.tick(tick);
  await engine.drain();
}
const report = {
  dataset: file,
  source:
    "User-supplied historical trades; no synthetic fills or book reconstruction",
  model: "ols10-v1",
  ...analytics(engine.forecasts, engine.outcomes, engine.paper.state),
  limitation:
    "Trade-only input validates price extrapolations. Historical book is absent: 15m trading signals remain insufficient. No fictitious historical aggressor volume is inferred from candles.",
};
await mkdir("data", { recursive: true });
await writeFile("data/historical-report.json", JSON.stringify(report, null, 2));
await writeFile(
  "data/historical-forecasts.json",
  JSON.stringify(
    { forecasts: engine.forecasts, outcomes: engine.outcomes },
    null,
    2,
  ),
);
console.log(JSON.stringify(report, null, 2));
