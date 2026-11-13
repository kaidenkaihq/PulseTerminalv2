-- PulseTerminal v2 contract layer. Same envelope, deny-by-default RLS and service-only access
-- as 20261113092438_pulseterminal.sql. Kalshi access is read-only market data.
do $$
declare table_name text;
begin
  foreach table_name in array array['kalshi_quotes','contract_snapshots','contract_outcomes','contract_settlements','contract_paper_positions','contract_paper_trades'] loop
    execute format('create table if not exists public.%I (id text primary key, event_time timestamptz not null, mode text not null check (mode in (''live'',''replay'')), payload jsonb not null, inserted_at timestamptz not null default now())', table_name);
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on public.%I from anon, authenticated', table_name);
    execute format('grant select, insert, update, delete on public.%I to service_role', table_name);
    execute format('create index if not exists %I on public.%I (mode, event_time desc)', table_name || '_mode_time_idx', table_name);
    execute format('create index if not exists %I on public.%I (event_time)', table_name || '_retention_idx', table_name);
  end loop;
end $$;
-- Snapshots, outcomes and official settlements are original records: identical re-upserts only.
create trigger immutable_contract_snapshot before update on public.contract_snapshots for each row execute function private.protect_signal_record();
create trigger immutable_contract_outcome before update on public.contract_outcomes for each row execute function private.protect_signal_record();
create trigger immutable_contract_settlement before update on public.contract_settlements for each row execute function private.protect_signal_record();
-- Explicitly invoked by an operator or scheduled pg_cron job. No SECURITY DEFINER.
create or replace function private.prune_contract_history() returns void language plpgsql security invoker set search_path = '' as $$
begin
 delete from public.kalshi_quotes where event_time < now() - interval '30 days';
 delete from public.contract_snapshots where event_time < now() - interval '365 days';
 -- Outcomes, settlements and contract paper journals are preserved until archived by their operator.
end $$;
revoke all on all functions in schema private from public;
