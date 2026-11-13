export type Mode = "live" | "replay";
export type Side = "buy" | "sell";
export type Direction = "UP" | "DOWN" | "FLAT";
export type Sample = { time: number; price: number };
export type Trade = Sample & {
  id: string;
  symbol: string;
  size: number;
  side: Side;
};
export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  delta: number;
  complete: boolean;
  partial?: boolean;
};
export type Projection = {
  price: number;
  velocity10: number;
  velocity30: number;
  acceleration: number;
  projected: number;
  move: number;
  percent: number;
  direction: Direction;
};
export type Forecast = {
  id: string;
  created: number;
  starting: number;
  projected: number;
  horizon: number;
  model: string;
  mode: Mode;
  freshness: number;
  features: Projection;
  regime: string;
};
export type Outcome = {
  id: string;
  evaluated: number;
  actual: number | null;
  realized: number | null;
  correct: boolean | null;
  absoluteError: number | null;
  percentageError: number | null;
  status: "COMPLETE" | "MISSED";
};
export type Signal = {
  id: string;
  time: number;
  mode: Mode;
  state: "LONG" | "SHORT" | "NEUTRAL" | "INSUFFICIENT DATA";
  score: number | null;
  coverage: number;
  features: Record<string, number | null>;
  reason: string;
  atr: number | null;
  reference?: number | null;
  ema9: number | null;
  ema20: number | null;
  supertrend: number | null;
  swingHigh: number | null;
  swingLow: number | null;
};
export type Pressure = {
  buy: number;
  sell: number;
  delta: number;
  cvd: number;
  buyPercent: number | null;
  trend: number | null;
  count: number;
  coverage: number;
};
export type BookMetrics = {
  bid: number;
  ask: number;
  spread: number;
  imbalance: number;
  age: number;
  depth: number;
};
export type Position = {
  id: string;
  direction: "LONG" | "SHORT";
  size: number;
  entry: number;
  reference: number;
  stop: number;
  target: number;
  opened: number;
  fee: number;
  mode: Mode;
  risk: number;
  signalId?: string;
};
export type PaperTrade = Position & {
  exit: number;
  closed: number;
  pnl: number;
  exitFee: number;
  reason: string;
  rr: number;
};
export type PaperState = {
  starting: number;
  balance: number;
  equity: number;
  feeBps: number;
  slippageBps: number;
  auto: boolean;
  position: Position | null;
  trades: PaperTrade[];
  curve: { time: number; equity: number }[];
  dailyPnl: number;
  maxDrawdown: number;
  peakEquity?: number;
};
export type Market = {
  symbol: string;
  price: number | null;
  change: number | null;
  age: number | null;
  source: string;
  fresh: boolean;
};
export type Snapshot = {
  time: number;
  mode: Mode;
  connection: string;
  persistence: string;
  persistenceError: string | null;
  price: number | null;
  projection: Projection | null;
  pressure20: Pressure;
  pressure60: Pressure;
  book: BookMetrics | null;
  signal: Signal;
  candles: Candle[];
  minutes: Candle[];
  forecasts: Forecast[];
  outcomes: Outcome[];
  signals: Signal[];
  markets: Market[];
  pulse: {
    state: string;
    rising: number;
    falling: number;
    coverage: number;
    points: { time: number; value: number }[];
  };
  confirmation: {
    coinbase: number | null;
    kraken: number | null;
    coinbaseAge: number | null;
    krakenAge: number | null;
    divergence: number | null;
    state: string;
  };
  health: Record<
    string,
    {
      status: string;
      lastMessage: number;
      reconnects: number;
      errors: string[];
      latency: number | null;
      gaps: number;
      outOfOrder: number;
    }
  >;
  wick: {
    score: number | null;
    label: string;
    candles: {
      time: number;
      score: number;
      upper: number;
      lower: number;
      weight: number;
    }[];
  };
  paper: PaperState;
  settings: {
    freshness: number;
    divergence: number;
    atrPeriod: number;
    multiplier: number;
    watchlist: string[];
  };
  nextClose: number;
  contract: ContractView;
};
export type ContractQuote = {
  ticker: string;
  event: string;
  series: string;
  open: number;
  close: number;
  strike: number | null;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  last: number | null;
  volume: number | null;
  time: number;
  received: number;
  source: "kalshi-rest" | "kalshi-ws" | "synthetic";
};
export type ContractSettlement = {
  id: string;
  window: number;
  ticker: string;
  result: "UP" | "DOWN";
  expirationValue: number | null;
  strike: number | null;
  settled: number;
  source: "kalshi" | "synthetic";
  proxyStrike?: number | null;
  proxySettle?: number | null;
};
export type ContractView = {
  status: string;
  synthetic: boolean;
  quote: ContractQuote | null;
  quoteAge: number | null;
  quoteFresh: boolean;
  window: number;
  close: number;
  ttc: number;
  bucket: string | null;
  buckets: string[];
  strike: number | null;
  strikeSource: "kalshi" | "proxy" | null;
  proxy: number | null;
  proxySource: string | null;
  distance: number | null;
  distancePercent: number | null;
  distanceAtr: number | null;
  settlements: ContractSettlement[];
  basis: {
    note: string;
    lastOpen: number | null;
    lastClose: number | null;
  };
};
