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
  add column if not exists notes text;
