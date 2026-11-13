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
import { KalshiFeed } from "./kalshi";
import type { ContractCheckpoint } from "./contracts";
import type { Forecast, Outcome, Signal, PaperState } from "../lib/types";
import { fresh } from "../lib/math";
import { etIso } from "../lib/time";
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
  engine.contracts.restore(
    await store.load<ContractCheckpoint>(`contracts-${mode}`),
  );
  const saveContracts = () =>
    store.checkpoint(`contracts-${mode}`, engine.contracts.checkpoint());
  engine.contracts.onOutcome = () => void saveContracts();
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
    kalshi: {
      status: engine.healthFor("kalshi").status,
      ticker: snapshot.contract.quote?.ticker ?? null,
      quoteAgeMs: snapshot.contract.quoteAge,
      fresh: snapshot.contract.quoteFresh,
    },
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
  // Simulated Kalshi contract paper trading. There is no real order endpoint in this application.
  app.post("/api/contracts/open", async (req, reply) => {
    const input = z
      .object({ side: z.enum(["UP", "DOWN"]) })
      .safeParse(req.body);
    if (!input.success)
      return reply.code(400).send({ error: input.error.message });
    const v = snapshot.contract.verdict,
      e = snapshot.contract.engineViews,
      best = e.find((x) => x.name === v?.engine),
      side = input.data.side === "UP" ? best?.up : best?.down;
    try {
      engine.contracts.openPosition(input.data.side, Date.now(), {
        engine: "manual",
        bucket: snapshot.contract.bucket,
        edge: side?.edge ?? null,
        modelP: side?.modelP ?? null,
        marketP: side?.marketP ?? null,
        auto: false,
      });
      await saveAll();
      return engine.contracts.paper.state;
    } catch (err) {
      return reply.code(400).send({ error: String(err) });
    }
  });
  app.post("/api/contracts/close", async (_req, reply) => {
    try {
      engine.contracts.closePosition(Date.now());
      await saveAll();
      return engine.contracts.paper.state;
    } catch (err) {
      return reply.code(400).send({ error: String(err) });
    }
  });
  app.post("/api/contracts/settings", async (req, reply) => {
    const r = z
      .object({
        contracts: z.number().int().min(1).max(10000),
        maxStake: z.number().min(1).max(1e6),
        maxDailyLoss: z.number().min(1).max(1e6),
        auto: z.boolean(),
      })
      .safeParse(req.body);
    if (!r.success) return reply.code(400).send({ error: r.error.message });
    try {
      engine.contracts.paper.configure(r.data);
      await saveAll();
      return engine.contracts.paper.state;
    } catch (err) {
      return reply.code(400).send({ error: String(err) });
    }
  });
  const csv = (
    reply: {
      header: (k: string, v: string) => typeof reply;
      send: (b: string) => unknown;
    },
    name: string,
    rows: (string | number | boolean | null | undefined)[][],
  ) =>
    reply
      .header("Content-Type", "text/csv")
      .header("Content-Disposition", `attachment; filename="${name}"`)
      .send(
        rows
          .map((r) =>
            r
              .map((v) => (v === null || v === undefined ? "" : String(v)))
              .join(","),
          )
          .join("\n"),
      );
  app.get("/api/contracts/samples.csv", (_req, reply) => {
    const c = engine.contracts,
      outcome = new Map(c.outcomes.map((o) => [o.window, o])),
      official = new Map(c.settlements.map((s) => [s.window, s]));
    return csv(reply, "pulseterminal-contract-samples.csv", [
      [
        "window_et",
        "bucket",
        "seconds_to_close",
        "ticker",
        "strike",
        "strike_source",
        "proxy",
        "distance_usd",
        "distance_atr",
        "yes_ask",
        "no_ask",
        "momentum_raw_score",
        "fade_raw_score",
        "proxy_result",
        "official_result",
      ],
      ...c.samples.map((s) => [
        etIso(s.window),
        s.bucket,
        s.ttc,
        s.ticker,
        s.strike,
        s.strikeSource,
        s.proxy,
        s.distance,
        s.distanceAtr,
        s.quote?.yesAsk,
        s.quote?.noAsk,
        s.engines.momentum?.score,
        s.engines.fade?.score,
        outcome.get(s.window)?.result,
        official.get(s.window)?.result,
      ]),
    ]);
  });
  // Newest first, 10 per page by default, each row joined with its window's result once known.
  app.get("/api/contracts/signals", (req, reply) => {
    const q = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        size: z.coerce.number().int().min(1).max(50).default(10),
      })
      .safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.message });
    const c = engine.contracts,
      total = c.signals.length,
      pages = Math.max(1, Math.ceil(total / q.data.size)),
      page = Math.min(q.data.page, pages),
      official = new Map(c.settlements.map((s) => [s.window, s.result])),
      proxy = new Map(c.outcomes.map((o) => [o.window, o])),
      rows = c.signals
        .slice()
        .reverse()
        .slice((page - 1) * q.data.size, page * q.data.size)
        .map((s) => {
          const o = proxy.get(s.window),
            result = official.get(s.window) ?? o?.result ?? null;
          return {
            ...s,
            result,
            resultSource: official.has(s.window)
              ? "official"
              : o?.result
                ? "proxy"
                : o?.status === "MISSED"
                  ? "missed"
                  : "pending",
            correct: result ? result === s.direction : null,
          };
        });
    return { page, pages, total, size: q.data.size, rows };
  });
  app.get("/api/contracts/trades.csv", (_req, reply) =>
    csv(reply, "pulseterminal-contract-trades.csv", [
      [
        "opened_et",
        "closed_et",
        "ticker",
        "side",
        "contracts",
        "entry",
        "entry_fee",
        "exit",
        "exit_fee",
        "pnl",
        "reason",
        "engine",
        "bucket",
        "edge_at_entry",
        "model_p",
        "market_p",
        "auto",
      ],
      ...engine.contracts.paper.state.trades.map((t) => [
        etIso(t.opened),
        etIso(t.closed),
        t.ticker,
        t.side,
        t.contracts,
        t.entry,
        t.entryFee,
        t.exit,
        t.exitFee,
        t.pnl,
        t.reason,
        t.engine,
        t.bucket,
        t.edge,
        t.modelP,
        t.marketP,
        t.auto,
      ]),
    ]),
  );
  async function saveAll() {
    await engine.drain();
    await saveContracts();
  }
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
      "id,created_et,mode,model,starting,projected,horizon_seconds,freshness_ms,status,actual,correct,absolute_error",
    ];
    for (const f of engine.forecasts) {
      const o = engine.outcomes.find((x) => x.id === f.id);
      rows.push(
        [
          f.id,
          etIso(f.created),
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
  const kalshi = new KalshiFeed(engine, engine.contracts.config.kalshi);
  if (mode === "replay" || options.startFeeds === false)
    engine.healthFor("kalshi").status =
      mode === "replay" ? "SYNTHETIC CONTRACT (not Kalshi)" : "NOT STARTED";
  const feeds =
    mode === "live"
      ? [coinbaseAdapter(engine), krakenAdapter(engine), kalshi]
      : [];
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
    await saveContracts();
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
