-- 0004_daily_reports_hours_to_numeric.sql

alter table public.daily_reports
  alter column review_today_hours type numeric(5,2) using review_today_hours::numeric,
  alter column preview_tomorrow_hours type numeric(5,2) using preview_tomorrow_hours::numeric,
  alter column library_study_hours type numeric(5,2) using library_study_hours::numeric;
