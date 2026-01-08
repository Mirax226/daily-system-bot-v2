create table if not exists public.note_attachments (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.notes(id) on delete cascade,
  kind text not null check (kind in ('photo', 'video', 'voice', 'document')),
  file_id text not null,
  file_unique_id text null,
  caption text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_note_attachments_note_created on public.note_attachments(note_id, created_at);

create or replace function public.list_note_date_counts(p_user_id uuid, p_limit int, p_offset int)
returns table(note_date date, count bigint)
language sql
stable
as $$
  select note_date, count(*)
  from public.notes
  where user_id = p_user_id
  group by note_date
  order by note_date desc
  limit p_limit
  offset p_offset;
$$;
