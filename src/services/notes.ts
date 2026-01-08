import { getSupabaseClient } from '../db';
import type { Database, NoteRow } from '../types/supabase';
import { formatInstantToLocal } from '../utils/time';
import { config } from '../config';

const NOTES_TABLE = 'notes';

type DateSummary = { date: string; count: number };

const buildDateRange = (timezone: string, days: number): string[] => {
  const result: string[] = [];
  for (let idx = 0; idx < days; idx += 1) {
    const target = new Date(Date.now() - idx * 24 * 60 * 60 * 1000);
    result.push(formatInstantToLocal(target.toISOString(), timezone).date);
  }
  return result;
};

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
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to list notes: ${error.message}`);
  }

  return (data as NoteRow[]) ?? [];
}

export async function listRecentDates(
  params: { userId: string; days?: number; timezone?: string | null },
  client = getSupabaseClient()
): Promise<DateSummary[]> {
  const { userId, days = 7, timezone } = params;
  const tz = timezone && timezone.trim().length > 0 ? timezone : config.defaultTimezone;
  const dates = buildDateRange(tz, days);

  const { data, error } = await client.from(NOTES_TABLE).select('note_date, created_at').eq('user_id', userId).in('note_date', dates);

  if (error) {
    throw new Error(`Failed to list note dates: ${error.message}`);
  }

  const counts = new Map<string, number>();
  for (const date of dates) counts.set(date, 0);
  for (const row of data ?? []) {
    const date = (row as { note_date: string }).note_date;
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }

  return dates.map((date) => ({ date, count: counts.get(date) ?? 0 }));
}

export async function getNoteById(
  params: { userId: string; id: string },
  client = getSupabaseClient()
): Promise<NoteRow | null> {
  const { userId, id } = params;
  const { data, error } = await client.from(NOTES_TABLE).select('*').eq('id', id).eq('user_id', userId).maybeSingle();

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
  const { error } = await client.from(NOTES_TABLE).delete().eq('id', id).eq('user_id', userId);
  if (error) {
    throw new Error(`Failed to delete note: ${error.message}`);
  }
}

export async function clearDate(
  params: { userId: string; noteDate: string },
  client = getSupabaseClient()
): Promise<void> {
  const { userId, noteDate } = params;
  const { error } = await client.from(NOTES_TABLE).delete().eq('user_id', userId).eq('note_date', noteDate);
  if (error) {
    throw new Error(`Failed to clear notes: ${error.message}`);
  }
}

export type { DateSummary };
