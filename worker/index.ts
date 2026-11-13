import "dotenv/config";
import { validateConfiguration } from "./config";
import { runFixtureBacktest } from "../lib/backtest";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type WebSocket from "ws";
import { Engine } from "./engine";
import { Store } from "./store";
import { coinbaseAdapter, krakenAdapter, seedHistory } from "./feeds";
import { replayStep, seedReplay } from "./replay";
import type { Forecast, Outcome, Signal, PaperState } from "../lib/types";
import { fresh } from "../lib/math";
export async function createServer(
  options: {
    mode?: "live" | "replay";
    startFeeds?: boolean;
    store?: Store;
  } = {},
) {
  validateConfiguration();
  const store = options.store ?? new Store();
  await store.init();
  const mode =
      options.mode ?? (process.env.DATA_MODE === "replay" ? "replay" : "live"),
    engine = new Engine(mode, store);
  const restored = await store.load<{
    forecasts: Forecast[];
    outcomes: Outcome[];
    signals: Signal[];
    paper: PaperState;
  }>(`state-${mode}`);
  if (restored) {
    engine.forecasts = restored.forecasts;
    engine.outcomes = restored.outcomes;
    engine.signals = restored.signals;
    engine.paper.state = restored.paper;
    engine.paper.state.auto = false;
  }
  const recovered = await store.recover(
    mode,
    engine.forecasts.at(-1)?.created ?? 0,
  );
  for (const row of recovered) {
    if (
      row.table === "forecast_events" &&
      !engine.forecasts.some((f) => f.id === row.id)
    )
      engine.forecasts.push(row.payload as Forecast);
    if (
      row.table === "forecast_outcomes" &&
      !engine.outcomes.some((f) => f.id === row.id)
    )
      engine.outcomes.push(row.payload as Outcome);
    if (
      row.table === "trading_signals" &&
      !engine.signals.some((f) => f.id === row.id)
    )
      engine.signals.push(row.payload as Signal);
  }
  engine.forecasts = engine.forecasts
    .sort((a, b) => a.created - b.created)
    .slice(-8640);
  engine.outcomes = engine.outcomes
    .sort((a, b) => a.evaluated - b.evaluated)
    .slice(-8640);
  engine.signals = engine.signals.sort((a, b) => a.time - b.time).slice(-5000);
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    bodyLimit: 8192,
  });
  const origins = (
    process.env.FRONTEND_ORIGINS || "http://localhost:3100"
  ).split(",");
  await app.register(cors, { origin: origins });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await app.register(websocket, { options: { maxPayload: 1024 } });
  const clients = new Set<WebSocket>();
  let snapshot = engine.tick(Date.now()),
    second = 0;
  app.get("/health", () => ({
    ok: true,
    mode,
    market: snapshot.connection,
    persistence: store.label,
    clients: clients.size,
  }));
  app.get("/api/snapshot", () => snapshot);
  app.get("/ws", { websocket: true }, (socket, request) => {
    if (
      (request.headers.origin && !origins.includes(request.headers.origin)) ||
      clients.size >= 100
    ) {
      socket.close(1008, "Origin or connection limit");
      return;
    }
    clients.add(socket);
    socket.send(JSON.stringify(snapshot));
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });
  app.addHook("preHandler", async (req, reply) => {
    if (req.method !== "POST") return;
    const token = process.env.WORKER_API_TOKEN;
    const origin = req.headers.origin;
    if (origin && !origins.includes(origin))
      return reply.code(403).send({ error: "Origin denied" });
    if (token) {
      const actual = Buffer.from(
          (req.headers.authorization || "").replace(/^Bearer /, ""),
        ),
        expected = Buffer.from(token);
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        return reply.code(401).send({ error: "Worker token required" });
    } else if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip))
      return reply
        .code(403)
        .send({ error: "Configure WORKER_API_TOKEN for remote mutations" });
  });
  app.post("/api/paper/open", async (req, reply) => {
    const input = z
      .object({
        direction: z.enum(["LONG", "SHORT"]),
        size: z.number().positive().max(100),
        stop: z.number().positive(),
        target: z.number().positive(),
      })
      .safeParse(req.body);
    if (!input.success)
      return reply.code(400).send({ error: input.error.message });
    const last = engine.prices.get("BTC-USD")?.at(-1);
    if (!last || !fresh(last.time, Date.now(), engine.freshness))
      return reply.code(409).send({ error: "Fresh market price required" });
    try {
      engine.paper.open(
        input.data.direction,
        input.data.size,
        last.price,
        input.data.stop,
        input.data.target,
        Date.now(),
        mode,
      );
      const p = engine.paper.state.position!;
      engine.persist("paper_positions", p.id, p.opened, p);
      await checkpoint();
      return engine.paper.state;
    } catch (e) {
      return reply.code(400).send({ error: String(e) });
    }
  });
  app.post("/api/paper/close", async (_req, reply) => {
    const last = engine.prices.get("BTC-USD")?.at(-1);
    if (!last || !fresh(last.time, Date.now(), engine.freshness))
      return reply.code(409).send({ error: "Fresh market price required" });
    try {
      engine.paper.close(last.price, Date.now());
      const t = engine.paper.state.trades.at(-1)!;
      engine.persist("paper_trades", t.id, t.closed, t);
      engine.persist("paper_positions", t.id, t.closed, {
        ...t,
        closed: t.closed,
      });
      await checkpoint();
      return engine.paper.state;
    } catch (e) {
      return reply.code(400).send({ error: String(e) });
    }
  });
  app.post("/api/paper/settings", async (req, reply) => {
    const r = z
      .object({
        feeBps: z.number().min(0).max(100),
        slippageBps: z.number().min(0).max(100),
        auto: z.boolean(),
      })
      .safeParse(req.body);
    if (!r.success) return reply.code(400).send({ error: r.error.message });
    try {
      engine.paper.configure(r.data.feeBps, r.data.slippageBps, r.data.auto);
      await checkpoint();
      return engine.paper.state;
    } catch (e) {
      return reply.code(400).send({ error: String(e) });
    }
  });
  let backtestBusy = false;
  app.post(
    "/api/backtest",
    { config: { rateLimit: { max: 2, timeWindow: "1 minute" } } },
    async (_req, reply) => {
      if (backtestBusy)
        return reply.code(409).send({ error: "A backtest is already running" });
      backtestBusy = true;
      try {
        const report = await runFixtureBacktest();
        engine.persist(
          "system_health",
          `backtest-${report.created}`,
          report.created,
          report,
        );
        await engine.drain();
        await store.checkpoint("last-backtest", report);
        return report;
      } finally {
        backtestBusy = false;
      }
    },
  );
  app.get("/api/history.csv", (_req, reply) => {
    const rows = [
      "id,created_utc,mode,model,starting,projected,horizon_seconds,freshness_ms,status,actual,correct,absolute_error",
    ];
    for (const f of engine.forecasts) {
      const o = engine.outcomes.find((x) => x.id === f.id);
      rows.push(
        [
          f.id,
          new Date(f.created).toISOString(),
          f.mode,
          f.model,
          f.starting,
          f.projected,
          f.horizon,
          f.freshness,
          o?.status ?? "PENDING",
          o?.actual ?? "",
          o?.correct ?? "",
          o?.absoluteError ?? "",
        ].join(","),
      );
    }
    return reply
      .header("Content-Type", "text/csv")
      .header(
        "Content-Disposition",
        'attachment; filename="pulseterminal-forecasts.csv"',
      )
      .send(rows.join("\n"));
  });
  async function checkpoint() {
    await engine.drain();
    await store.checkpoint(`state-${mode}`, {
      forecasts: engine.forecasts,
      outcomes: engine.outcomes,
      signals: engine.signals,
      paper: engine.paper.state,
    });
  }
  const feeds =
    mode === "live" ? [coinbaseAdapter(engine), krakenAdapter(engine)] : [];
  if (options.startFeeds !== false) {
    if (mode === "live") {
      feeds.forEach((f) => f.start());
      void seedHistory(engine);
    } else seedReplay(engine, Date.now());
  }
  const timer = setInterval(() => {
    const now = Date.now();
    if (mode === "replay" && options.startFeeds !== false)
      replayStep(engine, now, second++);
    snapshot = engine.tick(now);
    const data = JSON.stringify({
      ...snapshot,
      forecasts: snapshot.forecasts.slice(-4),
      outcomes: snapshot.outcomes.slice(-4),
      signals: snapshot.signals.slice(-4),
      minutes: snapshot.minutes.slice(-2),
    });
    for (const c of clients)
      if (c.readyState === 1) {
        if (c.bufferedAmount > 2e6) c.terminate();
        else c.send(data);
      }
    void engine.drain();
    void store.flush();
  }, 1000);
  const historyRefresh = setInterval(() => {
    if (mode === "live" && options.startFeeds !== false)
      void seedHistory(engine);
  }, 60000);
  const saving = setInterval(() => {
    void checkpoint();
  }, 10000);
  app.addHook("onClose", async () => {
    clearInterval(timer);
    clearInterval(historyRefresh);
    clearInterval(saving);
    feeds.forEach((f) => f.stop());
    clients.forEach((c) => c.close());
    await checkpoint();
    await store.flush();
  });
  return { app, engine };
}
if (process.env.NODE_ENV !== "test") {
  const { app } = await createServer();
  await app.listen({
    port: Number(process.env.WORKER_PORT) || 4100,
    host: process.env.WORKER_HOST || "127.0.0.1",
  });
  for (const name of ["SIGINT", "SIGTERM"])
    process.on(name, () => void app.close().then(() => process.exit(0)));
}
