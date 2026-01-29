create extension if not exists "pgcrypto";

create table if not exists public.user_settings_kv (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  key text not null,
  value text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, key)
);

create index if not exists idx_user_settings_kv_user on public.user_settings_kv(user_id);
