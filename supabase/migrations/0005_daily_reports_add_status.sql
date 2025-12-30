alter table if exists public.daily_reports
  add column if not exists status text;
