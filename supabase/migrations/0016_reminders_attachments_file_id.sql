alter table if exists public.reminders_attachments
  add column if not exists file_id text null;
