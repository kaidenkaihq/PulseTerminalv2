import { z } from "zod";
// Every contract-layer threshold is validated here and recorded with each snapshot it affects.
const list = (pattern: RegExp) => z.string().regex(pattern).optional();
export const contractSchema = z.object({
  KALSHI_ENABLED: z.enum(["true", "false"]).optional(),
  KALSHI_API_KEY_ID: z.string().optional(),
  KALSHI_PRIVATE_KEY_PATH: z.string().optional(),
  KALSHI_SERIES: z
    .string()
    .regex(/^[A-Z0-9]+$/)
    .optional(),
  KALSHI_REST_URL: z.string().url().optional(),
  KALSHI_WS_URL: z.string().url().optional(),
  KALSHI_FRESHNESS_MS: z.coerce.number().int().min(1000).max(60000).optional(),
  KALSHI_FEE_RATE: z.coerce.number().min(0).max(1).optional(),
  KALSHI_FEE_PRECISION: z.coerce.number().min(0.000001).max(0.01).optional(),
  CONTRACT_BUCKETS: list(/^\d+(,\d+)+$/),
  FADE_SIGMA: z.coerce.number().min(0.5).max(10).optional(),
  FADE_WINDOW_S: z.coerce.number().int().min(5).max(300).optional(),
  FADE_EXHAUSTION: z.coerce.number().min(0.01).max(1).optional(),
  FADE_TTC_MIN: z.coerce.number().int().min(0).max(900).optional(),
  FADE_TTC_MAX: z.coerce.number().int().min(0).max(900).optional(),
  FADE_LOOKBACK_MIN: z.coerce.number().int().min(5).max(20).optional(),
  CALIBRATION_MIN_N: z.coerce.number().int().min(10).max(100000).optional(),
  CALIBRATION_REFIT_EVERY: z.coerce.number().int().min(1).max(96).optional(),
  CALIBRATION_RECENT_N: z.coerce.number().int().min(10).max(100000).optional(),
  MIN_EDGE: z.coerce.number().min(0).max(0.5).optional(),
  CONTRACT_BALANCE: z.coerce.number().min(10).max(1e7).optional(),
  CONTRACT_SIZE: z.coerce.number().int().min(1).max(10000).optional(),
  CONTRACT_MAX_STAKE: z.coerce.number().min(1).max(1e6).optional(),
  CONTRACT_MAX_DAILY_LOSS: z.coerce.number().min(1).max(1e6).optional(),
  CONTRACT_EXIT_PHASES: z
    .string()
    .regex(/^(\d+:0?\.\d+(,\d+:0?\.\d+)*)?$/)
    .optional(),
  CONTRACT_RATCHET: z
    .string()
    .regex(/^(0?\.\d+:0?\.\d+(,0?\.\d+:0?\.\d+)*)?$/)
    .optional(),
  CONTRACT_TICK_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .optional(),
});
const pairs = (value: string | undefined) =>
  (value || "")
    .split(",")
    .filter(Boolean)
    .map((x) => x.split(":").map(Number) as [number, number]);
export type ContractConfig = ReturnType<typeof contractConfig>;
export function contractConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const e = contractSchema.parse(env);
  const buckets = (e.CONTRACT_BUCKETS || "900,600,300,120,0")
    .split(",")
    .map(Number);
  if (buckets.some((b, i) => i && b >= buckets[i - 1]) || buckets[0] > 900)
    throw Error(
      "CONTRACT_BUCKETS must be strictly decreasing seconds-to-close ≤ 900",
    );
  const fade = {
    sigma: e.FADE_SIGMA ?? 2.5,
    windowS: e.FADE_WINDOW_S ?? 30,
    exhaustion: e.FADE_EXHAUSTION ?? 0.25,
    ttcMin: e.FADE_TTC_MIN ?? 30,
    ttcMax: e.FADE_TTC_MAX ?? 600,
    lookbackMin: e.FADE_LOOKBACK_MIN ?? 15,
  };
  if (fade.ttcMin >= fade.ttcMax)
    throw Error("FADE_TTC_MIN must be below FADE_TTC_MAX");
  return {
    kalshi: {
      enabled: e.KALSHI_ENABLED !== "false",
      keyId: e.KALSHI_API_KEY_ID || null,
      keyPath: e.KALSHI_PRIVATE_KEY_PATH || null,
      series: e.KALSHI_SERIES || "KXBTC15M",
      rest:
        e.KALSHI_REST_URL || "https://api.elections.kalshi.com/trade-api/v2",
      ws: e.KALSHI_WS_URL || "wss://external-api-ws.kalshi.com/trade-api/ws/v2",
      freshness: e.KALSHI_FRESHNESS_MS ?? 5000,
      feeRate: e.KALSHI_FEE_RATE ?? 0.07,
      feePrecision: e.KALSHI_FEE_PRECISION ?? 0.01,
    },
    buckets,
    fade,
    calibration: {
      minN: e.CALIBRATION_MIN_N ?? 200,
      refitEvery: e.CALIBRATION_REFIT_EVERY ?? 4,
      recentN: e.CALIBRATION_RECENT_N ?? 100,
    },
    minEdge: e.MIN_EDGE ?? 0.03,
    paper: {
      balance: e.CONTRACT_BALANCE ?? 1000,
      contracts: e.CONTRACT_SIZE ?? 10,
      maxStake: e.CONTRACT_MAX_STAKE ?? 50,
      maxDailyLoss: e.CONTRACT_MAX_DAILY_LOSS ?? 100,
      // Owner-supplied stop-loss phases and ratchet levels. Empty until the owner provides them.
      phases: pairs(e.CONTRACT_EXIT_PHASES),
      ratchet: pairs(e.CONTRACT_RATCHET),
    },
    tickRetentionDays: e.CONTRACT_TICK_RETENTION_DAYS ?? 30,
  };
}
