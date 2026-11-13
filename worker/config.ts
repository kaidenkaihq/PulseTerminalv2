import { z } from "zod";
export function validateConfiguration() {
  z.object({
    DATA_MODE: z.enum(["live", "replay"]).optional(),
    WORKER_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    FRESHNESS_MS: z.coerce.number().int().min(1000).max(30000).optional(),
    DIVERGENCE_PERCENT: z.coerce.number().min(0.001).max(5).optional(),
    ATR_PERIOD: z.coerce.number().int().min(2).max(100).optional(),
    SUPER_TREND_MULTIPLIER: z.coerce.number().min(0.5).max(10).optional(),
    PAPER_BALANCE: z.coerce.number().min(10).max(1e9).optional(),
    WATCHLIST: z
      .string()
      .regex(/^[A-Z0-9]+-USD(,[A-Z0-9]+-USD)*$/)
      .optional(),
  }).parse(process.env);
}
