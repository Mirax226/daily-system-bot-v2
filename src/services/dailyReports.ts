import { config } from '../config';
import { getSupabaseClient } from '../db';
import type { DailyReportRow, DailyReportUpdate } from '../types/supabase';

const DAILY_REPORTS_TABLE = 'daily_reports';

const normalizeTimezone = (timezone?: string | null): string => {
  const tz = timezone?.trim();
  return tz && tz.length > 0 ? tz : config.defaultTimezone;
};

const formatDateParts = (date: Date, timezone: string): { date: string } => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const parts = formatter.formatToParts(date);
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      lookup[part.type] = part.value;
    }
  }

  return {
    date: `${lookup.year}-${lookup.month}-${lookup.day}`
  };
};

export const getTodayDateString = (timezone?: string | null): string => {
  const tz = normalizeTimezone(timezone);
  return formatDateParts(new Date(), tz).date;
};

const getDateStringForOffset = (offsetDays: number, timezone?: string | null): string => {
  const tz = normalizeTimezone(timezone);
  const target = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return formatDateParts(target, tz).date;
};

export async function getNoteForDate(
  userId: string,
  localDate: string,
  client = getSupabaseClient()
): Promise<string | null> {
  const { data, error } = await client
    .from(DAILY_REPORTS_TABLE)
    .select('notes')
    .eq('user_id', userId)
    .eq('report_date', localDate)
    .maybeSingle();

  if (error) {
    console.error({ scope: 'daily_reports', event: 'note_get_error', userId, localDate, error });
    throw new Error(`Failed to load note: ${error.message}`);
  }

  return (data as { notes: string | null } | null)?.notes ?? null;
}

export async function upsertNoteForDate(
  userId: string,
  localDate: string,
  text: string,
  client = getSupabaseClient()
): Promise<void> {
  const payload = {
    user_id: userId,
    report_date: localDate,
    notes: text,
    updated_at: new Date().toISOString()
  };

  const { error } = await client.from(DAILY_REPORTS_TABLE).upsert(payload, { onConflict: 'user_id,report_date' });

  if (error) {
    console.error({ scope: 'daily_reports', event: 'note_upsert_error', userId, localDate, error });
    throw new Error(`Failed to save note: ${error.message}`);
  }
}

export async function clearNoteForDate(
  userId: string,
  localDate: string,
  client = getSupabaseClient()
): Promise<void> {
  const payload = {
    user_id: userId,
    report_date: localDate,
    notes: null,
    updated_at: new Date().toISOString()
  };

  const { error } = await client.from(DAILY_REPORTS_TABLE).upsert(payload, { onConflict: 'user_id,report_date' });

  if (error) {
    console.error({ scope: 'daily_reports', event: 'note_clear_error', userId, localDate, error });
    throw new Error(`Failed to clear note: ${error.message}`);
  }
}

export async function listRecentNotes(
  userId: string,
  days: number,
  timezone?: string | null,
  client = getSupabaseClient()
): Promise<Array<{ date: string; note: string }>> {
  const startDate = getDateStringForOffset(-(days - 1), timezone);

  const { data, error } = await client
    .from(DAILY_REPORTS_TABLE)
    .select('report_date, notes')
    .eq('user_id', userId)
    .gte('report_date', startDate)
    .not('notes', 'is', null)
    .neq('notes', '')
    .order('report_date', { ascending: false });

  if (error) {
    console.error({ scope: 'daily_reports', event: 'notes_list_error', userId, error });
    throw new Error(`Failed to list notes: ${error.message}`);
  }

  return (
    (data as { report_date: string; notes: string | null }[] | null) ?? []
  ).map((row) => ({ date: row.report_date, note: row.notes ?? '' }));
}

export async function upsertTodayReport(
  params: { userId: string; timezone?: string | null },
  client = getSupabaseClient()
): Promise<DailyReportRow> {
  const date = getTodayDateString(params.timezone);
  const payload = {
    user_id: params.userId,
    report_date: date,
    updated_at: new Date().toISOString()
  };

  const { data, error } = await client
    .from(DAILY_REPORTS_TABLE)
    .upsert(payload, { onConflict: 'user_id,report_date' })
    .select('*')
    .single();

  if (error) {
    console.error({ scope: 'daily_reports', event: 'upsert_error', userId: params.userId, error });
    throw new Error(`Failed to upsert today's report: ${error.message}`);
  }

  console.log({ scope: 'daily_reports', event: 'upsert_today', userId: params.userId, reportDate: date });
  return data as DailyReportRow;
}

export async function getReportById(reportId: string, client = getSupabaseClient()): Promise<DailyReportRow | null> {
  const { data, error } = await client.from(DAILY_REPORTS_TABLE).select('*').eq('id', reportId).maybeSingle();

  if (error) {
    throw new Error(`Failed to load report: ${error.message}`);
  }

  return data ?? null;
}

export async function updateReport(
  reportId: string,
  patch: DailyReportUpdate,
  client = getSupabaseClient()
): Promise<DailyReportRow> {
  const updates: Record<string, unknown> = {
    ...patch,
    updated_at: new Date().toISOString()
  };

  const { data, error } = await client
    .from(DAILY_REPORTS_TABLE)
    .update(updates)
    .eq('id', reportId)
    .select('*')
    .maybeSingle();

  if (error) {
    console.error({ scope: 'daily_reports', event: 'update_error', reportId, patch, error });
    throw new Error(`Failed to update report: ${error.message}`);
  }

  if (!data) {
    throw new Error('Failed to update report: no data returned');
  }

  console.log({ scope: 'daily_reports', event: 'update_ok', reportId });
  return data as DailyReportRow;
}

export async function listRecentReports(
  userId: string,
  limit = 10,
  client = getSupabaseClient()
): Promise<DailyReportRow[]> {
  const { data, error } = await client
    .from(DAILY_REPORTS_TABLE)
    .select('*')
    .eq('user_id', userId)
    .order('report_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error({ scope: 'daily_reports', event: 'list_error', userId, error });
    throw new Error(`Failed to list reports: ${error.message}`);
  }

  return (data as DailyReportRow[]) ?? [];
}

const completionKeys: (keyof DailyReportRow)[] = [
  'wake_time',
  'routine_morning',
  'routine_school',
  'routine_taxi',
  'routine_evening',
  'routine_night',
  'review_today_hours',
  'preview_tomorrow_hours',
  'homework_done',
  'workout_morning',
  'workout_evening',
  'pomodoro_3_count',
  'pomodoro_2_count',
  'pomodoro_1_count',
  'library_study_hours',
  'exam_school_questions',
  'exam_maz_questions',
  'exam_hesaban_questions',
  'exam_physics_questions',
  'exam_chemistry_questions',
  'exam_geology_questions',
  'exam_language_questions',
  'exam_religion_questions',
  'exam_arabic_questions',
  'exam_persian_questions',
  'read_book_minutes',
  'read_article_minutes',
  'watch_video_minutes',
  'course_minutes',
  'english_conversation_minutes',
  'skill_learning_minutes',
  'telegram_bot_minutes',
  'trading_strategy_minutes',
  'tidy_study_area',
  'clean_room',
  'plan_tomorrow',
  'family_time_minutes',
  'sleep_time',
  'notes',
  'time_planned_study_minutes',
  'time_planned_skills_minutes',
  'time_planned_misc_minutes',
  'streak_done',
  'streak_days',
  'xp_s',
  'xp_study',
  'xp_misc',
  'xp_total',
  'status'
];

export function isFieldCompleted(report: DailyReportRow, key: keyof DailyReportRow): boolean {
  const value = report[key];
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return value !== null && !Number.isNaN(value);
  if (typeof value === 'string') return value !== null && value.trim().length > 0;
  return value !== null && typeof value !== 'undefined';
}

export function computeCompletionStatus(report: DailyReportRow): { key: keyof DailyReportRow; filled: boolean }[] {
  return completionKeys.map((key) => ({ key, filled: isFieldCompleted(report, key) }));
}
