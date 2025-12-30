create extension if not exists "pgcrypto";

create table if not exists public.daily_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,

  report_date date not null,              -- Excel: تاریخ (میلادی)
  wake_time time,                         -- Excel: زمان بیداری
  weekday text,                           -- Excel: روز هفته

  routine_morning boolean,                -- روتین صبح
  routine_school boolean,                 -- روتین مدرسه
  routine_taxi boolean,                   -- روتین تاکسی
  routine_evening boolean,                -- روتین عصر
  routine_night boolean,                  -- روتین شب

  review_today_hours numeric,             -- مرور دروس امروز
  preview_tomorrow_hours numeric,         -- پیش خوانی دروس فردا
  homework_done boolean,                  -- تکالیف

  workout_morning boolean,                -- ورزش صبح
  workout_night boolean,                  -- ورزش شب

  pomodoro_3_count int,                   -- چند 3 پارتی؟
  pomodoro_2_count int,                   -- چند 2 پارتی؟
  pomodoro_1_count int,                   -- چند 1 پارتی؟

  city_library_hours numeric,             -- میزان مطالعه در کتابخانه شهر - چند ساعت؟

  exam_school_questions int,              -- آزمون - مدرسه
  exam_maz_questions int,                 -- آزمون - ماز
  exam_hesaban_questions int,             -- آزمون - حسابان
  exam_physics_questions int,             -- آزمون - فیزیک
  exam_chemistry_questions int,           -- آزمون - شیمی
  exam_geology_questions int,             -- آزمون - زمین شناسی
  exam_language_questions int,            -- آزمون - زبان
  exam_religion_questions int,            -- آزمون - دینی
  exam_arabic_questions int,              -- آزمون - عربی
  exam_farsi_questions int,               -- آزمون - فارسی
  exam_philosophy_questions int,          -- آزمون - فلسفه و منطق
  exam_sociology_questions int,           -- آزمون - جامعه شناسی
  exam_konkur_questions int,              -- آزمون - کنکور

  non_academic_book_hours numeric,        -- مطالعه غیر درسی - کتاب
  non_academic_article_hours numeric,     -- مطالعه غیر درسی - مقاله
  non_academic_video_hours numeric,       -- مطالعه غیر درسی - ویدیو
  non_academic_course_hours numeric,      -- مطالعه غیر درسی - دوره

  english_content_hours numeric,          -- English - تولید محتوا
  english_speaking_hours numeric,         -- English - تمرین مکالمه
  english_class_hours numeric,            -- English - کلاس زبان

  extra_skill_learning boolean,           -- اعمال مهم اما غیر ضروری - یادگیری مهارت خاص
  extra_telegram_bot boolean,             -- اعمال مهم اما غیر ضروری - ساخت ربات تلگرام
  extra_trading_strategy boolean,         -- اعمال مهم اما غیر ضروری - استراتژی ترید

  organize_study_space boolean,           -- سازماندهی / محیط - مرتب سازی محیط مطالعه
  clean_room boolean,                     -- سازماندهی / محیط - جارو و گرد گیری اتاق
  plan_tomorrow boolean,                  -- سازماندهی / محیط - برنامه ریزی دقیق برای فردا

  family_time_hours numeric,              -- خانواده - زمان سپری شده

  planned_study_hours numeric,            -- زمان تحت برنامه - مطالعه
  planned_skills_hours numeric,           -- زمان تحت برنامه - مهارت ها
  planned_misc_hours numeric,             -- زمان تحت برنامه - متفرقه

  streak_done boolean,                    -- Streak - Done
  streak_days int,                        -- Streak - Days

  xp_s int,                               -- XP - XP S
  xp_study int,                           -- XP - XPدرسی
  xp_misc int,                            -- XP - XP متفرقه
  xp_total int,                           -- XP - XP کل روز

  sleep_time time,                        -- زمان - ساعت خواب
  note text,                              -- توضیحات - توضیحاتی کوتاه در مورد امروز

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_daily_reports_user_date
  on public.daily_reports(user_id, report_date);

create index if not exists idx_daily_reports_user_date
  on public.daily_reports(user_id, report_date desc);
