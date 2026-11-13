import "dotenv/config";
import { createReadStream } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { contractConfig } from "../lib/contractConfig";
import { bucketLabels } from "../lib/contracts";
import {
  calibrationTable,
  dataset,
  CALIBRATION_VERSION,
} from "../lib/calibration";
import { ENGINES } from "../lib/engines";
import { fade, type FadeBar } from "../lib/fade";
import type {
  ContractOutcome,
  ContractSettlement,
  ContractSnapshot,
} from "../lib/types";
// Rebuilds contract samples and calibration from local journals using the CURRENT .env thresholds,
// so fade/calibration rule changes can be re-tested on logged history without waiting for new windows.
// Usage: npm run contracts:rebuild -- [--dir ./data] [--mode live]
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const dir = arg("dir", process.env.LOCAL_DATA_DIR || "./data"),
  mode = arg("mode", "live"),
  config = contractConfig();
const snapshots = new Map<string, ContractSnapshot>(),
  seconds = new Map<string, FadeBar>(),
  outcomes = new Map<string, ContractOutcome>(),
  settlements = new Map<string, ContractSettlement>();
const files = (await readdir(dir))
  .filter((n) => /^(events|ticks)-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
  .sort();
for (const name of files) {
  const lines = createInterface({
    input: createReadStream(path.join(dir, name)),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row.mode !== mode) continue;
      if (row.table === "contract_snapshots") {
        const snap = row.payload as ContractSnapshot;
        // Only metric samples are kept whole; other seconds keep just what fade needs.
        seconds.set(row.id, {
          time: snap.time,
          proxy: snap.proxy,
          buy: snap.bar.buy,
          sell: snap.bar.sell,
          imbalance: snap.bar.imbalance,
        });
        if (snap.eligible) snapshots.set(row.id, snap);
      }
      if (row.table === "contract_outcomes") outcomes.set(row.id, row.payload);
      if (row.table === "contract_settlements")
        settlements.set(row.id, row.payload);
    } catch {
      /* A truncated final line after a crash is not a valid event. */
    }
  }
}
const ordered = [...snapshots.values()].sort((a, b) => a.time - b.time),
  bars = [...seconds.values()].sort((a, b) => a.time - b.time);
// Index of the first bar strictly later than `time` (bars are chronological).
const firstAfter = (time: number) => {
  let lo = 0,
    hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};
let recomputed = 0,
  kept = 0;
// Bars come only from logged seconds; fade is re-scored with no lookahead past each sample.
const samples = ordered.map((s) => {
  const upTo = bars.slice(
    firstAfter(s.time - (config.fade.lookbackMin + 1) * 60000),
    firstAfter(s.time),
  );
  if (upTo.length < config.fade.lookbackMin * 60 * 0.8) {
    kept++;
    return s;
  }
  recomputed++;
  return {
    ...s,
    engines: { ...s.engines, fade: fade(upTo, s.time, s.ttc, config.fade) },
  };
});
const rows = dataset(
    samples,
    [...outcomes.values()],
    [...settlements.values()],
  ),
  table = calibrationTable(
    rows,
    ENGINES,
    bucketLabels(config.buckets),
    config.calibration,
  );
const report = {
  created: Date.now(),
  version: CALIBRATION_VERSION,
  dir,
  mode,
  journals: files.length,
  seconds: seconds.size,
  samples: snapshots.size,
  windows: new Set(rows.map((r) => r.window)).size,
  fade: { config: config.fade, recomputed, keptFromJournal: kept },
  official: rows.filter((r) => r.official).length,
  calibration: table.map(({ model: _, ...c }) => c),
};
await mkdir("data", { recursive: true });
await writeFile("data/contract-rebuild.json", JSON.stringify(report, null, 2));
console.log(
  `${report.windows} windows, ${report.seconds} logged seconds, fade re-scored on ${recomputed} samples (${kept} kept from journal; tick files expire after ${config.tickRetentionDays} days).`,
);
console.table(
  report.calibration.map((c) => ({
    engine: c.engine,
    bucket: c.bucket,
    status: c.status,
    n: c.n,
    brier: c.brier?.toFixed(4) ?? "—",
    baseline: c.baselineBrier?.toFixed(4) ?? "—",
    hit: c.hitRate === null ? "—" : `${(c.hitRate * 100).toFixed(1)}%`,
  })),
);
console.log("Full report: data/contract-rebuild.json");
