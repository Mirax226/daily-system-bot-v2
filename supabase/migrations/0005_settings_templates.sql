-- 0005_settings_templates.sql
create extension if not exists "pgcrypto";

-- 1) User-level settings
create table if not exists public.user_settings (
  user_id uuid primary key references public.users(id) on delete cascade,
  timezone text not null default 'Asia/Tehran',
  onboarded boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2) Daily report template per user (you can support multiple templates later)
create table if not exists public.report_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  title text not null default 'Daily Report',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_report_templates_user_enabled
  on public.report_templates(user_id, enabled);

-- 3) Items (questions/fields) that appear in daily report
-- input_type examples: boolean, integer, decimal, duration_minutes, time_hhmm, text, select
create table if not exists public.report_items (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.report_templates(id) on delete cascade,
  key text not null,
  label text not null,
  category text not null,          -- routine | study | exam | sleep | nonstudy | custom
  input_type text not null,
  sort_order int not null default 0,
  enabled boolean not null default true,

  -- XP rule (simple v1)
  xp_mode text not null default 'none',   -- none | fixed | time
  xp_value numeric,                      -- fixed: XP; time: XP per minute (or per unit defined in options_json)
  options_json jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ux_report_items_template_key unique (template_id, key),
  constraint chk_xp_mode check (xp_mode in ('none','fixed','time'))
);

create index if not exists idx_report_items_template_enabled_sort
  on public.report_items(template_id, enabled, sort_order);

-- 4) One row per day per user
create table if not exists public.report_days (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  local_date date not null,
  template_id uuid not null references public.report_templates(id) on delete restrict,
  status text not null default 'open', -- open | submitted | locked
  created_at_utc timestamptz not null default now(),
  updated_at_utc timestamptz not null default now(),
  constraint ux_report_days_user_date unique (user_id, local_date)
);

create index if not exists idx_report_days_user_date
  on public.report_days(user_id, local_date desc);

-- 5) Values per item per day (generic storage)
create table if not exists public.report_values (
  id uuid primary key default gen_random_uuid(),
  report_day_id uuid not null references public.report_days(id) on delete cascade,
  item_id uuid not null references public.report_items(id) on delete cascade,
  value_json jsonb not null,
  filled_at_utc timestamptz not null default now(),
  constraint ux_report_values_day_item unique (report_day_id, item_id)
);

create index if not exists idx_report_values_day
  on public.report_values(report_day_id);
