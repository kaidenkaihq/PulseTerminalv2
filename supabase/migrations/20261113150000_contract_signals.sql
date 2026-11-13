-- First appearance of each directional contract signal per window and source. Same envelope,
-- deny-by-default RLS and service-only access as the earlier migrations; rows are immutable.
create table if not exists public.contract_signals (id text primary key, event_time timestamptz not null, mode text not null check (mode in ('live','replay')), payload jsonb not null, inserted_at timestamptz not null default now());
alter table public.contract_signals enable row level security;
revoke all on public.contract_signals from anon, authenticated;
grant select, insert, update, delete on public.contract_signals to service_role;
create index if not exists contract_signals_mode_time_idx on public.contract_signals (mode, event_time desc);
create index if not exists contract_signals_retention_idx on public.contract_signals (event_time);
create trigger immutable_contract_signal before update on public.contract_signals for each row execute function private.protect_signal_record();
