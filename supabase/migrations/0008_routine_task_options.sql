-- Add options_json to routine_tasks for XP ratios and future config

alter table if exists public.routine_tasks
add column if not exists options_json jsonb not null default '{}'::jsonb;
