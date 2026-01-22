create table if not exists public.archive_items (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.users(id) on delete cascade,
  kind text not null,
  entity_id uuid not null,
  channel_id bigint not null,
  message_ids jsonb not null default '[]'::jsonb,
  media_summary jsonb not null default '{}'::jsonb,
  title text null,
  description text null,
  meta jsonb not null default '{}'::jsonb,
  status text not null default 'active',
  status_note text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_archive_items_owner_kind_entity on public.archive_items(owner_user_id, kind, entity_id);
create index if not exists idx_archive_items_kind_entity on public.archive_items(kind, entity_id);
create index if not exists idx_archive_items_created_at on public.archive_items(created_at desc);

alter table if exists public.notes
  add column if not exists description text null,
  add column if not exists archive_item_id uuid null references public.archive_items(id),
  add column if not exists updated_at timestamptz not null default now();

alter table if exists public.reminders
  alter column title drop not null,
  add column if not exists archive_item_id uuid null references public.archive_items(id);

-- ensure updated_at maintenance for notes
DO $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_notes_updated_at') then
    create trigger trg_notes_updated_at
    before update on public.notes
    for each row
    execute function public.set_updated_at_timestamp();
  end if;
end
$$;
