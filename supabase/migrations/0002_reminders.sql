create extension if not exists "pgcrypto";

-- 1) Ensure table exists with a basic structure.
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

-- 2) Ensure the "enabled" column exists on any existing DB.
do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'reminders'
      and column_name = 'enabled'
  ) then
    alter table public.reminders
      add column enabled boolean not null default true;
  end if;
end
$$;

-- 3) Create indexes, but only if the column exists.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'reminders'
      and column_name = 'next_run_at_utc'
  ) then
    create index if not exists idx_reminders_user_next_run
      on public.reminders(user_id, next_run_at_utc);
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'reminders'
      and column_name = 'enabled'
  ) then
    create index if not exists idx_reminders_next_run_enabled
      on public.reminders(next_run_at_utc, enabled);
  end if;
end
$$;
