-- Routine tasks table and updated_at maintenance

create table if not exists public.routine_tasks (
  id uuid primary key default gen_random_uuid(),
  routine_id uuid not null references public.routines(id) on delete cascade,
  title text not null,
  description text,
  item_type text not null check (item_type in ('boolean', 'duration_minutes', 'number')),
  xp_mode text not null default 'none' check (xp_mode in ('none', 'fixed', 'per_minute', 'per_number')),
  xp_value integer,
  xp_max_per_day integer,
  sort_order integer not null default 1000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at_timestamp()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_routines_updated_at') then
    create trigger trg_routines_updated_at
    before update on public.routines
    for each row
    execute function public.set_updated_at_timestamp();
  end if;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_routine_tasks_updated_at') then
    create trigger trg_routine_tasks_updated_at
    before update on public.routine_tasks
    for each row
    execute function public.set_updated_at_timestamp();
  end if;
end;
$$;
