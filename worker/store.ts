import {
  mkdir,
  readFile,
  appendFile,
  writeFile,
  rename,
  readdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createClient } from "@supabase/supabase-js";
export type Stored = {
  table: string;
  id: string;
  time: number;
  mode: string;
  payload: unknown;
  localOnly?: boolean;
};
// High-rate per-second contract records use separate, shorter-retention journal files.
export const TICK_TABLES = new Set(["kalshi_quotes", "contract_snapshots"]);
const journal = /^(events|ticks)-\d{4}-\d{2}-\d{2}\.jsonl$/;
export class Store {
  dir = process.env.LOCAL_DATA_DIR || "./data";
  error: string | null = null;
  label = "LOCAL JOURNAL";
  queue: Stored[] = [];
  busy = false;
  checkpointTask: Promise<void> = Promise.resolve();
  client =
    process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
      ? createClient(
          process.env.SUPABASE_URL,
          process.env.SUPABASE_SERVICE_ROLE_KEY,
          { auth: { persistSession: false, autoRefreshToken: false } },
        )
      : null;
  async init() {
    try {
      await mkdir(this.dir, { recursive: true });
      if (this.client) this.label = "LOCAL + SUPABASE";
      const tickDays = Number(process.env.CONTRACT_TICK_RETENTION_DAYS) || 30;
      for (const name of await readdir(this.dir)) {
        const days = name.startsWith("ticks-") ? tickDays : 180;
        if (
          journal.test(name) &&
          Date.parse(name.slice(-16, -6)) < Date.now() - days * 86400000
        )
          await unlink(path.join(this.dir, name));
      }
    } catch (e) {
      this.label = "MEMORY ONLY";
      this.error = String(e);
    }
  }
  async load<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse(
        await readFile(path.join(this.dir, `${key}.json`), "utf8"),
      );
    } catch {
      return null;
    }
  }
  async recover(mode: string, after = 0) {
    const recovered: Stored[] = [];
    try {
      const names = (await readdir(this.dir))
        .filter(
          (name) =>
            /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) &&
            Date.parse(name.slice(7, 17)) >= Date.now() - 2 * 86400000,
        )
        .sort();
      for (const name of names) {
        const lines = createInterface({
          input: createReadStream(path.join(this.dir, name)),
          crlfDelay: Infinity,
        });
        for await (const line of lines) {
          try {
            const row = JSON.parse(line) as Stored;
            if (
              row.mode === mode &&
              row.time >= after &&
              [
                "forecast_events",
                "forecast_outcomes",
                "trading_signals",
              ].includes(row.table)
            )
              recovered.push(row);
          } catch {
            /* A truncated final line after a crash is not a valid event. */
          }
        }
      }
      return recovered.slice(-30000);
    } catch {
      return [];
    }
  }
  async checkpoint(key: string, payload: unknown) {
    if (this.label === "MEMORY ONLY") return;
    const encoded = JSON.stringify(payload);
    this.checkpointTask = this.checkpointTask.then(async () => {
      try {
        const p = path.join(this.dir, `${key}.json`);
        await writeFile(`${p}.tmp`, encoded);
        await rename(`${p}.tmp`, p);
      } catch (e) {
        this.error = String(e);
      }
    });
    return this.checkpointTask;
  }
  async put(row: Stored) {
    if (this.label !== "MEMORY ONLY") {
      try {
        await appendFile(
          path.join(
            this.dir,
            `${TICK_TABLES.has(row.table) ? "ticks" : "events"}-${new Date(row.time).toISOString().slice(0, 10)}.jsonl`,
          ),
          JSON.stringify({ ...row, localOnly: undefined }) + "\n",
        );
      } catch (e) {
        this.error = String(e);
      }
    }
    if (this.client && !row.localOnly) {
      if (this.queue.length >= 10000) {
        this.error =
          "Supabase queue full; durable local journal remains authoritative";
        return;
      }
      this.queue.push(row);
    }
  }
  async flush() {
    if (this.busy || !this.client || !this.queue.length) return;
    this.busy = true;
    try {
      const batch = this.queue.slice(0, 100);
      for (const table of new Set(batch.map((x) => x.table))) {
        const rows = batch
          .filter((x) => x.table === table)
          .map(({ id, time, mode, payload }) => ({
            id,
            event_time: new Date(time).toISOString(),
            mode,
            payload,
          }));
        const { error } = await this.client
          .from(table)
          .upsert(rows, { onConflict: "id" });
        if (error) throw Error(error.message);
      }
      this.queue.splice(0, batch.length);
      this.error = null;
    } catch (e) {
      this.error = `Supabase sync: ${String(e)}`;
    } finally {
      this.busy = false;
    }
  }
}
