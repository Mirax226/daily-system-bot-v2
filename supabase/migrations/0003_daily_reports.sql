create extension if not exists "pgcrypto";

create table if not exists public.daily_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,

  -- identity of the day (based on user's timezone; store as date)
  report_date date not null,

  -- Columns based on Daily Log headers:
  weekday text,
  gym boolean,
  running boolean,
  studying boolean,
  sleep_hours numeric,

  -- routines (booleans)
  routine_morning boolean,
  routine_language boolean,
  routine_meditation boolean,
  routine_mobility boolean,
  routine_english boolean,
  routine_learning boolean,
  work_small_1_pomodoro boolean,
  work_big_3_pomodoro boolean,
  rest boolean,

  -- study time in city library (numbers)
  citylib_time_hours numeric,
  citylib_book_hours numeric,
  citylib_notes_hours numeric,
  citylib_programming_hours numeric,
  citylib_tests_hours numeric,
  citylib_school_hours numeric,

  -- qualitative text
  strengths text,
  weaknesses text,
  weakness_reasons text,
  solutions text,

  -- costs
  daily_cost numeric,
  cost_reason text,

  -- supplements (booleans)
  supp_creatine boolean,
  supp_zinc boolean,
  supp_omega3 boolean,

  -- sleep details
  sleep_time_local text,
  last_caffeine boolean,
  burned_calories numeric,

  -- more booleans
  routine_night boolean,
  routine_evening boolean,
  diet_ok boolean,
  web_browsing boolean,

  -- final summary
  today_result text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique(user_id, report_date)
);

create index if not exists idx_daily_reports_user_date on public.daily_reports(user_id, report_date);
create index if not exists idx_daily_reports_date on public.daily_reports(report_date);
