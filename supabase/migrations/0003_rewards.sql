create extension if not exists "pgcrypto";

create table if not exists public.rewards (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  cost_xp int not null,
  enabled boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.reward_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  reward_id uuid not null references public.rewards(id) on delete restrict,
  title_snapshot text not null,
  cost_xp_snapshot int not null,
  purchased_at_utc timestamptz not null default now()
);

create index if not exists idx_rewards_enabled_sort on public.rewards (enabled, sort_order);
create index if not exists idx_reward_purchases_user_time on public.reward_purchases (user_id, purchased_at_utc);
