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
