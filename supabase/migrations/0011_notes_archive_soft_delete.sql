alter table if exists public.notes
  add column if not exists deleted_at timestamptz null,
  add column if not exists deleted_by text null;

alter table if exists public.note_attachments
  add column if not exists archive_chat_id bigint null,
  add column if not exists archive_message_id bigint null;

create or replace function public.list_note_date_counts(p_user_id uuid, p_limit int, p_offset int)
returns table(note_date date, count bigint)
language sql
stable
as $$
  select note_date, count(*)
  from public.notes
  where user_id = p_user_id
    and deleted_at is null
  group by note_date
  order by note_date desc
  limit p_limit
  offset p_offset;
$$;
