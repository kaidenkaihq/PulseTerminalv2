"use client";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  ChevronDown,
  Clock3,
  Download,
  FlaskConical,
  Globe2,
  Layers3,
  Radio,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Target,
  Wallet,
  Wifi,
  Zap,
} from "lucide-react";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { KalshiStrip } from "./kalshi-strip";
import { KalshiTab } from "./kalshi-tab";
import { SignalHistory } from "./kalshi-signals";
import { analytics } from "@/lib/analytics";
import { etDateTime, etTime } from "@/lib/time";
import type { Snapshot } from "@/lib/types";
const MarketChart = dynamic(
  () => import("./chart").then((m) => m.MarketChart),
  {
    ssr: false,
    loading: () => (
      <div className="h-[360px] flex items-center justify-center muted">
        Loading chart…
      </div>
    ),
  },
);
const worker = process.env.NEXT_PUBLIC_WORKER_URL || "http://localhost:4100";
const money = (v: number | null | undefined, dec = 2) =>
  v == null
    ? "—"
    : v.toLocaleString("en-US", {
        minimumFractionDigits: dec,
        maximumFractionDigits: dec,
      });
const signed = (v: number | null | undefined, dec = 2) =>
  v == null ? "—" : `${v >= 0 ? "+" : ""}${money(v, dec)}`;
const age = (v: number | null | undefined) =>
  v == null ? "Unavailable" : `${(Math.max(0, v) / 1000).toFixed(1)}s`;
const et = (v: number) => etTime(v);
const tabs = [
  { name: "Dashboard", icon: Layers3 },
  { name: "Kalshi 15m", icon: Target },
  { name: "Signal History", icon: BookOpen },
  { name: "Backtesting & Analytics", icon: FlaskConical },
  { name: "Paper Trading", icon: Wallet },
  { name: "Settings", icon: Settings2 },
];
function Spark({
  points,
  color = "#34e0a3",
  height = 120,
}: {
  points: number[];
  color?: string;
  height?: number;
}) {
  const min = Math.min(...points, 0),
    max = Math.max(...points, 1),
    d = points
      .map(
        (p, i) =>
          `${i ? "L" : "M"} ${(i / Math.max(1, points.length - 1)) * 1000} ${height - 8 - ((p - min) / (max - min)) * (height - 16)}`,
      )
      .join(" ");
  return (
    <svg
      viewBox={`0 0 1000 ${height}`}
      preserveAspectRatio="none"
      className="w-full"
      style={{ height }}
      role="img"
      aria-label="Rolling market breadth chart"
    >
      <defs>
        <linearGradient id="pulse-fill" x1="0" x2="0" y1="0" y2="1">
          <stop stopColor={color} stopOpacity=".2" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {points.length > 1 && (
        <>
          <path
            d={`${d} L 1000 ${height} L 0 ${height} Z`}
            fill="url(#pulse-fill)"
          />
          <path
            d={d}
            fill="none"
            stroke={color}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        </>
      )}
    </svg>
  );
}
function PressureBar({ value }: { value: number | null | undefined }) {
  return (
    <div
      className="bar"
      style={value == null ? { background: "#ffffff0b" } : {}}
    >
      <div style={{ width: `${value ?? 0}%` }} />
    </div>
  );
}
export function Terminal() {
  const [data, setData] = useState<Snapshot | null>(null),
    [tab, setTab] = useState("Dashboard"),
    [transport, setTransport] = useState("CONNECTING"),
    [ha, setHa] = useState(false),
    [overlay, setOverlay] = useState(true),
    [now, setNow] = useState(0),
    [token, setToken] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [latest, setLatest] = useState(0);
  const [backtest, setBacktest] = useState<{
    n: number;
    accuracy: number | null;
    mae: number | null;
    seconds: number;
  } | null>(null);
  async function runBacktest() {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch(`${worker}/api/backtest`, {
        method: "POST",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error);
      setBacktest(result);
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let ws: WebSocket | undefined,
      retry: ReturnType<typeof setTimeout>,
      stopped = false;
    function connect() {
      if (stopped) return;
      ws = new WebSocket(`${worker.replace(/^http/, "ws")}/ws`);
      ws.onopen = () => setTransport("CONNECTED");
      ws.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data) as Snapshot;
          setLatest(Date.now());
          setData((previous) => {
            if (!previous || previous.mode !== d.mode) return d;
            const merge = <T extends { id: string }>(
              a: T[],
              b: T[],
              limit: number,
            ) =>
              [...new Map([...a, ...b].map((x) => [x.id, x])).values()].slice(
                -limit,
              );
            return {
              ...d,
              forecasts: merge(previous.forecasts, d.forecasts, 1000),
              outcomes: merge(previous.outcomes, d.outcomes, 1000),
              signals: merge(previous.signals, d.signals, 500),
            };
          });
        } catch {
          setTransport("INVALID MESSAGE");
        }
      };
      ws.onerror = () => setTransport("DISCONNECTED");
      ws.onclose = () => {
        setTransport("DISCONNECTED");
        if (!stopped) retry = setTimeout(connect, 2000);
      };
    }
    connect();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(clock);
      ws?.close();
    };
  }, []);
  const stale = transport !== "CONNECTED" || now - latest > 5000,
    d = data,
    p = stale ? null : d?.projection,
    signal = d?.signal,
    positive = p?.direction !== "DOWN",
    tone = positive ? "green" : "pink",
    price = d?.price,
    seconds = d
      ? Math.max(0, Math.floor((d.nextClose - (now || d.time)) / 1000))
      : 0,
    timer = `${Math.floor(seconds / 60)
      .toString()
      .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`,
    stats = d ? analytics(d.forecasts, d.outcomes, d.paper) : null;
  async function mutate(endpoint: string, body: unknown, base = "paper") {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch(`${worker}/api/${base}/${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      const r = await response.json();
      if (!response.ok) throw Error(r.error || "Request failed");
      setNotice(
        base === "contracts"
          ? "Contract paper account updated."
          : "Paper account updated.",
      );
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(false);
    }
  }
  const activeSignal =
    !stale && d?.connection === "STREAMING"
      ? signal?.state
      : "INSUFFICIENT DATA";
  return (
    <div className="min-h-screen">
      <header className="border-b border-white/[.06] h-[70px] px-5 lg:px-10 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-3 text-white">
          <div className="size-8 bg-emerald-400/10 border border-emerald-400/20 rounded-lg flex items-center justify-center green">
            <Activity size={21} />
          </div>
          <span className="font-semibold text-[19px] tracking-[-.7px]">
            Pulse<span className="text-slate-400 font-normal">Terminal</span>
          </span>
          <span className="hidden sm:block text-[8px] tracking-widest text-slate-600 border-l border-white/10 pl-3 ml-2">
            MARKET INTELLIGENCE
          </span>
        </Link>
        <div className="flex items-center gap-4">
          <span
            className={`badge ${stale || d?.mode === "replay" ? "dim" : ""}`}
          >
            <span className="dot" />
            {d?.mode === "replay"
              ? "SYNTHETIC REPLAY"
              : stale
                ? "CONNECTING"
                : "LIVE MARKET DATA"}
          </span>
          <span className="mono text-[11px] muted hidden md:block">
            {et(now)} <span className="text-slate-600">ET</span>
          </span>
          <div className="size-7 rounded-full border border-white/10 flex items-center justify-center text-[9px] text-slate-400">
            PT
          </div>
        </div>
      </header>
      <div className="px-4 md:px-7 lg:px-10 max-w-[1600px] mx-auto">
        <nav
          className="flex gap-6 md:gap-8 border-b border-white/[.06] overflow-x-auto"
          aria-label="Main navigation"
        >
          {tabs.map((t) => (
            <button
              key={t.name}
              onClick={() => setTab(t.name)}
              className={`flex items-center gap-2 py-5 whitespace-nowrap text-[11px] border-b-2 transition-colors ${tab === t.name ? "border-emerald-400 text-emerald-300" : "border-transparent text-slate-500 hover:text-slate-200"}`}
            >
              <t.icon size={14} />
              {t.name}
            </button>
          ))}
        </nav>
        <main className="py-7 md:py-9">
          <div className="flex items-center justify-between mb-7">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[17px] font-medium tracking-tight">
                  {tab === "Dashboard" ? "Market overview" : tab}
                </span>
                <span className="badge dim">BTC / USD</span>
              </div>
              <p className="text-[11px] muted mt-2">
                {d?.mode === "replay"
                  ? "Deterministic synthetic fixture · simulation only"
                  : "Real-time market structure. Transparent signals. Measurable outcomes."}
              </p>
            </div>
            <div className="hidden sm:flex items-center gap-3">
              <span className="text-[10px] muted">
                {d?.mode === "replay" ? "Replay engine" : "Coinbase Exchange"}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTab("Settings")}
              >
                <SlidersHorizontal size={12} /> Configure
              </Button>
            </div>
          </div>
          {(!d || stale || d.connection !== "STREAMING") && (
            <div
              role="status"
              className="border border-amber-400/20 bg-amber-400/5 text-amber-200 text-xs p-4 rounded-lg mb-5"
            >
              {!d
                ? "Connecting to the market worker on " +
                  worker +
                  ". Start with npm run dev."
                : stale
                  ? "Worker connection is stale. Projections and active signals are paused."
                  : "Waiting for fresh exchange data. Live mode does not substitute generated prices. For an offline demonstration, start the worker with DATA_MODE=replay."}
            </div>
          )}
          {notice && (
            <div
              role="status"
              className="border border-cyan-400/20 bg-cyan-400/5 text-cyan-100 text-xs p-4 rounded-lg mb-5"
            >
              {notice}
            </div>
          )}
          {tab === "Dashboard" && (
            <>
              {d?.contract && (
                <KalshiStrip
                  c={d.contract}
                  now={now}
                  stale={stale}
                  onOpen={() => setTab("Kalshi 15m")}
                />
              )}
              {d?.contract && (
                <div className="mb-4">
                  <SignalHistory
                    worker={worker}
                    count={d.contract.signalCount}
                  />
                </div>
              )}
              <Card className="mb-4 !p-0">
                <div
                  className={`absolute top-0 left-0 w-[60%] h-full pointer-events-none ${positive ? "bg-[radial-gradient(ellipse_at_top_left,#1be39e0b,transparent_65%)]" : "bg-[radial-gradient(ellipse_at_top_left,#f2638d0b,transparent_65%)]"}`}
                />
                <div className="relative grid lg:grid-cols-[1.4fr_1fr]">
                  <div className="p-6 md:p-8 lg:border-r border-white/[.06]">
                    <div className="flex items-center gap-2 eyebrow">
                      <span className={`dot ${tone}`} /> 20-second market
                      projection{" "}
                      <span className="badge dim !text-[8px] ml-2">
                        OLS · V1
                      </span>
                    </div>
                    <div className="flex items-center gap-4 mt-6">
                      <span
                        className={`${tone} text-[43px] md:text-[57px] leading-none font-medium tracking-[-2.5px]`}
                      >
                        {p
                          ? `${p.direction === "UP" ? "Bullish" : p.direction === "DOWN" ? "Bearish" : "Flat"} momentum`
                          : "Reading the market"}
                      </span>
                      {p &&
                        (positive ? (
                          <ArrowUpRight className="green" size={43} />
                        ) : (
                          <ArrowDownRight className="pink" size={43} />
                        ))}
                    </div>
                    <p className="muted text-[11px] mt-4">
                      {p
                        ? `BTC is extrapolating ${p.direction.toLowerCase()} over the next 20 seconds.`
                        : "Collecting sufficient fresh samples for a rolling regression."}{" "}
                      <span className="text-slate-600">
                        An extrapolation, not a guarantee.
                      </span>
                    </p>
                    <div className="flex gap-5 mt-6 items-center">
                      <span
                        className={`badge ${!p ? "dim" : positive ? "" : "red"}`}
                      >
                        <Zap size={10} />
                        {p
                          ? p.direction === "FLAT"
                            ? "BALANCED PRESSURE"
                            : `${p.direction}WARD PRESSURE`
                          : "WARMING UP"}
                      </span>
                      <span className="text-[10px] muted">
                        10s regression{" "}
                        <span className="text-slate-500 mx-1">/</span> 20s
                        horizon
                      </span>
                    </div>
                  </div>
                  <div className="p-6 md:p-8">
                    <div className="flex justify-between">
                      <span className="eyebrow">
                        Bitcoin{" "}
                        <span className="text-slate-600">/ U.S. Dollar</span>
                      </span>
                      <span className="text-[10px] muted flex gap-1 items-center">
                        BTC-USD <ChevronDown size={11} />
                      </span>
                    </div>
                    <div className="flex items-baseline gap-3 mt-5">
                      <span className="mono text-[36px] md:text-[44px] tracking-[-2px]">
                        ${money(price)}
                      </span>
                      <span className={`mono text-[12px] ${tone}`}>
                        {signed(p?.percent, 4)}%
                      </span>
                    </div>
                    <div className="grid grid-cols-3 mt-6 gap-4">
                      <div>
                        <div className="eyebrow !text-[8px]">
                          Velocity · 10s
                        </div>
                        <div className={`mono mt-2 text-[13px] ${tone}`}>
                          {signed(p?.velocity10)}{" "}
                          <span className="text-[9px] muted">$/s</span>
                        </div>
                      </div>
                      <div>
                        <div className="eyebrow !text-[8px]">
                          Velocity · 30s
                        </div>
                        <div className="mono mt-2 text-[13px]">
                          {signed(p?.velocity30)}{" "}
                          <span className="text-[9px] muted">$/s</span>
                        </div>
                      </div>
                      <div>
                        <div className="eyebrow !text-[8px]">Acceleration</div>
                        <div className="mono mt-2 text-[13px]">
                          {signed(p?.acceleration, 3)}{" "}
                          <span className="text-[9px] muted">$/s²</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
              <div className="grid md:grid-cols-[1fr_1.45fr] gap-4 mb-4">
                <Card>
                  <div className="flex justify-between">
                    <span className="eyebrow">
                      Projected price{" "}
                      <span className="text-slate-600">/ T+20s</span>
                    </span>
                    <Clock3 size={14} className="muted" />
                  </div>
                  <div className="flex justify-between items-center mt-5">
                    <div
                      className={`mono text-[33px] tracking-[-1.6px] ${tone}`}
                    >
                      ${money(p?.projected)}
                    </div>
                    <div className={`text-right mono text-[12px] ${tone}`}>
                      {signed(p?.move)} USD
                      <br />
                      <span className="text-[10px] muted">
                        {signed(p?.percent, 4)}%
                      </span>
                    </div>
                  </div>
                  <div className="rule" />
                  <div className="flex justify-between fine">
                    <span>Current price + velocity × 20</span>
                    <span>Updated every second</span>
                  </div>
                </Card>
                <Card>
                  <div className="flex justify-between items-center">
                    <span className="eyebrow">
                      Executed buy / sell pressure
                    </span>
                    <span className="badge dim">20 SEC WINDOW</span>
                  </div>
                  <div className="flex justify-between mt-5 mb-3">
                    <div>
                      <span className="green text-[10px]">AGGRESSOR BUY</span>
                      <div className="mono green text-[25px] mt-1">
                        {money(d?.pressure20.buyPercent, 1)}
                        <span className="text-[15px]">%</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="pink text-[10px]">AGGRESSOR SELL</span>
                      <div className="mono pink text-[25px] mt-1">
                        {money(
                          d?.pressure20.buyPercent == null
                            ? null
                            : 100 - d.pressure20.buyPercent,
                          1,
                        )}
                        <span className="text-[15px]">%</span>
                      </div>
                    </div>
                  </div>
                  <PressureBar
                    value={stale ? null : d?.pressure20.buyPercent}
                  />
                  <div className="flex justify-between fine mt-4">
                    <span>
                      Notional delta{" "}
                      <span className="mono text-slate-300 ml-2">
                        ${signed(d?.pressure20.delta, 0)}
                      </span>
                    </span>
                    <span>
                      {d?.pressure20.count ?? 0} trades ·{" "}
                      {money((d?.pressure20.coverage ?? 0) * 100, 0)}% window
                    </span>
                  </div>
                </Card>
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
                {[
                  [
                    "60s executed buy",
                    d?.pressure60.buyPercent == null
                      ? "—"
                      : `${money(d.pressure60.buyPercent, 1)}%`,
                  ],
                  ["Cumulative delta", `$${signed(d?.pressure60.cvd, 0)}`],
                  [
                    "Resting book imbalance",
                    d?.book ? `${signed(d.book.imbalance * 100, 1)}%` : "—",
                  ],
                  [
                    "Bid / ask spread",
                    d?.book ? `$${money(d.book.spread)}` : "—",
                  ],
                  [
                    "Pressure trend",
                    d?.pressure20.trend == null
                      ? "Warming up"
                      : d.pressure20.trend > 0.05
                        ? "Strengthening buy"
                        : d.pressure20.trend < -0.05
                          ? "Strengthening sell"
                          : "Balanced",
                  ],
                ].map(([label, value]) => (
                  <div className="panel !p-3" key={label}>
                    <span className="eyebrow !text-[8px]">{label}</span>
                    <div className="mono text-xs mt-2">
                      {stale ? "STALE" : value}
                    </div>
                  </div>
                ))}
              </div>
              <div className="grid md:grid-cols-2 gap-4 mb-4">
                {(["LONG", "SHORT"] as const).map((side) => {
                  const long = side === "LONG",
                    active = activeSignal === side,
                    sign = long ? 1 : -1,
                    a = signal?.atr;
                  return (
                    <Card key={side}>
                      <div
                        className={`absolute left-0 top-0 h-full w-[2px] ${long ? "bg-emerald-400/60" : "bg-pink-400/50"}`}
                      />
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-3">
                          <div
                            className={`p-2 rounded-md ${long ? "bg-emerald-400/10 green" : "bg-pink-400/10 pink"}`}
                          >
                            {long ? (
                              <ArrowUpRight size={17} />
                            ) : (
                              <ArrowDownRight size={17} />
                            )}
                          </div>
                          <div>
                            <h2 className="text-[13px] font-medium">
                              {long ? "Long" : "Short"} scenario{" "}
                              <span className="muted font-normal ml-1">
                                / 15m
                              </span>
                            </h2>
                            <span className="fine">
                              Completed-candle trend confirmation
                            </span>
                          </div>
                        </div>
                        <span
                          className={`badge ${active ? (long ? "" : "red") : "dim"}`}
                        >
                          {active ? "ACTIVE" : "INACTIVE"}
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-3 mt-6">
                        {[
                          ["Entry reference", price],
                          [
                            "ATR target",
                            price && a ? price + sign * a * 3 : null,
                          ],
                          [
                            "ATR stop",
                            price && a ? price - sign * a * 1.5 : null,
                          ],
                        ].map(([label, value], i) => (
                          <div key={String(label)}>
                            <div className="eyebrow !text-[8px]">{label}</div>
                            <div
                              className={`mono text-[17px] mt-2 ${i === 1 ? "green" : i === 2 ? "pink" : ""}`}
                            >
                              ${money(value as number | null)}
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="rule" />
                      <div className="flex justify-between text-[10px] mb-3">
                        <span className="muted">
                          Raw score{" "}
                          <span className="mono text-slate-300 ml-1">
                            {signal?.score == null
                              ? "—"
                              : signed(sign * signal.score)}
                          </span>
                          <span className="ml-1">
                            · raw score, not a probability
                          </span>
                        </span>
                        <span className="muted">
                          Risk / reward{" "}
                          <span className="mono text-slate-300">1 : 2.0</span>
                        </span>
                      </div>
                      <PressureBar
                        value={
                          signal?.score == null
                            ? null
                            : ((1 + sign * signal.score) / 2) * 100
                        }
                      />
                      <div className="stat-row !mt-4 !mb-0">
                        <span className="fine">
                          {long ? "EMA 9 > 20" : "EMA 9 < 20"} + SuperTrend +
                          aligned flow
                        </span>
                        <span className="mono text-[10px] flex gap-1 items-center">
                          <Clock3 size={10} className="muted" />
                          {timer}
                        </span>
                      </div>
                    </Card>
                  );
                })}
              </div>
              <Card className="mb-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <Globe2 size={18} className="green" />
                    <div>
                      <h2 className="text-[13px] font-medium">
                        Global Market Pulse
                      </h2>
                      <p className="fine mt-1">
                        Equal-weight crypto breadth · 20-second momentum
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <span
                      className={`badge ${d?.pulse.state === "RISK-ON" ? "" : d?.pulse.state === "RISK-OFF" ? "red" : "dim"}`}
                    >
                      {d?.pulse.state ?? "INSUFFICIENT DATA"}
                    </span>
                    <div className="fine mt-2">
                      <span className="green">
                        ↗ {d?.pulse.rising ?? 0} rising
                      </span>
                      <span className="mx-3 text-slate-700">/</span>
                      <span className="pink">
                        ↘ {d?.pulse.falling ?? 0} falling
                      </span>
                    </div>
                  </div>
                </div>
                <div className="chart-grid mt-5 relative">
                  <Spark
                    points={d?.pulse.points.map((x) => x.value) ?? []}
                    color={
                      d?.pulse.state === "RISK-OFF" ? "#f2638d" : "#34e0a3"
                    }
                  />
                  {!d?.pulse.points.length && (
                    <div className="absolute inset-0 flex justify-center items-center text-[11px] muted">
                      Waiting for fresh data from at least 70% of markets
                      (minimum 6)
                    </div>
                  )}
                </div>
                <div className="flex gap-5 overflow-x-auto pt-4 border-t border-white/[.05]">
                  {(d?.markets ?? []).map((m) => (
                    <div
                      key={m.symbol}
                      className="flex gap-2 whitespace-nowrap text-[9px]"
                    >
                      <span className="muted">
                        {m.symbol.replace("-USD", "")}
                      </span>
                      <span
                        className={`mono ${m.change == null ? "muted" : m.change >= 0 ? "green" : "pink"}`}
                      >
                        {m.change == null ? "—" : `${signed(m.change, 3)}%`}
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
                {[
                  {
                    icon: Radio,
                    title: "Market freshness",
                    value: age(d?.confirmation.coinbaseAge),
                    note: stale
                      ? "Worker disconnected"
                      : (d?.connection ?? "Waiting"),
                    ok: !stale && d?.connection === "STREAMING",
                  },
                  {
                    icon: Globe2,
                    title: "Monitored markets",
                    value: `${d?.markets.filter((m) => m.fresh).length ?? 0} / ${d?.markets.length ?? 10}`,
                    note: "Coinbase · crypto pairs",
                    ok: (d?.pulse.coverage ?? 0) >= 0.7,
                  },
                  {
                    icon: ShieldCheck,
                    title: "Two-source agreement",
                    value: d?.confirmation.state ?? "STALE",
                    note: `CB / Kraken · Δ ${money(d?.confirmation.divergence, 3)}%`,
                    ok: !stale && d?.confirmation.state === "CONFIRMED",
                  },
                  {
                    icon: Wifi,
                    title: "Connection health",
                    value: stale
                      ? "OFFLINE"
                      : d?.mode === "replay"
                        ? "REPLAY"
                        : "CONNECTED",
                    note: `${d?.mode === "replay" ? "Synthetic" : `Feed latency ${money(d?.health.coinbase?.latency, 0)} ms`}`,
                    ok: !stale,
                  },
                ].map((item) => (
                  <Card key={item.title} className="!p-4">
                    <div className="flex justify-between">
                      <span className="eyebrow !text-[8px]">{item.title}</span>
                      <item.icon size={12} className="muted" />
                    </div>
                    <div
                      className={`mono text-[19px] mt-4 ${item.ok ? "green" : "text-slate-400"}`}
                    >
                      {item.value}
                    </div>
                    <p className="fine mt-2">{item.note}</p>
                  </Card>
                ))}
              </div>
              <Card className="mb-4">
                <div className="grid md:grid-cols-[1fr_1.2fr_1fr] gap-6">
                  <div>
                    <div className="flex gap-2 items-center eyebrow">
                      <BarChart3 size={14} /> Wick Lean{" "}
                      <span className="text-slate-600">/ 15m</span>
                    </div>
                    <div className="flex items-center h-28 gap-6 mt-3 justify-center">
                      {d?.candles
                        .filter(
                          (c) =>
                            c.complete &&
                            !c.partial &&
                            c.time + 900000 <= d.time,
                        )
                        .slice(-4)
                        .map((c, i) => {
                          const range = c.high - c.low || 1,
                            up = c.close >= c.open,
                            con = d.wick.candles[i];
                          return (
                            <div
                              key={c.time}
                              className="flex flex-col items-center gap-2"
                            >
                              <svg
                                viewBox="0 0 36 86"
                                width="32"
                                height="86"
                                role="img"
                                aria-label={`Closed candle ${et(c.time)} ET, upper wick ${money((con?.upper ?? 0) * 100, 0)} percent, lower ${money((con?.lower ?? 0) * 100, 0)} percent`}
                              >
                                <line
                                  x1="18"
                                  x2="18"
                                  y1="5"
                                  y2="78"
                                  stroke={up ? "#34e0a3" : "#f2638d"}
                                  strokeWidth="1.5"
                                />
                                <rect
                                  x="10"
                                  width="16"
                                  y={
                                    5 +
                                    ((c.high - Math.max(c.open, c.close)) /
                                      range) *
                                      73
                                  }
                                  height={Math.max(
                                    2,
                                    (Math.abs(c.open - c.close) / range) * 73,
                                  )}
                                  fill={up ? "#34e0a3" : "#f2638d"}
                                  rx="2"
                                />
                                {con && Math.abs(con.score) > 0.2 && (
                                  <circle
                                    cx="18"
                                    cy={con.score > 0 ? 80 : 3}
                                    r="3"
                                    fill={con.score > 0 ? "#34e0a3" : "#f2638d"}
                                  />
                                )}
                              </svg>
                              <span className="mono text-[8px] muted">
                                {et(c.time).slice(0, 5)}
                              </span>
                            </div>
                          );
                        })}
                    </div>
                  </div>
                  <div className="md:border-x border-white/[.06] md:px-6">
                    <span className="eyebrow">Rejection structure</span>
                    <div
                      className={`text-[19px] mt-4 ${d?.wick.score != null && d.wick.score > 0 ? "green" : "text-slate-300"}`}
                    >
                      {d?.wick.label ?? "INSUFFICIENT DATA"}
                    </div>
                    <p className="fine mt-3">
                      Previous four fully closed candles, weighted 1 → 4 by
                      recency. Wick asymmetry is normalized by range, body and
                      ATR.
                    </p>
                    <div className="mono text-[11px] mt-3">
                      Score{" "}
                      <span className="green">{signed(d?.wick.score, 3)}</span>{" "}
                      <span className="muted">/ −1 to +1</span>
                    </div>
                  </div>
                  <div>
                    <span className="eyebrow">Signal context</span>
                    <p className="text-[11px] text-slate-400 leading-5 mt-4">
                      {signal?.reason ?? "Waiting for the market engine."}
                    </p>
                    <div className="flex justify-between mt-4 text-[10px]">
                      <span className="muted">Next 15m candle close</span>
                      <span className="mono">{timer}</span>
                    </div>
                    <p className="fine mt-2">
                      Wick rejection alone never activates a trade.
                    </p>
                  </div>
                </div>
              </Card>
              <Card className="!p-0">
                <div className="flex flex-wrap gap-3 justify-between items-center p-5 border-b border-white/[.06]">
                  <div className="flex items-center gap-3">
                    <span className="font-medium">BTC / USD</span>
                    <span className="badge dim">15m</span>
                    <span className="fine hidden md:inline">
                      Coinbase Exchange
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant={ha ? "ghost" : "outline"}
                      size="sm"
                      onClick={() => setHa(false)}
                    >
                      OHLC
                    </Button>
                    <Button
                      variant={ha ? "outline" : "ghost"}
                      size="sm"
                      onClick={() => setHa(true)}
                    >
                      Heikin Ashi
                    </Button>
                    <Button
                      variant={overlay ? "outline" : "ghost"}
                      size="sm"
                      onClick={() => setOverlay((v) => !v)}
                    >
                      Indicators
                    </Button>
                  </div>
                </div>
                <div className="flex gap-5 px-5 pt-4 text-[9px]">
                  <span className="text-cyan-400">● EMA 9</span>
                  <span className="text-violet-400">● EMA 20</span>
                  <span className="text-amber-300">● SuperTrend</span>
                  <span className="muted">▥ Volume delta</span>
                </div>
                <MarketChart
                  candles={d?.candles ?? []}
                  signals={d?.signals ?? []}
                  ha={ha}
                  overlay={overlay}
                  atrPeriod={d?.settings.atrPeriod ?? 14}
                  multiplier={d?.settings.multiplier ?? 3}
                />
                <div className="fine px-5 pb-4">
                  Historical REST candles have no aggressor delta; zero means
                  unavailable for that history. Live delta begins when the
                  worker connects. Charts by{" "}
                  <a
                    className="text-slate-400"
                    href="https://www.tradingview.com/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    TradingView Lightweight Charts
                  </a>
                  .
                </div>
              </Card>
            </>
          )}
          {tab === "Kalshi 15m" &&
            (d?.contract ? (
              <KalshiTab
                c={d.contract}
                now={now}
                stale={stale}
                busy={busy}
                worker={worker}
                mutate={(endpoint, body) => mutate(endpoint, body, "contracts")}
              />
            ) : (
              <Card>
                <p className="fine">
                  Waiting for the worker&apos;s contract data.
                </p>
              </Card>
            ))}
          {tab === "Signal History" && (
            <div className="space-y-4">
              <Card>
                <div className="flex justify-between items-center">
                  <div>
                    <h2>Forecast ledger</h2>
                    <p className="fine mt-2">
                      Immutable creation records · actual observed prices at
                      T+20s · ET
                    </p>
                  </div>
                  <Button asChild variant="outline">
                    <a href={`${worker}/api/history.csv`}>
                      <Download size={13} />
                      Export CSV
                    </a>
                  </Button>
                </div>
              </Card>
              <Card className="!p-0">
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        {[
                          "Created ET",
                          "Mode",
                          "Start",
                          "Projected",
                          "Actual",
                          "Direction",
                          "Abs. error",
                          "Outcome",
                        ].map((h) => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {d?.forecasts
                        .slice()
                        .reverse()
                        .map((f) => {
                          const o = d.outcomes.find((o) => o.id === f.id);
                          return (
                            <tr key={f.id} className="mono">
                              <td>{etDateTime(f.created)}</td>
                              <td>{f.mode}</td>
                              <td>${money(f.starting)}</td>
                              <td>${money(f.projected)}</td>
                              <td>${money(o?.actual)}</td>
                              <td className={o?.correct ? "green" : "muted"}>
                                {o?.correct == null
                                  ? "—"
                                  : o.correct
                                    ? "Correct"
                                    : "Incorrect"}
                              </td>
                              <td>${money(o?.absoluteError)}</td>
                              <td>
                                <span className="badge dim">
                                  {o?.status ?? "PENDING"}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                  {!d?.forecasts.length && (
                    <p className="muted text-center p-12">
                      Forecasts appear after approximately 30 seconds of fresh
                      data.
                    </p>
                  )}
                </div>
              </Card>
              <Card>
                <h2 className="mb-4">15-minute signal events</h2>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Recorded ET</th>
                        <th>State</th>
                        <th>Coverage</th>
                        <th>Explanation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d?.signals
                        .slice()
                        .reverse()
                        .slice(0, 100)
                        .map((s, i) => (
                          <tr key={`${s.id}-${i}`}>
                            <td className="mono">{et(s.time)}</td>
                            <td>{s.state}</td>
                            <td>{money(s.coverage * 100, 0)}%</td>
                            <td>{s.reason}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          )}
          {tab === "Backtesting & Analytics" && (
            <div className="space-y-4">
              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {[
                  ["Completed predictions", stats?.n],
                  [
                    "Directional accuracy",
                    stats?.accuracy == null
                      ? "—"
                      : `${money(stats.accuracy, 1)}%`,
                  ],
                  [
                    "Mean absolute error",
                    stats?.mae == null ? "—" : `$${money(stats.mae)}`,
                  ],
                  [
                    "Median forecast error",
                    stats?.median == null ? "—" : `$${money(stats.median)}`,
                  ],
                  ["Simulated net P&L", `$${signed(stats?.net)}`],
                  ["Maximum drawdown", `${money(stats?.drawdown)}%`],
                  ["Realized risk / reward", money(stats?.rr)],
                  [
                    "15m signal hit rate",
                    stats?.signalHit == null
                      ? "Insufficient data"
                      : `${money(stats.signalHit, 1)}% (n=${stats.signalN})`,
                  ],
                ].map(([label, value]) => (
                  <Card key={String(label)}>
                    <div className="eyebrow !text-[9px]">{label}</div>
                    <div className="mono text-2xl mt-4">{value ?? "—"}</div>
                  </Card>
                ))}
              </div>
              <Card>
                <h2 className="mb-4">Accuracy by velocity regime</h2>
                <div className="grid sm:grid-cols-3 gap-4">
                  {stats?.regimes.map((r) => (
                    <div
                      key={r.regime}
                      className="p-4 border border-white/[.06] rounded-lg"
                    >
                      <div className="eyebrow">{r.regime}</div>
                      <div className="mono metric mt-2">
                        {money(r.accuracy, 1)}%
                      </div>
                      <p className="fine">n = {r.n} completed forecasts</p>
                    </div>
                  ))}
                </div>
                <p className="fine mt-4">
                  Regimes use |30s velocity × 30 / price|: low &lt;0.02%, high
                  &gt;0.10%, normal otherwise. These are descriptive buckets,
                  not calibrated volatility forecasts.
                </p>
              </Card>
              <Card>
                <div className="flex items-center gap-3">
                  <FlaskConical size={18} className="green" />
                  <h2>Chronological walk-forward validation</h2>
                  <Button
                    variant="outline"
                    className="ml-auto"
                    disabled={busy || !d}
                    onClick={() => void runBacktest()}
                  >
                    {busy ? "Running…" : "Run 1-hour fixture"}
                  </Button>
                </div>
                {backtest && (
                  <div
                    role="status"
                    className="border border-cyan-400/20 bg-cyan-400/5 p-4 rounded-lg mt-4 text-xs"
                  >
                    <strong>SYNTHETIC FIXTURE RESULT</strong>
                    <p className="mono mt-2">
                      {backtest.n} completed · {money(backtest.accuracy, 1)}%
                      direction agreement · ${money(backtest.mae)} MAE ·{" "}
                      {backtest.seconds}s replay
                    </p>
                    <p className="fine mt-2">
                      Validation of engine mechanics only. These results do not
                      establish historical market accuracy or profitability.
                    </p>
                  </div>
                )}
                <p className="text-xs text-slate-400 leading-6 mt-4">
                  Run{" "}
                  <code className="mono text-emerald-300">npm run replay</code>{" "}
                  for a deterministic, chronological engine validation. Each
                  prediction uses only samples already delivered. Forecasts are
                  stored before outcomes. {stats?.missed ?? 0} horizons were
                  missed and excluded from accuracy.
                </p>
                <p className="fine mt-3">
                  {(stats?.n ?? 0) < 100
                    ? "Insufficient sample size: fewer than 100 completed forecasts."
                    : ""}{" "}
                  Replay data is synthetic and is not evidence of a live trading
                  edge. 15m hit rate measures closed, signal-linked opt-in paper
                  trades after fees and slippage; manual trades are excluded.
                  Overlapping 20s forecasts are statistically dependent.
                </p>
                <p className="fine mt-3">
                  This view covers the most recent 1,000 forecasts held in the
                  dashboard. CSV includes the worker’s retained history (up to
                  8,640). Long-term data lives in the local journal and optional
                  Supabase.
                </p>
              </Card>
            </div>
          )}
          {tab === "Paper Trading" && (
            <div className="space-y-4">
              <div className="border border-cyan-400/20 bg-cyan-400/5 text-cyan-200 rounded-lg p-4 text-xs">
                Simulation account · no real money or brokerage connection ·{" "}
                {d?.paper.auto
                  ? "automatic entries explicitly enabled"
                  : "manual entries only"}
              </div>
              <div className="grid sm:grid-cols-4 gap-4">
                {[
                  ["Starting balance", d?.paper.starting],
                  ["Account equity", d?.paper.equity],
                  ["Realized net P&L", stats?.net],
                  ["Daily P&L · ET", d?.paper.dailyPnl],
                ].map(([l, v]) => (
                  <Card key={String(l)}>
                    <div className="eyebrow !text-[9px]">{l}</div>
                    <div className="mono metric mt-4">
                      ${money(v as number)}
                    </div>
                  </Card>
                ))}
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                <Card>
                  <h2 className="mb-5">Manual paper order</h2>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      void mutate("open", {
                        direction: f.get("direction"),
                        size: Number(f.get("size")),
                        stop: Number(f.get("stop")),
                        target: Number(f.get("target")),
                      });
                    }}
                    className="grid grid-cols-2 gap-4"
                  >
                    <label>
                      Direction
                      <select name="direction">
                        <option>LONG</option>
                        <option>SHORT</option>
                      </select>
                    </label>
                    <label>
                      Position size · BTC
                      <input
                        type="number"
                        name="size"
                        min="0.00001"
                        step="0.00001"
                        defaultValue="0.001"
                        required
                      />
                    </label>
                    <label>
                      Stop price · USD
                      <input
                        name="stop"
                        type="number"
                        min="1"
                        step=".01"
                        placeholder={money(price ? price - 300 : null)}
                        required
                      />
                    </label>
                    <label>
                      Target price · USD
                      <input
                        name="target"
                        type="number"
                        min="1"
                        step=".01"
                        placeholder={money(price ? price + 600 : null)}
                        required
                      />
                    </label>
                    <Button
                      disabled={
                        busy ||
                        stale ||
                        d?.connection !== "STREAMING" ||
                        !!d?.paper.position
                      }
                      className="col-span-2"
                    >
                      <Wallet size={13} />
                      Open simulated position
                    </Button>
                  </form>
                  <p className="fine mt-4">
                    Market reference ${money(price)} · fee{" "}
                    {d?.paper.feeBps ?? 6} bps per side · slippage{" "}
                    {d?.paper.slippageBps ?? 2} bps per fill. Stops execute at
                    the next observed price; gaps can exceed your stop.
                  </p>
                </Card>
                <Card>
                  <h2>Open position</h2>
                  {d?.paper.position ? (
                    <>
                      <div className="metric mono mt-5">
                        {d.paper.position.direction}{" "}
                        <span className="muted text-lg">
                          {d.paper.position.size} BTC
                        </span>
                      </div>
                      <div className="stat-row">
                        <span className="muted">Slipped entry</span>
                        <span className="mono">
                          ${money(d.paper.position.entry)}
                        </span>
                      </div>
                      <div className="stat-row">
                        <span className="muted">Stop / target</span>
                        <span className="mono">
                          ${money(d.paper.position.stop)} / $
                          {money(d.paper.position.target)}
                        </span>
                      </div>
                      <Button
                        variant="outline"
                        disabled={busy || stale || d.connection !== "STREAMING"}
                        onClick={() => void mutate("close", {})}
                      >
                        Close simulated position
                      </Button>
                    </>
                  ) : (
                    <p className="muted mt-12 text-center text-xs">
                      No open position
                    </p>
                  )}
                </Card>
              </div>
              <Card>
                <h2>Account equity</h2>
                <div className="chart-grid mt-5">
                  <Spark
                    points={d?.paper.curve.map((p) => p.equity) ?? []}
                    height={160}
                  />
                </div>
              </Card>
              <Card>
                <h2 className="mb-4">
                  Trade journal · net of fees and slippage
                </h2>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        {[
                          "Closed ET",
                          "Direction",
                          "Size",
                          "Entry",
                          "Exit",
                          "Net P&L",
                          "Realized R",
                          "Reason",
                        ].map((h) => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {d?.paper.trades
                        .slice()
                        .reverse()
                        .map((t) => (
                          <tr key={t.id} className="mono">
                            <td>{et(t.closed)}</td>
                            <td>{t.direction}</td>
                            <td>{t.size}</td>
                            <td>${money(t.entry)}</td>
                            <td>${money(t.exit)}</td>
                            <td className={t.pnl >= 0 ? "green" : "pink"}>
                              ${signed(t.pnl)}
                            </td>
                            <td>{signed(t.rr)}</td>
                            <td>{t.reason}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          )}
          {tab === "Settings" && (
            <div className="grid md:grid-cols-2 gap-4">
              <Card>
                <h2>Data & calculation settings</h2>
                <p className="fine mt-3">
                  Worker settings are validated at startup. Edit .env and
                  restart the worker to apply.
                </p>
                {[
                  ["Data mode", d?.mode ?? "Unknown"],
                  ["Persistence", d?.persistence ?? "Unknown"],
                  ["Freshness limit", `${d?.settings.freshness ?? 5000} ms`],
                  ["Divergence limit", `${d?.settings.divergence ?? 0.2}%`],
                  ["ATR period", d?.settings.atrPeriod ?? 14],
                  ["SuperTrend multiplier", d?.settings.multiplier ?? 3],
                  ["Regression / horizon", "10s OLS / 20s"],
                  ["Pressure windows", "20s / 60s"],
                  ["Market coverage", "70% fresh · minimum 6"],
                ].map(([k, v]) => (
                  <div className="stat-row" key={String(k)}>
                    <span className="muted">{k}</span>
                    <span className="mono">{v}</span>
                  </div>
                ))}
                {d?.persistenceError && (
                  <p className="pink text-xs mt-4">{d.persistenceError}</p>
                )}
                <div className="rule" />
                <div className="fine">
                  Score weights: momentum 25%, aggressor volume 25%, book 20%,
                  trend 20%, wick 10%. All features normalized to [−1, 1];
                  minimum 95% coverage. A heuristic score is not a win
                  probability.
                </div>
              </Card>
              <Card>
                <h2>Paper execution</h2>
                <form
                  className="grid gap-4 mt-5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    void mutate("settings", {
                      feeBps: Number(f.get("fee")),
                      slippageBps: Number(f.get("slip")),
                      auto: f.get("auto") === "on",
                    });
                  }}
                >
                  <div className="grid grid-cols-2 gap-4">
                    <label>
                      Fees · basis points
                      <input
                        type="number"
                        name="fee"
                        min="0"
                        max="100"
                        step=".1"
                        defaultValue={d?.paper.feeBps ?? 6}
                      />
                    </label>
                    <label>
                      Slippage · basis points
                      <input
                        type="number"
                        name="slip"
                        min="0"
                        max="100"
                        step=".1"
                        defaultValue={d?.paper.slippageBps ?? 2}
                      />
                    </label>
                  </div>
                  <label>
                    Worker API token (session only)
                    <input
                      type="password"
                      value={token}
                      autoComplete="off"
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="Required for remote paper-account changes"
                    />
                  </label>
                  <label className="!flex-row items-start">
                    <input
                      type="checkbox"
                      name="auto"
                      defaultChecked={d?.paper.auto ?? false}
                    />
                    <span>
                      Explicitly enable automatic simulated entries
                      <br />
                      <span className="fine">
                        One entry per signal candle, 0.001 BTC maximum. Resets
                        to manual after restart.
                      </span>
                    </span>
                  </label>
                  <Button disabled={busy || !!d?.paper.position}>
                    Save paper settings
                  </Button>
                </form>
                <p className="fine mt-4">
                  Account changes are locked while a position is open.
                </p>
              </Card>
              <Card>
                <h2>Independent source comparison</h2>
                {[
                  [
                    "Coinbase BTC-USD",
                    `$${money(d?.confirmation.coinbase)} · ${age(d?.confirmation.coinbaseAge)}`,
                  ],
                  [
                    "Kraken BTC/USD",
                    `$${money(d?.confirmation.kraken)} · ${age(d?.confirmation.krakenAge)}`,
                  ],
                  ["Divergence", `${money(d?.confirmation.divergence, 4)}%`],
                ].map(([k, v]) => (
                  <div className="stat-row" key={k}>
                    <span className="muted">{k}</span>
                    <span className="mono">{v}</span>
                  </div>
                ))}
                <p className="fine mt-4">
                  Resting order-book liquidity and executed trade pressure
                  measure different things. Confirmation compares prices only,
                  and is never fabricated in replay.
                </p>
              </Card>
              <Card>
                <h2>Feed diagnostics</h2>
                {Object.entries(d?.health ?? {}).map(([name, h]) => (
                  <div key={name} className="mt-4">
                    <div className="stat-row">
                      <span>{name}</span>
                      <span className="mono text-[10px]">
                        {h.status} · {age(now - h.lastMessage)}
                      </span>
                    </div>
                    <p className="fine">
                      Reconnects {h.reconnects} · gap observations {h.gaps} ·
                      out-of-order {h.outOfOrder}
                    </p>
                    {h.errors.map((e, i) => (
                      <p key={i} className="fine pink">
                        {e}
                      </p>
                    ))}
                  </div>
                ))}
              </Card>
              <Card className="md:col-span-2">
                <h2 className="mb-4">Configured crypto markets</h2>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        {[
                          "Market",
                          "Last price",
                          "20s move",
                          "Data age",
                          "Source",
                          "Availability",
                        ].map((h) => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {d?.markets.map((m) => (
                        <tr key={m.symbol}>
                          <td className="mono">{m.symbol}</td>
                          <td className="mono">${money(m.price, 4)}</td>
                          <td className="mono">{signed(m.change, 4)}%</td>
                          <td className="mono">
                            {age(
                              m.age == null
                                ? null
                                : m.age + Math.max(0, now - d.time),
                            )}
                          </td>
                          <td>{m.source}</td>
                          <td>
                            <span
                              className={`badge ${!stale && m.fresh ? "" : "dim"}`}
                            >
                              {!stale && m.fresh ? "FRESH" : "STALE"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          )}
        </main>
        <footer className="border-t border-white/[.06] flex flex-wrap gap-3 justify-between py-5 text-[9px] text-slate-600">
          <div className="flex gap-2 items-center">
            <Activity size={12} /> PulseTerminal{" "}
            <span className="text-slate-700">/</span> Intelligence, with
            evidence.
          </div>
          <div>
            Extrapolations & heuristics · simulation only · no guaranteed
            returns
          </div>
          <span className="mono">
            {d?.persistence ?? "WORKER OFFLINE"} <span className="mx-2">·</span>{" "}
            V1.0
          </span>
        </footer>
      </div>
    </div>
  );
}
