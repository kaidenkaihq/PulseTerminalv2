"use client";
import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle, Signal } from "@/lib/types";
import { ema, heikinAshi, supertrend } from "@/lib/math";
export function MarketChart({
  candles,
  signals,
  ha,
  overlay,
  atrPeriod,
  multiplier,
}: {
  candles: Candle[];
  signals: Signal[];
  ha: boolean;
  overlay: boolean;
  atrPeriod: number;
  multiplier: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const ref = useRef<ReturnType<typeof makeChart> | null>(null);
  function makeChart(el: HTMLDivElement) {
    const chart = createChart(el, {
      height: 360,
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#0b1019" },
        textColor: "#79879d",
        fontFamily: "monospace",
        fontSize: 10,
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: "#ffffff04" },
        horzLines: { color: "#ffffff07" },
      },
      rightPriceScale: { borderColor: "#ffffff0b" },
      timeScale: { borderColor: "#ffffff0b", timeVisible: true },
      crosshair: {
        vertLine: { color: "#59697d" },
        horzLine: { color: "#59697d" },
      },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#30dfa1",
      downColor: "#f05a87",
      borderVisible: false,
      wickUpColor: "#30dfa1",
      wickDownColor: "#f05a87",
    });
    const e9 = chart.addSeries(LineSeries, {
        color: "#45b9cf",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      }),
      e20 = chart.addSeries(LineSeries, {
        color: "#b09aff",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      }),
      st = chart.addSeries(LineSeries, {
        color: "#f8c66c",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
    const delta = chart.addSeries(HistogramSeries, {
      priceScaleId: "delta",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart
      .priceScale("delta")
      .applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    chart
      .priceScale("right")
      .applyOptions({ scaleMargins: { top: 0.08, bottom: 0.2 } });
    const markers = createSeriesMarkers(series, []);
    return { chart, series, e9, e20, st, delta, markers, fitted: false };
  }
  useEffect(() => {
    if (!host.current) return;
    ref.current = makeChart(host.current);
    return () => {
      ref.current?.chart.remove();
      ref.current = null;
    };
  }, []);
  useEffect(() => {
    const r = ref.current;
    if (!r) return;
    const data = ha ? heikinAshi(candles) : candles;
    r.series.setData(
      data.map((c) => ({ ...c, time: (c.time / 1000) as UTCTimestamp })),
    );
    const prices = candles.map((c) => c.close);
    for (const [line, period] of [
      [r.e9, 9],
      [r.e20, 20],
    ] as const) {
      const values = ema(prices, period);
      line.setData(
        overlay
          ? candles
              .filter((_, i) => i >= period - 1)
              .map((c, i) => ({
                time: (c.time / 1000) as UTCTimestamp,
                value: values[i + period - 1],
              }))
          : [],
      );
    }
    r.st.setData(
      overlay
        ? candles.flatMap((c, i) => {
            const s = supertrend(
              candles.slice(0, i + 1),
              atrPeriod,
              multiplier,
            );
            return s
              ? [{ time: (c.time / 1000) as UTCTimestamp, value: s.value }]
              : [];
          })
        : [],
    );
    r.delta.setData(
      candles.map((c) => ({
        time: (c.time / 1000) as UTCTimestamp,
        value: c.delta,
        color: c.delta >= 0 ? "#26d69a35" : "#f05a8735",
      })),
    );
    const seen = new Set<number>();
    r.markers.setMarkers(
      signals
        .filter((s) => s.state === "LONG" || s.state === "SHORT")
        .flatMap((s) => {
          const time = Math.floor(s.time / 900000) * 900;
          if (seen.has(time) || !candles.some((c) => c.time / 1000 === time))
            return [];
          seen.add(time);
          return [
            {
              time: time as UTCTimestamp,
              position:
                s.state === "LONG"
                  ? ("belowBar" as const)
                  : ("aboveBar" as const),
              color: s.state === "LONG" ? "#30dfa1" : "#f05a87",
              shape:
                s.state === "LONG"
                  ? ("arrowUp" as const)
                  : ("arrowDown" as const),
              text: s.state,
            },
          ];
        })
        .sort((a, b) => a.time - b.time),
    );
    if (!r.fitted && candles.length) {
      r.chart.timeScale().fitContent();
      r.fitted = true;
    }
  }, [candles, signals, ha, overlay, atrPeriod, multiplier]);
  return (
    <div
      ref={host}
      className="w-full h-[360px]"
      aria-label="Interactive BTC 15-minute candlestick chart"
    />
  );
}
