-- Service-only data plane. The browser reads public snapshots from the worker,
-- never the Supabase Data API. Paper accounts belong to a single worker instance.
create schema if not exists private;
revoke all on schema private from public;
do $$
declare table_name text;
begin
  foreach table_name in array array['market_aggregates','candle_history','forecast_events','forecast_outcomes','trading_signals','paper_positions','paper_trades','system_health'] loop
    execute format('create table if not exists public.%I (id text primary key, event_time timestamptz not null, mode text not null check (mode in (''live'',''replay'')), payload jsonb not null, inserted_at timestamptz not null default now())', table_name);
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on public.%I from anon, authenticated', table_name);
    execute format('grant select, insert, update, delete on public.%I to service_role', table_name);
    execute format('create index if not exists %I on public.%I (mode, event_time desc)', table_name || '_mode_time_idx', table_name);
    execute format('create index if not exists %I on public.%I (event_time)', table_name || '_retention_idx', table_name);
  end loop;
end $$;
-- Append-only forecast and signal records; worker upserts can only repeat identical records.
create or replace function private.protect_signal_record() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
 if new.payload is distinct from old.payload or new.event_time is distinct from old.event_time or new.mode is distinct from old.mode then
  raise exception 'Original signal and forecast records are immutable';
 end if;
 return new;
end $$;
create trigger immutable_forecast before update on public.forecast_events for each row execute function private.protect_signal_record();
create trigger immutable_signal before update on public.trading_signals for each row execute function private.protect_signal_record();
-- Explicitly invoked by an operator or scheduled pg_cron job. No SECURITY DEFINER.
create or replace function private.prune_terminal_history() returns void language plpgsql security invoker set search_path = '' as $$
begin
 delete from public.market_aggregates where event_time < now() - interval '30 days';
 delete from public.system_health where event_time < now() - interval '7 days';
 delete from public.candle_history where event_time < now() - interval '365 days';
 delete from public.forecast_outcomes where event_time < now() - interval '180 days';
 delete from public.forecast_events where event_time < now() - interval '180 days';
 delete from public.trading_signals where event_time < now() - interval '365 days';
 -- Paper journals are preserved until explicitly archived by their operator.
end $$;
revoke all on all functions in schema private from public;
