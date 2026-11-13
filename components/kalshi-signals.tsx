"use client";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { cents, prob } from "./kalshi-strip";
import type { ContractSignal } from "@/lib/types";
type Row = ContractSignal & {
  result: "UP" | "DOWN" | null;
  resultSource: "official" | "proxy" | "missed" | "pending";
  correct: boolean | null;
};
type Page = { page: number; pages: number; total: number; rows: Row[] };
const stamp = (v: number) =>
  `${new Date(v).toISOString().slice(0, 10)} ${new Date(v).toLocaleTimeString("en-GB", { timeZone: "UTC" })}`;
const windowLabel = (v: number) =>
  `${new Date(v).toLocaleTimeString("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit" })}–${new Date(v + 900000).toLocaleTimeString("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit" })}`;
const clock = (s: number) =>
  `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
// First appearance of each signal per window and source; the worker never records a repeat.
export function SignalHistory({
  worker,
  count,
}: {
  worker: string;
  count: number;
}) {
  const [page, setPage] = useState(1),
    [data, setData] = useState<Page | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    fetch(`${worker}/api/contracts/signals?page=${page}&size=10`)
      .then((r) =>
        r.ok ? r.json() : Promise.reject(Error(`HTTP ${r.status}`)),
      )
      .then((d: Page) => {
        if (!cancelled) {
          setData(d);
          setError("");
        }
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
    // `count` changes when a new first signal is recorded, so the current page refreshes.
  }, [worker, page, count]);
  const pages = data?.pages ?? 1;
  return (
    <Card className="!p-0">
      <div className="p-5 flex flex-wrap justify-between items-center gap-3">
        <div>
          <h2>Signal history</h2>
          <p className="fine mt-1">
            When each signal first appeared in a window. One row per window per
            source; later seconds are not repeated. Times are UTC.
          </p>
        </div>
        <span className="badge dim">{data?.total ?? count} first signals</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>First seen</th>
              <th>Window</th>
              <th>Left</th>
              <th>Source</th>
              <th>Signal</th>
              <th>Raw score</th>
              <th>Model P</th>
              <th>Market price</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((r) => (
              <tr key={r.id} className="mono">
                <td>{stamp(r.time)}</td>
                <td>{windowLabel(r.window)}</td>
                <td>{clock(r.ttc)}</td>
                <td>{r.label}</td>
                <td className={r.direction === "UP" ? "green" : "pink"}>
                  {r.direction}
                </td>
                <td>{r.score == null ? "—" : r.score.toFixed(2)}</td>
                <td
                  title={
                    r.calibrated ? "calibrated probability" : "uncalibrated"
                  }
                >
                  {r.p == null
                    ? "—"
                    : `${prob(r.p)}${r.calibrated ? "" : " (uncal.)"}`}
                </td>
                <td>{cents(r.marketP)}</td>
                <td
                  className={
                    r.correct == null ? "muted" : r.correct ? "green" : "pink"
                  }
                >
                  {r.result
                    ? `${r.result} ${r.correct ? "✓" : "✗"}${r.resultSource === "proxy" ? " (proxy)" : ""}`
                    : r.resultSource}
                </td>
              </tr>
            ))}
            {data && !data.rows.length && (
              <tr>
                <td colSpan={9} className="muted">
                  No signals yet. The first UP/DOWN reading in each window will
                  appear here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="p-4 flex items-center justify-between gap-3">
        <span className="fine">
          {error
            ? `Could not load history: ${error}`
            : `Page ${data?.page ?? page} of ${pages}`}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            aria-label="Newer signals"
          >
            <ChevronLeft size={12} /> Newer
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pages}
            onClick={() => setPage((p) => Math.min(pages, p + 1))}
            aria-label="Older signals"
          >
            Older <ChevronRight size={12} />
          </Button>
        </div>
      </div>
    </Card>
  );
}
