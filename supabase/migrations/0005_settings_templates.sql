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
