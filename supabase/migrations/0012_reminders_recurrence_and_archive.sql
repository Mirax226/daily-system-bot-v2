create table if not exists public.reminders_attachments (
  id uuid primary key default gen_random_uuid(),
  reminder_id uuid not null references public.reminders(id) on delete cascade,
  archive_chat_id bigint not null,
  archive_message_id integer not null,
  kind text not null check (kind in ('photo', 'video', 'voice', 'video_note', 'document', 'audio')),
  caption text null,
  file_unique_id text null,
  mime_type text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_reminders_attachments_reminder_created on public.reminders_attachments(reminder_id, created_at);

alter table if exists public.reminders
  add column if not exists description text null,
  add column if not exists schedule_type text not null default 'once',
  add column if not exists timezone text not null default 'Asia/Tehran',
  add column if not exists next_run_at timestamptz null,
  add column if not exists is_active boolean not null default true,
  add column if not exists deleted_at timestamptz null,
  add column if not exists deleted_by text null,
  add column if not exists once_at timestamptz null,
  add column if not exists interval_minutes int null,
  add column if not exists at_time text null,
  add column if not exists by_weekday int null,
  add column if not exists by_monthday int null,
  add column if not exists by_month int null;

update public.reminders
set description = coalesce(description, detail),
    schedule_type = coalesce(nullif(schedule_type, ''), 'once'),
    timezone = coalesce(nullif(timezone, ''), 'Asia/Tehran'),
    next_run_at = coalesce(next_run_at, next_run_at_utc),
    is_active = coalesce(is_active, enabled),
    once_at = coalesce(once_at, next_run_at_utc)
where true;

alter table if exists public.note_attachments
  add column if not exists caption_pending boolean not null default false;

alter table if exists public.note_attachments
  drop constraint if exists note_attachments_kind_check,
  add constraint note_attachments_kind_check check (kind in ('photo', 'video', 'voice', 'document', 'video_note', 'audio'));
