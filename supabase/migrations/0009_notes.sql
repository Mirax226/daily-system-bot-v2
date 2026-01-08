create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  note_date date not null,
  title text null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_notes_user_date on public.notes(user_id, note_date, created_at desc);
