import { getSupabaseClient } from '../db';
import type { NoteAttachmentRow, NoteRow } from '../types/supabase';

const NOTES_TABLE = 'notes';

type DateSummary = { date: string; count: number };

const ATTACHMENTS_TABLE = 'note_attachments';

export async function createNote(
  params: { userId: string; noteDate: string; title?: string | null; body: string },
  client = getSupabaseClient()
): Promise<NoteRow> {
  const { userId, noteDate, title, body } = params;
  const { data, error } = await client
    .from(NOTES_TABLE)
    .insert({
      user_id: userId,
      note_date: noteDate,
      title: title ?? null,
      body
    })
    .select('*')
    .single();

  if (error) {
    throw new Error(`Failed to create note: ${error.message}`);
  }

  return data as NoteRow;
}

export async function listNotesByDate(
  params: { userId: string; noteDate: string },
  client = getSupabaseClient()
): Promise<NoteRow[]> {
  const { userId, noteDate } = params;
  const { data, error } = await client
    .from(NOTES_TABLE)
    .select('*')
    .eq('user_id', userId)
    .eq('note_date', noteDate)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to list notes: ${error.message}`);
  }

  return (data as NoteRow[]) ?? [];
}

export async function listNoteDateSummaries(
  params: { userId: string; limit: number; offset: number },
  client = getSupabaseClient()
): Promise<{ entries: DateSummary[]; hasMore: boolean }> {
  const { userId, limit, offset } = params;
  const { data, error } = await client.rpc('list_note_date_counts', { p_user_id: userId, p_limit: limit + 1, p_offset: offset });

  if (error) {
    throw new Error(`Failed to list note dates: ${error.message}`);
  }

  const rows = (data as { note_date: string; count: number }[]) ?? [];
  const hasMore = rows.length > limit;
  const entries = rows.slice(0, limit).map((row) => ({ date: row.note_date, count: Number(row.count) }));

  return { entries, hasMore };
}

export async function listNotesByDatePage(
  params: { userId: string; noteDate: string; limit: number; offset: number },
  client = getSupabaseClient()
): Promise<{ notes: NoteRow[]; total: number }> {
  const { userId, noteDate, limit, offset } = params;
  const { data, error, count } = await client
    .from(NOTES_TABLE)
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .eq('note_date', noteDate)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw new Error(`Failed to list notes: ${error.message}`);
  }

  return { notes: (data as NoteRow[]) ?? [], total: count ?? 0 };
}

export async function getNoteById(
  params: { userId: string; id: string },
  client = getSupabaseClient()
): Promise<NoteRow | null> {
  const { userId, id } = params;
  const { data, error } = await client
    .from(NOTES_TABLE)
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load note: ${error.message}`);
  }

  return data ?? null;
}

export async function deleteNote(
  params: { userId: string; id: string },
  client = getSupabaseClient()
): Promise<void> {
  const { userId, id } = params;
  const { error } = await client
    .from(NOTES_TABLE)
    .update({ deleted_at: new Date().toISOString(), deleted_by: 'user' })
    .eq('id', id)
    .eq('user_id', userId);
  if (error) {
    throw new Error(`Failed to delete note: ${error.message}`);
  }
}

export async function updateNote(
  params: { userId: string; id: string; title?: string | null; body?: string },
  client = getSupabaseClient()
): Promise<NoteRow> {
  const { userId, id, title, body } = params;
  const update: Partial<NoteRow> = {};
  if (title !== undefined) update.title = title;
  if (body !== undefined) update.body = body;

  const { data, error } = await client
    .from(NOTES_TABLE)
    .update(update)
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .single();

  if (error) {
    throw new Error(`Failed to update note: ${error.message}`);
  }

  return data as NoteRow;
}

export async function clearDate(
  params: { userId: string; noteDate: string },
  client = getSupabaseClient()
): Promise<void> {
  const { userId, noteDate } = params;
  const { error } = await client
    .from(NOTES_TABLE)
    .update({ deleted_at: new Date().toISOString(), deleted_by: 'user' })
    .eq('user_id', userId)
    .eq('note_date', noteDate)
    .is('deleted_at', null);
  if (error) {
    throw new Error(`Failed to clear notes: ${error.message}`);
  }
}

export async function createNoteAttachment(
  params: {
    noteId: string;
    kind: NoteAttachmentRow['kind'];
    fileId: string;
    fileUniqueId?: string | null;
    caption?: string | null;
    captionPending?: boolean;
    archiveChatId?: number | null;
    archiveMessageId?: number | null;
  },
  client = getSupabaseClient()
): Promise<NoteAttachmentRow> {
  const { noteId, kind, fileId, fileUniqueId, caption, captionPending, archiveChatId, archiveMessageId } = params;
  const { data, error } = await client
    .from(ATTACHMENTS_TABLE)
    .insert({
      note_id: noteId,
      kind,
      file_id: fileId,
      file_unique_id: fileUniqueId ?? null,
      caption: caption ?? null,
      caption_pending: captionPending ?? false,
      archive_chat_id: archiveChatId ?? null,
      archive_message_id: archiveMessageId ?? null
    })
    .select('*')
    .single();

  if (error) {
    throw new Error(`Failed to create attachment: ${error.message}`);
  }

  return data as NoteAttachmentRow;
}

export async function updateNoteAttachmentCaption(
  params: { attachmentId: string; caption: string | null },
  client = getSupabaseClient()
): Promise<NoteAttachmentRow> {
  const { attachmentId, caption } = params;
  const { data, error } = await client
    .from(ATTACHMENTS_TABLE)
    .update({ caption, caption_pending: false })
    .eq('id', attachmentId)
    .select('*')
    .single();

  if (error) {
    throw new Error(`Failed to update attachment: ${error.message}`);
  }

  return data as NoteAttachmentRow;
}

export async function listNoteAttachmentKinds(
  params: { noteId: string },
  client = getSupabaseClient()
): Promise<{ total: number; counts: Record<NoteAttachmentRow['kind'], number> }> {
  const { noteId } = params;
  const { data, error } = await client.from(ATTACHMENTS_TABLE).select('kind').eq('note_id', noteId);

  if (error) {
    throw new Error(`Failed to list attachments: ${error.message}`);
  }

  const counts = {
    photo: 0,
    video: 0,
    voice: 0,
    document: 0,
    video_note: 0,
    audio: 0
  } as Record<NoteAttachmentRow['kind'], number>;
  for (const row of (data as { kind: NoteAttachmentRow['kind'] }[]) ?? []) {
    counts[row.kind] = (counts[row.kind] ?? 0) + 1;
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return { total, counts };
}

export async function listNoteAttachments(
  params: { noteId: string },
  client = getSupabaseClient()
): Promise<NoteAttachmentRow[]> {
  const { noteId } = params;
  const { data, error } = await client.from(ATTACHMENTS_TABLE).select('*').eq('note_id', noteId).order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to list attachments: ${error.message}`);
  }

  return (data as NoteAttachmentRow[]) ?? [];
}

export async function listNoteAttachmentsByKind(
  params: { noteId: string; kind: NoteAttachmentRow['kind'] },
  client = getSupabaseClient()
): Promise<NoteAttachmentRow[]> {
  return listNoteAttachmentsByKinds({ noteId: params.noteId, kinds: [params.kind] }, client);
}

export async function listNoteAttachmentsByKinds(
  params: { noteId: string; kinds: NoteAttachmentRow['kind'][] },
  client = getSupabaseClient()
): Promise<NoteAttachmentRow[]> {
  const { noteId, kinds } = params;
  const { data, error } = await client
    .from(ATTACHMENTS_TABLE)
    .select('*')
    .eq('note_id', noteId)
    .in('kind', kinds)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to list attachments: ${error.message}`);
  }

  return (data as NoteAttachmentRow[]) ?? [];
}

export async function listPendingNoteAttachments(
  params: { noteId: string },
  client = getSupabaseClient()
): Promise<NoteAttachmentRow[]> {
  const { noteId } = params;
  const { data, error } = await client
    .from(ATTACHMENTS_TABLE)
    .select('*')
    .eq('note_id', noteId)
    .eq('caption_pending', true)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to list pending attachments: ${error.message}`);
  }

  return (data as NoteAttachmentRow[]) ?? [];
}

export async function updateNoteAttachmentsCaptionByKinds(
  params: { noteId: string; kinds: NoteAttachmentRow['kind'][]; caption: string | null },
  client = getSupabaseClient()
): Promise<void> {
  const { noteId, kinds, caption } = params;
  const { error } = await client
    .from(ATTACHMENTS_TABLE)
    .update({ caption, caption_pending: false })
    .eq('note_id', noteId)
    .in('kind', kinds)
    .eq('caption_pending', true);

  if (error) {
    throw new Error(`Failed to update attachment captions: ${error.message}`);
  }
}

export async function clearPendingNoteAttachments(
  params: { noteId: string },
  client = getSupabaseClient()
): Promise<void> {
  const { noteId } = params;
  const { error } = await client
    .from(ATTACHMENTS_TABLE)
    .update({ caption_pending: false })
    .eq('note_id', noteId)
    .eq('caption_pending', true);

  if (error) {
    throw new Error(`Failed to clear attachment captions: ${error.message}`);
  }
}

export async function getNoteAttachmentById(
  params: { noteId: string; attachmentId: string },
  client = getSupabaseClient()
): Promise<NoteAttachmentRow | null> {
  const { noteId, attachmentId } = params;
  const { data, error } = await client.from(ATTACHMENTS_TABLE).select('*').eq('note_id', noteId).eq('id', attachmentId).maybeSingle();

  if (error) {
    throw new Error(`Failed to load attachment: ${error.message}`);
  }

  return data ?? null;
}

export type { DateSummary };
