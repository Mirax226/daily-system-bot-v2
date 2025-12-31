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
