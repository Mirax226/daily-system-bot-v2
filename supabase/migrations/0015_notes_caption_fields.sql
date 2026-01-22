alter table if exists public.notes
  add column if not exists note_photo_caption text null,
  add column if not exists note_video_caption text null,
  add column if not exists note_voice_caption text null,
  add column if not exists note_videonote_caption text null,
  add column if not exists note_file_caption text null;
