import { z } from "zod";
import { boundary } from "./math";
import type { ContractQuote } from "./types";
// Kalshi KXBTC15M facts are documented with sources in docs/V2_PLAN.md and docs/METHODOLOGY.md.
export const WINDOW_MS = 900000;
export const windowStart = (time: number) => boundary(time, 900);
export const secondsToClose = (now: number, close: number) =>
  Math.max(0, Math.ceil((close - now) / 1000));
// Kalshi quadratic fee: ceil(rate × multiplier × C × P × (1 − P)) to the member's balance precision.
export function kalshiFee(
  contracts: number,
  price: number,
  rate = 0.07,
  multiplier = 1,
  precision = 0.01,
) {
  if (contracts <= 0 || price <= 0 || price >= 1) return 0;
  const raw = rate * multiplier * contracts * price * (1 - price);
  return Math.round(Math.ceil(raw / precision - 1e-7) * precision * 1e6) / 1e6;
}
// Resolution: YES (UP) iff settle ≥ strike, both 60s BRTI averages rounded to 2 dp. Ties are UP.
export const round2 = (v: number) => Math.round(v * 100) / 100;
export const resolve = (settle: number, strike: number): "UP" | "DOWN" =>
  round2(settle) >= round2(strike) ? "UP" : "DOWN";
export const mean = (v: number[]) =>
  v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
export function bucketOf(ttc: number, edges: number[]) {
  for (let i = 0; i < edges.length - 1; i++)
    if (ttc <= edges[i] && ttc > edges[i + 1]) return bucketLabel(edges, i);
  return null;
}
export const bucketLabel = (edges: number[], i: number) =>
  `${fmtMin(edges[i])}–${fmtMin(edges[i + 1])}m`;
const fmtMin = (s: number) => (s % 60 ? (s / 60).toFixed(1) : String(s / 60));
export const bucketLabels = (edges: number[]) =>
  edges.slice(0, -1).map((_, i) => bucketLabel(edges, i));
// Display only: tickers embed US Eastern close time; logic never parses them.
export const easternLabel = (time: number) =>
  new Date(time).toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
const dollars = z.coerce.number().min(0).max(1);
const maybe = <T extends z.ZodTypeAny>(s: T) =>
  z.preprocess((v) => (v === "" || v === undefined ? null : v), s.nullable());
export const restMarket = z.object({
  ticker: z.string(),
  event_ticker: z.string(),
  open_time: z.string().datetime({ offset: true }),
  close_time: z.string().datetime({ offset: true }),
  status: z.string(),
  floor_strike: maybe(z.coerce.number().positive()),
  yes_bid_dollars: maybe(dollars),
  yes_ask_dollars: maybe(dollars),
  no_bid_dollars: maybe(dollars),
  no_ask_dollars: maybe(dollars),
  last_price_dollars: maybe(dollars),
  volume_fp: maybe(z.coerce.number().min(0)),
  result: z.string().optional(),
  expiration_value: maybe(z.coerce.number().positive()),
});
export type RestMarket = z.infer<typeof restMarket>;
export function quoteFromMarket(
  m: RestMarket,
  series: string,
  received: number,
  source: ContractQuote["source"],
): ContractQuote {
  return {
    ticker: m.ticker,
    event: m.event_ticker,
    series,
    open: Date.parse(m.open_time),
    close: Date.parse(m.close_time),
    strike: m.floor_strike,
    yesBid: m.yes_bid_dollars,
    yesAsk: m.yes_ask_dollars,
    noBid: m.no_bid_dollars,
    noAsk: m.no_ask_dollars,
    last: m.last_price_dollars,
    volume: m.volume_fp,
    time: received,
    received,
    source,
  };
}
export const wsTicker = z.object({
  type: z.literal("ticker"),
  msg: z.object({
    market_ticker: z.string(),
    price_dollars: maybe(dollars),
    yes_bid_dollars: maybe(dollars),
    yes_ask_dollars: maybe(dollars),
    volume_fp: maybe(z.coerce.number().min(0)),
    ts_ms: z.number().int().positive().optional(),
  }),
});
// The ticker channel carries only YES top of book. NO bid = 1 − YES ask; NO ask = 1 − YES bid.
export function applyTicker(
  q: ContractQuote,
  raw: unknown,
  received: number,
): ContractQuote | null {
  const t = wsTicker.parse(raw).msg;
  if (t.market_ticker !== q.ticker) return null;
  const yesBid = t.yes_bid_dollars ?? q.yesBid,
    yesAsk = t.yes_ask_dollars ?? q.yesAsk;
  return {
    ...q,
    yesBid,
    yesAsk,
    noBid: yesAsk == null ? null : round4(1 - yesAsk),
    noAsk: yesBid == null ? null : round4(1 - yesBid),
    last: t.price_dollars ?? q.last,
    volume: t.volume_fp ?? q.volume,
    time: t.ts_ms ?? received,
    received,
    source: "kalshi-ws",
  };
}
const round4 = (v: number) => Math.round(v * 10000) / 10000;
