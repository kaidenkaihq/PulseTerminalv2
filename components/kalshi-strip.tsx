"use client";
import { ArrowRight, Target } from "lucide-react";
import { Card } from "./ui/card";
import type { ContractView } from "@/lib/types";
import type { EngineView, SideEdge } from "@/lib/verdict";
// Every number states its kind: market price (¢), calibrated probability (%), or raw score.
export const cents = (v: number | null | undefined) =>
  v == null ? "—" : `${(v * 100).toFixed(v * 100 < 10 ? 1 : 0)}¢`;
export const prob = (v: number | null | undefined) =>
  v == null ? "—" : `${(v * 100).toFixed(1)}%`;
export const edgeText = (v: number | null | undefined) =>
  v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}¢`;
const usd = (v: number | null | undefined, dec = 2) =>
  v == null
    ? "—"
    : v.toLocaleString("en-US", {
        minimumFractionDigits: dec,
        maximumFractionDigits: dec,
      });
export const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
export function sourceLabel(c: ContractView) {
  if (c.synthetic) return "SYNTHETIC CONTRACT · NOT KALSHI";
  if (!c.quote) return `KALSHI · ${c.status}`;
  return c.quote.source === "kalshi-ws"
    ? "KALSHI · WEBSOCKET"
    : "KALSHI · PUBLIC REST";
}
// The engine whose calibrated probability is shown: the verdict's engine, else the most-sampled.
export function headlineEngine(c: ContractView): EngineView | undefined {
  return (
    c.engineViews.find((e) => e.name === c.verdict?.engine) ??
    [...c.engineViews].sort((a, b) => b.n - a.n)[0]
  );
}
function SideBars({
  s,
  status,
  n,
}: {
  s: SideEdge;
  status: string;
  n: number;
}) {
  const up = s.side === "UP";
  return (
    <div>
      <div className="flex justify-between text-[10px] mb-2">
        <span className={up ? "green" : "pink"}>
          {up ? "UP · YES" : "DOWN · NO"}
        </span>
        <span className="muted">
          edge after fees{" "}
          <span
            className={`mono ${s.edge == null ? "" : s.edge >= 0 ? "green" : "pink"}`}
          >
            {edgeText(s.edge)}
          </span>
        </span>
      </div>
      {[
        [
          status === "CALIBRATED"
            ? "Calibrated P"
            : `Model P · UNCALIBRATED (n=${n})`,
          s.modelP,
          prob(s.modelP),
          up ? "bg-emerald-400/70" : "bg-pink-400/70",
        ],
        [
          "Market price (ask + fee)",
          s.marketP,
          cents(s.marketP),
          "bg-slate-400/60",
        ],
      ].map(([label, v, text, color]) => (
        <div key={String(label)} className="mb-2">
          <div className="flex justify-between text-[9px] muted mb-1">
            <span>{label}</span>
            <span className="mono text-slate-300">{text}</span>
          </div>
          <div className="h-[5px] rounded bg-white/[.05] overflow-hidden">
            <div
              className={`h-full ${color}`}
              style={{
                width: `${Math.max(0, Math.min(1, (v as number) ?? 0)) * 100}%`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
export function KalshiStrip({
  c,
  now,
  stale,
  onOpen,
}: {
  c: ContractView;
  now: number;
  stale: boolean;
  onOpen?: () => void;
}) {
  const seconds = Math.max(
      0,
      Math.ceil((c.close - (now || c.close - c.ttc * 1000)) / 1000),
    ),
    v = stale ? null : c.verdict,
    e = headlineEngine(c),
    healthy = c.quoteFresh && !stale,
    up = (c.distance ?? 0) >= 0;
  return (
    <Card className="mb-4">
      <div className="grid gap-5 lg:grid-cols-[1fr_1.15fr_1fr] lg:items-center">
        <div>
          <div className="flex items-center gap-2 eyebrow flex-wrap">
            <Target size={13} className="green" /> Kalshi BTC 15m
            <span
              className={`badge ${c.synthetic ? "dim" : healthy ? "" : "red"} !text-[8px]`}
            >
              <span className="dot" />
              {sourceLabel(c)}
            </span>
          </div>
          <div className="flex items-end gap-4 mt-4">
            <span className="mono text-[34px] leading-none tracking-[-1px]">
              {clock(seconds)}
            </span>
            <span className="badge dim mb-1">
              {c.bucket ?? "closed"} to close
            </span>
          </div>
          <div className="fine mt-3 break-all">
            {c.quote?.ticker ?? "No active contract"}
          </div>
          <div className="stat-row !mb-0">
            <span className="muted">
              Target (
              {c.strikeSource === "kalshi"
                ? "Kalshi strike"
                : c.strikeSource === "proxy"
                  ? "proxy estimate"
                  : "unknown"}
              )
            </span>
            <span className="mono">${usd(c.strike)}</span>
          </div>
          <div className="stat-row !my-1">
            <span className="muted">Proxy price ({c.proxySource ?? "—"})</span>
            <span className={`mono ${up ? "green" : "pink"}`}>
              ${usd(c.proxy)}{" "}
              <span className="text-[10px]">
                {c.distance == null
                  ? ""
                  : `${up ? "+" : ""}${usd(c.distance)} · ${up ? "+" : ""}${usd(c.distancePercent, 3)}%`}
              </span>
            </span>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:border-x border-white/[.06] lg:px-5">
          {e ? (
            <>
              <SideBars s={e.up} status={e.status} n={e.n} />
              <SideBars s={e.down} status={e.status} n={e.n} />
              <div className="fine sm:col-span-2">
                {e.label} engine · market price = ask + Kalshi fee per contract
              </div>
            </>
          ) : (
            <div className="fine">Waiting for engines.</div>
          )}
        </div>
        <div>
          <div className="eyebrow !text-[9px]">Verdict</div>
          <div
            className={`text-[26px] font-medium tracking-tight mt-2 ${v?.action === "BUY YES" ? "green" : v?.action === "BUY NO" ? "pink" : "text-slate-300"}`}
          >
            {v?.action ?? "NO TRADE"}
          </div>
          <ul className="fine mt-2 space-y-0.5">
            {(stale
              ? ["Worker connection stale"]
              : (v?.reasons ?? ["Waiting for data"])
            )
              .slice(0, 3)
              .map((r) => (
                <li key={r}>{r}</li>
              ))}
          </ul>
          {v?.disagreement && (
            <p className="text-[10px] text-amber-200/90 mt-2">
              {v.disagreement}
            </p>
          )}
          {onOpen && (
            <button
              onClick={onOpen}
              className="mt-3 text-[10px] green inline-flex items-center gap-1 hover:underline"
            >
              Open Kalshi tab <ArrowRight size={11} />
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}
