import { afterEach, describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { Store } from "../worker/store";
import { Engine } from "../worker/engine";
import { createServer } from "../worker/index";
import { replayStep, seedReplay } from "../worker/replay";
const dirs: string[] = [];
async function store() {
  const s = new Store();
  s.dir = await mkdtemp(path.join(tmpdir(), "pulse-test-"));
  dirs.push(s.dir);
  await s.init();
  return s;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
  delete process.env.WORKER_API_TOKEN;
});
describe("chronological engine integration", () => {
  it("creates forecasts before outcomes, resolves 20s later, deduplicates trades and never fabricates Kraken", async () => {
    const s = await store(),
      e = new Engine("replay", s),
      start = 1800000000000;
    seedReplay(e, start);
    let snap;
    for (let i = 0; i < 95; i++) {
      const now = start + i * 1000;
      replayStep(e, now, i);
      snap = e.tick(now);
      if (i === 40) {
        expect(e.forecasts.length).toBeGreaterThan(0);
        expect(e.outcomes).toHaveLength(0);
      }
    }
    expect(
      snap!.outcomes.filter((o) => o.status === "COMPLETE").length,
    ).toBeGreaterThan(3);
    expect(snap!.confirmation.state).toBe("STALE");
    expect(snap!.confirmation.kraken).toBeNull();
    const count = e.trades.length;
    replayStep(e, start + 94000, 94);
    expect(e.trades.length).toBe(count);
    expect(e.forecasts[0].created).toBeLessThan(e.outcomes[0].evaluated);
    expect(e.tick(start + 120000).projection).toBeNull();
    await e.drain();
  });
  it("serves WebSocket snapshots, validates orders, authenticates changes and exports actual CSV", async () => {
    const s = await store(),
      { app, engine } = await createServer({
        mode: "replay",
        startFeeds: false,
        store: s,
      });
    try {
      const url = await app.listen({ port: 0, host: "127.0.0.1" });
      const ws = new WebSocket(url.replace("http", "ws") + "/ws", {
        origin: "http://localhost:3100",
      });
      const message = await new Promise<string>((resolve, reject) => {
        ws.once("message", (x) => resolve(x.toString()));
        ws.once("error", reject);
      });
      expect(JSON.parse(message).mode).toBe("replay");
      ws.close();
      expect((await app.inject("/health")).statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/paper/open",
            payload: { direction: "BUY" },
          })
        ).statusCode,
      ).toBe(400);
      const now = Date.now();
      engine.price("BTC-USD", 100, now);
      process.env.WORKER_API_TOKEN = "test-token";
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/paper/open",
            payload: { direction: "LONG", size: 1, stop: 90, target: 120 },
          })
        ).statusCode,
      ).toBe(401);
      const opened = await app.inject({
        method: "POST",
        url: "/api/paper/open",
        headers: { authorization: "Bearer test-token" },
        payload: { direction: "LONG", size: 1, stop: 90, target: 120 },
      });
      expect(opened.statusCode).toBe(200);
      expect(engine.paper.state.position?.direction).toBe("LONG");
      engine.price("BTC-USD", 110, Date.now());
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/paper/close",
            headers: { authorization: "Bearer test-token" },
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
      expect(engine.paper.state.trades[0].pnl).toBeGreaterThan(0);
      expect((await app.inject("/api/history.csv")).body).toContain(
        "created_et",
      );
    } finally {
      await app.close();
    }
  });
  it("recovers its mode-specific paper checkpoint", async () => {
    const s = await store(),
      { app, engine } = await createServer({
        mode: "replay",
        startFeeds: false,
        store: s,
      });
    engine.paper.state.balance = 10200;
    await app.close();
    const second = await createServer({
      mode: "replay",
      startFeeds: false,
      store: s,
    });
    expect(second.engine.paper.state.balance).toBe(10200);
    expect(second.engine.paper.state.auto).toBe(false);
    await second.app.close();
  });
});
