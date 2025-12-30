create extension if not exists "pgcrypto";

create table if not exists public.xp_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  delta int not null,
  reason text not null,
  ref_type text,
  ref_id uuid,
  created_at_utc timestamptz not null default now()
);

create index if not exists idx_xp_ledger_user_time on public.xp_ledger (user_id, created_at_utc);
