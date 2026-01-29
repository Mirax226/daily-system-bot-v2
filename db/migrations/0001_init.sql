-- Source: supabase/migrations/0001_users.sql
create extension if not exists "pgcrypto";

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  telegram_id text unique not null,
  username text,
  timezone text not null default 'Asia/Tehran',
  home_chat_id text,
  home_message_id text,
  settings_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_users_telegram_id on public.users(telegram_id);

-- Source: supabase/migrations/0002_reminders.sql
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

-- Source: supabase/migrations/0003_daily_logs.sql
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

-- Source: supabase/migrations/0003_daily_reports.sql
create extension if not exists "pgcrypto";

create table if not exists public.daily_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,

  report_date date not null,              -- Excel: تاریخ (میلادی)
  wake_time time,                         -- Excel: زمان بیداری

  routine_morning boolean,                -- روتین صبح
  routine_school boolean,                 -- روتین مدرسه
  routine_taxi boolean,                   -- روتین تاکسی
  routine_evening boolean,                -- روتین عصر
  routine_night boolean,                  -- روتین شب

  review_today_hours numeric,             -- مرور دروس امروز
  preview_tomorrow_hours numeric,         -- پیش خوانی دروس فردا
  homework_done boolean,                  -- تکالیف

  workout_morning boolean,                -- ورزش صبح
  workout_evening boolean,                -- ورزش شب

  pomodoro_3_count int,                   -- چند 3 پارتی؟
  pomodoro_2_count int,                   -- چند 2 پارتی؟
  pomodoro_1_count int,                   -- چند 1 پارتی؟

  library_study_hours numeric,            -- میزان مطالعه در کتابخانه شهر - چند ساعت؟

  exam_school_questions int,              -- آزمون - مدرسه
  exam_maz_questions int,                 -- آزمون - ماز
  exam_hesaban_questions int,             -- آزمون - حسابان
  exam_physics_questions int,             -- آزمون - فیزیک
  exam_chemistry_questions int,           -- آزمون - شیمی
  exam_geology_questions int,             -- آزمون - زمین شناسی
  exam_language_questions int,            -- آزمون - زبان
  exam_religion_questions int,            -- آزمون - دینی
  exam_arabic_questions int,              -- آزمون - عربی
  exam_persian_questions int,             -- آزمون - فارسی

  read_book_minutes int,                  -- مطالعه کتاب (دقیقه)
  read_article_minutes int,               -- مطالعه مقاله (دقیقه)
  watch_video_minutes int,                -- تماشای ویدیو (دقیقه)
  course_minutes int,                     -- دوره آموزشی (دقیقه)
  english_conversation_minutes int,       -- English - تمرین مکالمه (دقیقه)
  skill_learning_minutes int,             -- یادگیری مهارت (دقیقه)
  telegram_bot_minutes int,               -- ربات تلگرام (دقیقه)
  trading_strategy_minutes int,           -- استراتژی ترید (دقیقه)

  tidy_study_area boolean,                -- سازماندهی / محیط - مرتب سازی محیط مطالعه
  clean_room boolean,                     -- سازماندهی / محیط - جارو و گرد گیری اتاق
  plan_tomorrow boolean,                  -- سازماندهی / محیط - برنامه ریزی دقیق برای فردا

  family_time_minutes int,                -- خانواده - زمان سپری شده (دقیقه)

  sleep_time time,                        -- زمان - ساعت خواب
  notes text,                             -- توضیحات

  time_planned_study_minutes int,         -- زمان تحت برنامه - مطالعه (دقیقه)
  time_planned_skills_minutes int,        -- زمان تحت برنامه - مهارت ها (دقیقه)
  time_planned_misc_minutes int,          -- زمان تحت برنامه - متفرقه (دقیقه)

  streak_done boolean,                    -- Streak - Done
  streak_days int,                        -- Streak - Days

  xp_s int,                               -- XP - XP S
  xp_study int,                           -- XP - XPدرسی
  xp_misc int,                            -- XP - XP متفرقه
  xp_total int,                           -- XP - XP کل روز

  status text,                            -- وضعیت تکمیل/مرور

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_daily_reports_user_date
  on public.daily_reports(user_id, report_date);

create index if not exists idx_daily_reports_user_date
  on public.daily_reports(user_id, report_date desc);

-- Source: supabase/migrations/0003_rewards.sql
create extension if not exists "pgcrypto";

create table if not exists public.rewards (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  cost_xp int not null,
  enabled boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.reward_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  reward_id uuid not null references public.rewards(id) on delete restrict,
  title_snapshot text not null,
  cost_xp_snapshot int not null,
  purchased_at_utc timestamptz not null default now()
);

alter table public.rewards add column if not exists enabled boolean not null default true;
alter table public.rewards add column if not exists sort_order int not null default 0;

create index if not exists idx_rewards_enabled_sort on public.rewards (enabled, sort_order);
create index if not exists idx_reward_purchases_user_time on public.reward_purchases (user_id, purchased_at_utc);

-- Source: supabase/migrations/0004_daily_reports_hours_to_numeric.sql
-- 0004_daily_reports_hours_to_numeric.sql

alter table public.daily_reports
  alter column review_today_hours type numeric(5,2) using review_today_hours::numeric,
  alter column preview_tomorrow_hours type numeric(5,2) using preview_tomorrow_hours::numeric,
  alter column library_study_hours type numeric(5,2) using library_study_hours::numeric;

-- Source: supabase/migrations/0004_daily_reports_patch.sql
create extension if not exists "pgcrypto";

create table if not exists public.daily_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  report_date date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_daily_reports_user_date unique (user_id, report_date)
);

-- core fields
alter table public.daily_reports
  add column if not exists wake_time time;

alter table public.daily_reports
  add column if not exists routine_morning boolean;
alter table public.daily_reports
  add column if not exists routine_school boolean;
alter table public.daily_reports
  add column if not exists routine_taxi boolean;
alter table public.daily_reports
  add column if not exists routine_evening boolean;
alter table public.daily_reports
  add column if not exists routine_night boolean;

alter table public.daily_reports
  add column if not exists review_today_hours integer;
alter table public.daily_reports
  add column if not exists preview_tomorrow_hours integer;
alter table public.daily_reports
  add column if not exists homework_done boolean;

alter table public.daily_reports
  add column if not exists workout_morning boolean;
alter table public.daily_reports
  add column if not exists workout_evening boolean;

alter table public.daily_reports
  add column if not exists pomodoro_3_count integer;
alter table public.daily_reports
  add column if not exists pomodoro_2_count integer;
alter table public.daily_reports
  add column if not exists pomodoro_1_count integer;

alter table public.daily_reports
  add column if not exists library_study_hours integer;

-- exams
alter table public.daily_reports
  add column if not exists exam_school_questions integer;
alter table public.daily_reports
  add column if not exists exam_maz_questions integer;
alter table public.daily_reports
  add column if not exists exam_hesaban_questions integer;
alter table public.daily_reports
  add column if not exists exam_physics_questions integer;
alter table public.daily_reports
  add column if not exists exam_chemistry_questions integer;
alter table public.daily_reports
  add column if not exists exam_geology_questions integer;
alter table public.daily_reports
  add column if not exists exam_language_questions integer;
alter table public.daily_reports
  add column if not exists exam_religion_questions integer;
alter table public.daily_reports
  add column if not exists exam_arabic_questions integer;
alter table public.daily_reports
  add column if not exists exam_persian_questions integer;

-- non-school learning
alter table public.daily_reports
  add column if not exists read_book_minutes integer;
alter table public.daily_reports
  add column if not exists read_article_minutes integer;
alter table public.daily_reports
  add column if not exists watch_video_minutes integer;
alter table public.daily_reports
  add column if not exists course_minutes integer;

-- english & skills
alter table public.daily_reports
  add column if not exists english_conversation_minutes integer;
alter table public.daily_reports
  add column if not exists skill_learning_minutes integer;
alter table public.daily_reports
  add column if not exists telegram_bot_minutes integer;
alter table public.daily_reports
  add column if not exists trading_strategy_minutes integer;

-- home / planning / family
alter table public.daily_reports
  add column if not exists tidy_study_area boolean;
alter table public.daily_reports
  add column if not exists clean_room boolean;
alter table public.daily_reports
  add column if not exists plan_tomorrow boolean;
alter table public.daily_reports
  add column if not exists family_time_minutes integer;

-- auto-computed summary fields (placeholders)
alter table public.daily_reports
  add column if not exists time_planned_study_minutes integer;
alter table public.daily_reports
  add column if not exists time_planned_skills_minutes integer;
alter table public.daily_reports
  add column if not exists time_planned_misc_minutes integer;

alter table public.daily_reports
  add column if not exists streak_done boolean;
alter table public.daily_reports
  add column if not exists streak_days integer;

alter table public.daily_reports
  add column if not exists xp_s integer;
alter table public.daily_reports
  add column if not exists xp_study integer;
alter table public.daily_reports
  add column if not exists xp_misc integer;
alter table public.daily_reports
  add column if not exists xp_total integer;

alter table public.daily_reports
  add column if not exists sleep_time time;
alter table public.daily_reports
  alter column review_today_hours type numeric(5,2) using review_today_hours::numeric,
  alter column preview_tomorrow_hours type numeric(5,2) using preview_tomorrow_hours::numeric,
  alter column library_study_hours type numeric(5,2) using library_study_hours::numeric;

alter table public.daily_reports
  add column if not exists notes text;
alter table public.daily_reports
  add column if not exists status text;
-- 0004_xp_ledger.sql
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

create index if not exists idx_xp_ledger_user_time
  on public.xp_ledger(user_id, created_at_utc);

-- برای idempotency روی ref ها (اختیاری ولی بسیار مفید)
create unique index if not exists ux_xp_ledger_ref
  on public.xp_ledger(user_id, ref_type, ref_id)
  where ref_type is not null and ref_id is not null;

-- Source: supabase/migrations/0004_xp_ledger.sql
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

-- Source: supabase/migrations/0005_daily_reports_add_status.sql
alter table if exists public.daily_reports
  add column if not exists status text;

-- Source: supabase/migrations/0005_settings_templates.sql
create extension if not exists "pgcrypto";

create table if not exists public.user_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  settings_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id)
);

create table if not exists public.report_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.report_items (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.report_templates(id) on delete cascade,
  label text not null,
  item_key text not null,
  item_type text not null,
  category text,
  xp_mode text,
  xp_value int,
  options_json jsonb not null default '{}'::jsonb,
  sort_order int not null default 0,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(template_id, item_key)
);

create table if not exists public.report_days (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  template_id uuid not null references public.report_templates(id) on delete cascade,
  local_date date not null,
  status text,
  created_at_utc timestamptz not null default now(),
  updated_at_utc timestamptz not null default now(),
  unique(user_id, template_id, local_date)
);

create table if not exists public.report_values (
  id uuid primary key default gen_random_uuid(),
  report_day_id uuid not null references public.report_days(id) on delete cascade,
  item_id uuid not null references public.report_items(id) on delete cascade,
  value_json jsonb,
  xp_delta_applied boolean not null default false,
  created_at_utc timestamptz not null default now(),
  updated_at_utc timestamptz not null default now(),
  unique(report_day_id, item_id)
);

create index if not exists idx_report_items_template_sort on public.report_items (template_id, sort_order);
create index if not exists idx_report_days_user_date on public.report_days (user_id, local_date);
create index if not exists idx_report_values_day_item on public.report_values (report_day_id, item_id);

-- Source: supabase/migrations/0006_routines_and_xp_caps.sql
alter table if exists public.report_items
add column if not exists xp_max_per_day int;

create table if not exists public.routines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  title text not null,
  description text,
  routine_type text not null,
  xp_mode text not null default 'none',
  xp_value int,
  xp_max_per_day int,
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_routines_user_sort on public.routines (user_id, is_active, sort_order);

alter table if exists public.xp_ledger
add column if not exists metadata_json jsonb not null default '{}'::jsonb;

-- Source: supabase/migrations/0007_routine_tasks.sql
-- Routine tasks table and updated_at maintenance

create table if not exists public.routine_tasks (
  id uuid primary key default gen_random_uuid(),
  routine_id uuid not null references public.routines(id) on delete cascade,
  title text not null,
  description text,
  item_type text not null check (item_type in ('boolean', 'duration_minutes', 'number')),
  xp_mode text not null default 'none' check (xp_mode in ('none', 'fixed', 'per_minute', 'per_number')),
  xp_value integer,
  xp_max_per_day integer,
  sort_order integer not null default 1000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at_timestamp()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_routines_updated_at') then
    create trigger trg_routines_updated_at
    before update on public.routines
    for each row
    execute function public.set_updated_at_timestamp();
  end if;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_routine_tasks_updated_at') then
    create trigger trg_routine_tasks_updated_at
    before update on public.routine_tasks
    for each row
    execute function public.set_updated_at_timestamp();
  end if;
end;
$$;

-- Source: supabase/migrations/0008_routine_task_options.sql
-- Add options_json to routine_tasks for XP ratios and future config

alter table if exists public.routine_tasks
add column if not exists options_json jsonb not null default '{}'::jsonb;

-- Source: supabase/migrations/0009_notes.sql
create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  note_date date not null,
  title text null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_notes_user_date on public.notes(user_id, note_date, created_at desc);

-- Source: supabase/migrations/0010_note_attachments.sql
create table if not exists public.note_attachments (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.notes(id) on delete cascade,
  kind text not null check (kind in ('photo', 'video', 'voice', 'document')),
  file_id text not null,
  file_unique_id text null,
  caption text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_note_attachments_note_created on public.note_attachments(note_id, created_at);

create or replace function public.list_note_date_counts(p_user_id uuid, p_limit int, p_offset int)
returns table(note_date date, count bigint)
language sql
stable
as $$
  select note_date, count(*)
  from public.notes
  where user_id = p_user_id
  group by note_date
  order by note_date desc
  limit p_limit
  offset p_offset;
$$;

-- Source: supabase/migrations/0011_notes_archive_soft_delete.sql
alter table if exists public.notes
  add column if not exists deleted_at timestamptz null,
  add column if not exists deleted_by text null;

alter table if exists public.note_attachments
  add column if not exists archive_chat_id bigint null,
  add column if not exists archive_message_id bigint null;

create or replace function public.list_note_date_counts(p_user_id uuid, p_limit int, p_offset int)
returns table(note_date date, count bigint)
language sql
stable
as $$
  select note_date, count(*)
  from public.notes
  where user_id = p_user_id
    and deleted_at is null
  group by note_date
  order by note_date desc
  limit p_limit
  offset p_offset;
$$;

-- Source: supabase/migrations/0011_reminders_cron_engine.sql
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

-- Source: supabase/migrations/0012_reminders_recurrence_and_archive.sql
create table if not exists public.reminders_attachments (
  id uuid primary key default gen_random_uuid(),
  reminder_id uuid not null references public.reminders(id) on delete cascade,
  archive_chat_id bigint not null,
  archive_message_id integer not null,
  kind text not null check (kind in ('photo', 'video', 'voice', 'video_note', 'document', 'audio')),
  caption text null,
  file_unique_id text null,
  mime_type text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_reminders_attachments_reminder_created on public.reminders_attachments(reminder_id, created_at);

alter table if exists public.reminders
  add column if not exists description text null,
  add column if not exists schedule_type text not null default 'once',
  add column if not exists timezone text not null default 'Asia/Tehran',
  add column if not exists next_run_at timestamptz null,
  add column if not exists is_active boolean not null default true,
  add column if not exists deleted_at timestamptz null,
  add column if not exists deleted_by text null,
  add column if not exists once_at timestamptz null,
  add column if not exists interval_minutes int null,
  add column if not exists at_time text null,
  add column if not exists by_weekday int null,
  add column if not exists by_monthday int null,
  add column if not exists by_month int null;

update public.reminders
set description = coalesce(description, detail),
    schedule_type = coalesce(nullif(schedule_type, ''), 'once'),
    timezone = coalesce(nullif(timezone, ''), 'Asia/Tehran'),
    next_run_at = coalesce(next_run_at, next_run_at_utc),
    is_active = coalesce(is_active, enabled),
    once_at = coalesce(once_at, next_run_at_utc)
where true;

alter table if exists public.note_attachments
  add column if not exists caption_pending boolean not null default false;

alter table if exists public.note_attachments
  drop constraint if exists note_attachments_kind_check,
  add constraint note_attachments_kind_check check (kind in ('photo', 'video', 'voice', 'document', 'video_note', 'audio'));

-- Source: supabase/migrations/0013_archive_messages.sql
create table if not exists public.archive_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  kind text not null,
  media_type text not null,
  archive_chat_id bigint not null,
  archive_message_id int not null,
  chunk_index int not null default 0,
  group_key uuid not null default gen_random_uuid(),
  caption text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_archive_messages_entity on public.archive_messages(entity_type, entity_id);
create index if not exists idx_archive_messages_group on public.archive_messages(group_key, chunk_index);
create index if not exists idx_archive_messages_user_created on public.archive_messages(user_id, created_at desc);
create unique index if not exists idx_archive_messages_unique on public.archive_messages(archive_chat_id, archive_message_id);

alter table if exists public.reminders
  add column if not exists desc_group_key uuid null;

alter table if exists public.notes
  add column if not exists title text null,
  add column if not exists content_group_key uuid null;

-- Source: supabase/migrations/0014_archive_items.sql
create table if not exists public.archive_items (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.users(id) on delete cascade,
  kind text not null,
  entity_id uuid not null,
  channel_id bigint not null,
  message_ids jsonb not null default '[]'::jsonb,
  media_summary jsonb not null default '{}'::jsonb,
  title text null,
  description text null,
  meta jsonb not null default '{}'::jsonb,
  status text not null default 'active',
  status_note text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_archive_items_owner_kind_entity on public.archive_items(owner_user_id, kind, entity_id);
create index if not exists idx_archive_items_kind_entity on public.archive_items(kind, entity_id);
create index if not exists idx_archive_items_created_at on public.archive_items(created_at desc);

alter table if exists public.notes
  add column if not exists description text null,
  add column if not exists archive_item_id uuid null references public.archive_items(id),
  add column if not exists updated_at timestamptz not null default now();

alter table if exists public.reminders
  alter column title drop not null,
  add column if not exists archive_item_id uuid null references public.archive_items(id);

-- ensure updated_at maintenance for notes
DO $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_notes_updated_at') then
    create trigger trg_notes_updated_at
    before update on public.notes
    for each row
    execute function public.set_updated_at_timestamp();
  end if;
end
$$;

-- Source: supabase/migrations/0015_notes_caption_fields.sql
alter table if exists public.notes
  add column if not exists note_photo_caption text null,
  add column if not exists note_video_caption text null,
  add column if not exists note_voice_caption text null,
  add column if not exists note_videonote_caption text null,
  add column if not exists note_file_caption text null;

