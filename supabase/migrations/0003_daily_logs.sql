create extension if not exists "pgcrypto";

create table if not exists public.daily_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  log_date date not null,
  summary text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_daily_logs_user_date unique (user_id, log_date)
);

create index if not exists idx_daily_logs_user_date
  on public.daily_logs(user_id, log_date desc);
