create extension if not exists "pgcrypto";

alter table if exists public.reminders
  add column if not exists status text not null default 'active',
  add column if not exists schedule_type text not null default 'once',
  add column if not exists next_run_at_utc timestamptz null,
  add column if not exists last_sent_at_utc timestamptz null,
  add column if not exists last_tick_id uuid null,
  add column if not exists send_attempt_count int not null default 0,
  add column if not exists last_error text null,
  add column if not exists locked_at timestamptz null,
  add column if not exists locked_by text null,
  add column if not exists retry_after_utc timestamptz null,
  add column if not exists timezone text null,
  add column if not exists interval_minutes int null,
  add column if not exists at_time text null,
  add column if not exists by_weekday int null,
  add column if not exists by_monthday int null,
  add column if not exists by_month int null;

update public.reminders
set next_run_at_utc = coalesce(next_run_at_utc, next_run_at)
where next_run_at_utc is null;

create index if not exists idx_reminders_due
  on public.reminders(next_run_at_utc, status);

create index if not exists idx_reminders_retry
  on public.reminders(retry_after_utc);

create index if not exists idx_reminders_user
  on public.reminders(user_id);

create table if not exists public.reminder_deliveries (
  id uuid primary key default gen_random_uuid(),
  reminder_id uuid not null references public.reminders(id) on delete cascade,
  tick_id uuid not null,
  sent_at_utc timestamptz not null default now(),
  delivery_key text not null,
  ok boolean not null,
  error text null
);

create unique index if not exists uniq_reminder_delivery_key
  on public.reminder_deliveries(reminder_id, delivery_key);

create table if not exists public.cron_runs (
  tick_id uuid primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  claimed int not null default 0,
  sent int not null default 0,
  failed int not null default 0,
  skipped int not null default 0,
  notes text null
);

create or replace function public.claim_due_reminders(
  batch_limit int,
  tick_id uuid,
  locked_by text,
  lock_timeout_seconds int
)
returns setof public.reminders
language plpgsql
as $$
begin
  return query
  with due as (
    select id
    from public.reminders
    where (
        status in ('active', 'failed')
        or (
          status = 'sending'
          and (locked_at is null or locked_at < now() - make_interval(secs => lock_timeout_seconds))
        )
      )
      and next_run_at_utc is not null
      and next_run_at_utc <= now()
      and (retry_after_utc is null or retry_after_utc <= now())
      and deleted_at is null
    order by next_run_at_utc asc
    limit batch_limit
    for update skip locked
  )
  update public.reminders r
  set status = 'sending',
      locked_at = now(),
      locked_by = claim_due_reminders.locked_by,
      last_tick_id = claim_due_reminders.tick_id
  from due
  where r.id = due.id
  returning r.*;
end;
$$;
