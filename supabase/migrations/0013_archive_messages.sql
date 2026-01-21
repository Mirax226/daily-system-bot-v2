create table if not exists public.archive_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  kind text not null,
  media_type text not null,
  archive_chat_id bigint not null,
  archive_message_id int not null,
  chunk_index int not null default 0,
  group_key uuid not null default gen_random_uuid(),
  caption text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_archive_messages_entity on public.archive_messages(entity_type, entity_id);
create index if not exists idx_archive_messages_group on public.archive_messages(group_key, chunk_index);
create index if not exists idx_archive_messages_user_created on public.archive_messages(user_id, created_at desc);
create unique index if not exists idx_archive_messages_unique on public.archive_messages(archive_chat_id, archive_message_id);

alter table if exists public.reminders
  add column if not exists desc_group_key uuid null;

alter table if exists public.notes
  add column if not exists title text null,
  add column if not exists content_group_key uuid null;
