import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { it, expect } from "vitest";
it("applies the PostgreSQL migration, denies browser roles, preserves original forecasts and prunes aggregates", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "create role anon; create role authenticated; create role service_role;",
    );
    await db.exec(
      await readFile(
        "supabase/migrations/20261113092438_pulseterminal.sql",
        "utf8",
      ),
    );
    const tables = await db.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r'",
    );
    expect(tables.rows).toHaveLength(8);
    expect(tables.rows.every((x) => x.relrowsecurity)).toBe(true);
    await db.exec(
      "insert into public.forecast_events(id,event_time,mode,payload) values ('test', now(), 'live', '{\"starting\":100}')",
    );
    await expect(
      db.exec("update public.forecast_events set payload='{}' where id='test'"),
    ).rejects.toThrow("immutable");
    await db.exec("set role anon");
    await expect(
      db.query("select * from public.forecast_events"),
    ).rejects.toThrow("permission denied");
    await db.exec("reset role");
    await db.exec(
      "insert into public.market_aggregates values ('old', now()-interval '40 days', 'live', '{}', now())",
    );
    await db.exec("select private.prune_terminal_history()");
    expect(
      (await db.query("select * from public.market_aggregates")).rows,
    ).toHaveLength(0);
  } finally {
    await db.close();
  }
});
