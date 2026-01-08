create extension if not exists "pgcrypto";

-- 1) Create table if it does not exist (fresh DB case)
create table if not exists public.reminders (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    title text not null,
    detail text,
    next_run_at_utc timestamptz,
    last_sent_at_utc timestamptz,
    enabled boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- 2) Patch existing DBs where reminders table exists without "enabled"
alter table public.reminders
    add column if not exists enabled boolean not null default true;

-- 3) Indexes
create index if not exists idx_reminders_user_next_run
    on public.reminders(user_id, next_run_at_utc);

create index if not exists idx_reminders_next_run_enabled
    on public.reminders(next_run_at_utc, enabled);
