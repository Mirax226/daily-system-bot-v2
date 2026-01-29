alter table if exists public.reminders_attachments
  add column if not exists file_id text null,
  add column if not exists needs_manual_fix boolean not null default false;

create index if not exists idx_reminders_attachments_file_id on public.reminders_attachments(file_id);
