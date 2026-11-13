"use client";
import { useState } from "react";
import { Download, ShieldCheck, Wallet } from "lucide-react";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import {
  cents,
  edgeText,
  KalshiStrip,
  prob,
  sourceLabel,
} from "./kalshi-strip";
import { SignalHistory } from "./kalshi-signals";
import type { ContractView } from "@/lib/types";
const usd = (v: number | null | undefined, dec = 2) =>
  v == null
    ? "—"
    : `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", {
        minimumFractionDigits: dec,
        maximumFractionDigits: dec,
      })}`;
const num = (v: number | null | undefined, dec = 4) =>
  v == null ? "—" : v.toFixed(dec);
const utc = (v: number) =>
  new Date(v).toLocaleTimeString("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
  });
// Observed frequency against calibrated probability; the diagonal is perfect calibration.
function Reliability({
  bins,
}: {
  bins: { predicted: number; observed: number; n: number }[];
}) {
  const max = Math.max(1, ...bins.map((b) => b.n));
  return (
    <svg
      viewBox="0 0 220 220"
      className="w-full max-w-[260px]"
      role="img"
      aria-label="Reliability chart: calibrated probability versus observed UP frequency"
    >
      <rect x="20" y="0" width="200" height="200" fill="#ffffff03" />
      <line
        x1="20"
        y1="200"
        x2="220"
        y2="0"
        stroke="#ffffff22"
        strokeDasharray="4 4"
      />
      {bins.map((b) => (
        <circle
          key={b.predicted}
          cx={20 + b.predicted * 200}
          cy={200 - b.observed * 200}
          r={3 + 6 * Math.sqrt(b.n / max)}
          fill="#34e0a3"
          fillOpacity=".55"
        >
          <title>{`calibrated ${(b.predicted * 100).toFixed(0)}% · observed ${(b.observed * 100).toFixed(0)}% · n=${b.n}`}</title>
        </circle>
      ))}
      <text x="20" y="214" fontSize="9" fill="#758299">
        0%
      </text>
      <text x="196" y="214" fontSize="9" fill="#758299">
        100%
      </text>
      <text x="0" y="8" fontSize="9" fill="#758299">
        UP
      </text>
    </svg>
  );
}
export function KalshiTab({
  c,
  now,
  stale,
  busy,
  worker,
  mutate,
}: {
  c: ContractView;
  now: number;
  stale: boolean;
  busy: boolean;
  worker: string;
  mutate: (endpoint: string, body: unknown) => Promise<void>;
}) {
  const [cell, setCell] = useState("fade|5–2m"),
    selected =
      c.calibration.find((x) => `${x.engine}|${x.bucket}` === cell) ??
      c.calibration[0],
    p = c.paper,
    m = c.paperMetrics,
    pos = p.position,
    canTrade = !busy && !stale && c.quoteFresh && !!c.bucket && !pos,
    heldBid = pos
      ? pos.side === "UP"
        ? c.quote?.yesBid
        : c.quote?.noBid
      : null;
  return (
    <div className="space-y-4">
      <div className="border border-cyan-400/20 bg-cyan-400/5 text-cyan-200 rounded-lg p-4 text-xs">
        Read-only Kalshi market data · contract trading here is simulated · no
        order is ever sent to Kalshi. {sourceLabel(c)}.
      </div>
      <KalshiStrip c={c} now={now} stale={stale} />
      <div className="grid md:grid-cols-2 gap-4">
        {c.engineViews.map((e) => (
          <Card key={e.name}>
            <div className="flex justify-between items-start gap-3">
              <div>
                <h2 className="text-[13px] font-medium">{e.label}</h2>
                <span className="fine">{e.reading.engine}</span>
              </div>
              <span
                className={`badge ${e.status === "CALIBRATED" ? "" : "dim"}`}
              >
                {e.status === "CALIBRATED"
                  ? `CALIBRATED · n=${e.n}`
                  : `UNCALIBRATED (n=${e.n})`}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-3 mt-5">
              <div>
                <div className="eyebrow !text-[8px]">Reading</div>
                <div
                  className={`mono text-[15px] mt-2 ${e.reading.state === "UP" ? "green" : e.reading.state === "DOWN" ? "pink" : ""}`}
                >
                  {e.reading.state}
                </div>
              </div>
              <div>
                <div className="eyebrow !text-[8px]">Raw score</div>
                <div className="mono text-[15px] mt-2">
                  {num(e.reading.score, 2)}
                </div>
                <div className="fine">raw score, not a probability</div>
              </div>
              <div>
                <div className="eyebrow !text-[8px]">P(UP)</div>
                <div className="mono text-[15px] mt-2">{prob(e.p)}</div>
                <div className="fine">
                  {e.status === "CALIBRATED"
                    ? "calibrated probability"
                    : "uncalibrated, cannot drive a verdict"}
                </div>
              </div>
            </div>
            <div className="rule" />
            {[e.up, e.down].map((s) => (
              <div className="stat-row" key={s.side}>
                <span className="muted">
                  {s.side === "UP" ? "YES" : "NO"} · market {cents(s.marketP)}{" "}
                  (ask {cents(s.ask)} + fee {cents(s.fee)})
                </span>
                <span
                  className={`mono ${s.edge == null ? "" : s.edge >= 0 ? "green" : "pink"}`}
                >
                  edge {edgeText(s.edge)}
                </span>
              </div>
            ))}
            <p className="fine mt-3">{e.reading.reason}</p>
            <p className="fine">
              Recent out-of-sample Brier {num(e.recentBrier)}
            </p>
          </Card>
        ))}
      </div>
      <SignalHistory worker={worker} count={c.signalCount} />
      <Card>
        <div className="flex flex-wrap justify-between items-center gap-3">
          <h2>Calibration · engine × seconds-to-close bucket</h2>
          <span className="fine">
            Walk-forward, out of sample. Verdicts need n ≥ minimum and Brier
            below the base-rate baseline.
          </span>
        </div>
        <div className="grid lg:grid-cols-[1.6fr_1fr] gap-5 mt-4">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Engine</th>
                  <th>Bucket</th>
                  <th>Status</th>
                  <th>n windows</th>
                  <th>Hit rate</th>
                  <th>Brier</th>
                  <th>Baseline</th>
                  <th>Log loss</th>
                </tr>
              </thead>
              <tbody>
                {c.calibration.map((x) => {
                  const key = `${x.engine}|${x.bucket}`;
                  return (
                    <tr
                      key={key}
                      onClick={() => setCell(key)}
                      className={`mono cursor-pointer ${key === `${selected?.engine}|${selected?.bucket}` ? "bg-white/[.04]" : "hover:bg-white/[.02]"}`}
                    >
                      <td>{x.engine}</td>
                      <td>{x.bucket}</td>
                      <td
                        className={
                          x.status === "CALIBRATED" ? "green" : "muted"
                        }
                      >
                        {x.status}
                      </td>
                      <td>{x.n}</td>
                      <td>{prob(x.hitRate)}</td>
                      <td>{num(x.brier)}</td>
                      <td>{num(x.baselineBrier)}</td>
                      <td>{num(x.logLoss)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div>
            <div className="eyebrow !text-[9px] mb-3">
              Reliability · {selected?.engine} {selected?.bucket}
            </div>
            {selected?.reliability.length ? (
              <Reliability bins={selected.reliability} />
            ) : (
              <p className="fine">
                No out-of-sample predictions yet. Each bucket needs at least 20
                completed windows before the first walk-forward prediction.
              </p>
            )}
            <p className="fine mt-2">
              x: calibrated P(UP) · y: observed UP frequency · dot size: n
            </p>
          </div>
        </div>
      </Card>
      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <h2>Settlement: proxy vs official</h2>
          {[
            ["Windows compared", c.agreement.compared],
            ["Proxy ≠ official result", c.agreement.mismatches],
            [
              "Last open basis (official strike − proxy)",
              usd(c.basis.lastOpen),
            ],
            [
              "Last close basis (official settle − proxy)",
              usd(c.basis.lastClose),
            ],
          ].map(([k, v]) => (
            <div className="stat-row" key={String(k)}>
              <span className="muted">{k}</span>
              <span className="mono">{v}</span>
            </div>
          ))}
          <p className="fine mt-3">{c.basis.note}</p>
        </Card>
        <Card className="!p-0">
          <div className="p-5 pb-0">
            <h2>Recent windows</h2>
          </div>
          <div className="table-wrap mt-3">
            <table>
              <thead>
                <tr>
                  <th>Open UTC</th>
                  <th>Strike</th>
                  <th>Proxy settle</th>
                  <th>Proxy</th>
                  <th>Official</th>
                </tr>
              </thead>
              <tbody>
                {c.outcomes
                  .slice()
                  .reverse()
                  .slice(0, 8)
                  .map((o) => {
                    const official = c.settlements.find(
                      (s) => s.window === o.window,
                    );
                    return (
                      <tr key={o.id} className="mono">
                        <td>{utc(o.window)}</td>
                        <td>{usd(o.strike)}</td>
                        <td>{usd(o.proxySettle)}</td>
                        <td>{o.result ?? o.status}</td>
                        <td>
                          {official
                            ? `${official.result}${official.source === "synthetic" ? " (synthetic)" : ""}`
                            : "pending"}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          ["Contract balance", usd(p.balance)],
          ["Equity (at bid)", usd(p.equity)],
          ["Realized P&L", usd(m.pnl)],
          ["Daily P&L · UTC", usd(p.dailyPnl)],
        ].map(([l, v]) => (
          <Card key={l}>
            <div className="eyebrow !text-[9px]">{l}</div>
            <div className="mono metric mt-4">{v}</div>
          </Card>
        ))}
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <h2 className="mb-4">Simulated contract order</h2>
          {pos ? (
            <>
              {[
                [
                  "Position",
                  `${pos.contracts} × ${pos.side === "UP" ? "YES" : "NO"} @ ${cents(pos.entry)}`,
                ],
                ["Cost incl. fee", usd(pos.cost)],
                ["Current bid", cents(heldBid)],
                ["Peak bid", cents(pos.peakBid)],
                ["Engine · bucket", `${pos.engine} · ${pos.bucket ?? "—"}`],
                ["Edge at entry", edgeText(pos.edge)],
              ].map(([k, v]) => (
                <div className="stat-row" key={k}>
                  <span className="muted">{k}</span>
                  <span className="mono">{v}</span>
                </div>
              ))}
              <Button
                variant="outline"
                className="w-full mt-3"
                disabled={
                  busy || stale || !c.quoteFresh || pos.window !== c.window
                }
                onClick={() => void mutate("close", {})}
              >
                Sell at bid now
              </Button>
            </>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {(["UP", "DOWN"] as const).map((side) => {
                const ask = side === "UP" ? c.quote?.yesAsk : c.quote?.noAsk;
                return (
                  <Button
                    key={side}
                    variant={side === "UP" ? "default" : "outline"}
                    disabled={!canTrade || ask == null}
                    onClick={() => void mutate("open", { side })}
                  >
                    <Wallet size={13} />
                    Buy {side === "UP" ? "YES" : "NO"} · {cents(ask)}
                  </Button>
                );
              })}
            </div>
          )}
          <p className="fine mt-4">
            {p.contracts} contracts per trade · max stake {usd(p.maxStake)} per
            window · max daily loss {usd(p.maxDailyLoss)} · one position per
            window · entries pay the ask plus Kalshi&apos;s fee.
          </p>
        </Card>
        <Card>
          <div className="flex items-center justify-between gap-3">
            <h2>Exit policy</h2>
            <span className={`badge ${p.policy.placeholder ? "red" : ""}`}>
              {p.policy.placeholder
                ? "STOP-LOSS / RATCHET: PLACEHOLDER"
                : p.policy.name}
            </span>
          </div>
          <ul className="fine mt-4 space-y-1">
            {p.policy.rules.map((r) => (
              <li key={r}>• {r}</li>
            ))}
          </ul>
          <div className="rule" />
          <form
            className="grid grid-cols-3 gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void mutate("settings", {
                contracts: Number(f.get("contracts")),
                maxStake: Number(f.get("maxStake")),
                maxDailyLoss: Number(f.get("maxDailyLoss")),
                auto: f.get("auto") === "on",
              });
            }}
          >
            <label>
              Contracts
              <input
                type="number"
                name="contracts"
                min="1"
                step="1"
                defaultValue={p.contracts}
              />
            </label>
            <label>
              Max stake $
              <input
                type="number"
                name="maxStake"
                min="1"
                step="1"
                defaultValue={p.maxStake}
              />
            </label>
            <label>
              Max daily loss $
              <input
                type="number"
                name="maxDailyLoss"
                min="1"
                step="1"
                defaultValue={p.maxDailyLoss}
              />
            </label>
            <label className="!flex-row items-center col-span-3">
              <input type="checkbox" name="auto" defaultChecked={p.auto} />
              Auto-enter on a verdict (resets to manual on worker restart)
            </label>
            <Button
              variant="outline"
              className="col-span-3"
              disabled={busy || !!pos}
            >
              <ShieldCheck size={13} /> Save contract settings
            </Button>
          </form>
        </Card>
      </div>
      <Card>
        <h2>Contract results</h2>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mt-4">
          {[
            ["Trades", m.n],
            ["Hit rate", prob(m.hitRate)],
            [
              "P&L per contract",
              m.roiPerContract == null
                ? "—"
                : `${(m.roiPerContract * 100).toFixed(1)}¢`,
            ],
            ["Avg edge at entry", edgeText(m.edgeAtEntry)],
            ["Avg realized per contract", edgeText(m.realizedEdge)],
          ].map(([k, v]) => (
            <div key={String(k)}>
              <div className="eyebrow !text-[8px]">{k}</div>
              <div className="mono text-[17px] mt-2">{v}</div>
            </div>
          ))}
        </div>
        <div className="grid md:grid-cols-2 gap-4 mt-5">
          {[
            ["By engine", m.byEngine],
            ["By bucket", m.byBucket],
          ].map(([title, rows]) => (
            <div key={String(title)} className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{String(title)}</th>
                    <th>Trades</th>
                    <th>Hit rate</th>
                    <th>P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {(rows as typeof m.byEngine).map((r) => (
                    <tr key={r.name} className="mono">
                      <td>{r.name}</td>
                      <td>{r.n}</td>
                      <td>{prob(r.hitRate)}</td>
                      <td className={r.pnl >= 0 ? "green" : "pink"}>
                        {usd(r.pnl)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </Card>
      <Card className="!p-0">
        <div className="p-5 flex flex-wrap justify-between items-center gap-3">
          <h2>Contract journal</h2>
          <div className="flex gap-2">
            {[
              ["samples.csv", "Samples + outcomes"],
              ["trades.csv", "Trades"],
            ].map(([file, label]) => (
              <Button key={file} variant="outline" size="sm" asChild>
                <a href={`${worker}/api/contracts/${file}`}>
                  <Download size={12} /> {label} CSV
                </a>
              </Button>
            ))}
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Closed UTC</th>
                <th>Side</th>
                <th>Qty</th>
                <th>Entry</th>
                <th>Exit</th>
                <th>Fees</th>
                <th>P&L</th>
                <th>Engine</th>
                <th>Bucket</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {p.trades
                .slice()
                .reverse()
                .map((t) => (
                  <tr key={t.id} className="mono">
                    <td>{utc(t.closed)}</td>
                    <td>{t.side === "UP" ? "YES" : "NO"}</td>
                    <td>{t.contracts}</td>
                    <td>{cents(t.entry)}</td>
                    <td>{cents(t.exit)}</td>
                    <td>{usd(t.entryFee + t.exitFee)}</td>
                    <td className={t.pnl >= 0 ? "green" : "pink"}>
                      {usd(t.pnl)}
                    </td>
                    <td>{t.engine}</td>
                    <td>{t.bucket ?? "—"}</td>
                    <td>{t.reason}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="fine">
        Most windows show NO TRADE. That is expected: an engine must first be
        calibrated on enough completed windows in the current bucket
        (CALIBRATION_MIN_N, 200 by default, roughly two days of uptime), beat
        the base rate out of sample, and still show at least {cents(c.minEdge)}{" "}
        of edge after Kalshi&apos;s fee.
      </p>
    </div>
  );
}
