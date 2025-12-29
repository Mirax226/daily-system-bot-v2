import { config } from '../config';
import { getSupabaseClient } from '../db';
import type { Database, DailyReportRow } from '../types/supabase';

const DAILY_REPORTS_TABLE = 'daily_reports';

export type DailyReportFieldKey = keyof DailyReportRow;

export type DailyReportCompletionItem = {
  key: DailyReportFieldKey;
  label: string;
  filled: boolean;
};

const normalizeTimezone = (timezone?: string | null): string => {
  const tz = timezone?.trim();
  return tz && tz.length > 0 ? tz : config.defaultTimezone;
};

const dateParts = (date: Date, timezone: string): { date: string; weekday: string } => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long'
  });

  const parts = formatter.formatToParts(date);
  const lookup: Record<string, string> = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      lookup[part.type] = part.value;
    }
  }

  return {
    date: `${lookup.year}-${lookup.month}-${lookup.day}`,
    weekday: lookup.weekday ?? ''
  };
};

export const getTodayDateString = (timezone?: string): { date: string; weekday: string } => {
  const tz = normalizeTimezone(timezone);
  return dateParts(new Date(), tz);
};

export async function getOrCreateTodayReport(params: { userId: string; timezone?: string | null }, client = getSupabaseClient()): Promise<DailyReportRow> {
  const tz = normalizeTimezone(params.timezone);
  const { date, weekday } = getTodayDateString(tz);

  const existing = await getReportByDate(params.userId, date, client);
  if (existing) return existing;

  const { data, error } = await client
    .from(DAILY_REPORTS_TABLE)
    .insert({
      user_id: params.userId,
      report_date: date,
      weekday
    })
    .select('*')
    .single();

  if (error) {
    throw new Error(`Failed to create today's report: ${error.message}`);
  }

  return data as DailyReportRow;
}

export async function getReportByDate(userId: string, reportDate: string, client = getSupabaseClient()): Promise<DailyReportRow | null> {
  const { data, error } = await client
    .from(DAILY_REPORTS_TABLE)
    .select('*')
    .eq('user_id', userId)
    .eq('report_date', reportDate)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load report for date ${reportDate}: ${error.message}`);
  }

  return data ?? null;
}

export async function getReportById(reportId: string, client = getSupabaseClient()): Promise<DailyReportRow | null> {
  const { data, error } = await client.from(DAILY_REPORTS_TABLE).select('*').eq('id', reportId).maybeSingle();

  if (error) {
    throw new Error(`Failed to load report: ${error.message}`);
  }

  return data ?? null;
}

export type DailyReportPatch = Partial<Omit<DailyReportRow, 'id' | 'user_id' | 'report_date' | 'created_at' | 'updated_at'>>;

export async function updateReportFields(
  reportId: string,
  patch: DailyReportPatch,
  client = getSupabaseClient()
): Promise<DailyReportRow> {
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  for (const [key, value] of Object.entries(patch)) {
    updates[key] = value;
  }

  const { data, error } = await client
    .from(DAILY_REPORTS_TABLE)
    .update(updates)
    .eq('id', reportId)
    .select('*')
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to update report: ${error.message}`);
  }

  if (!data) {
    throw new Error('Failed to update report: no data returned');
  }

  return data as DailyReportRow;
}

export async function listRecentReports(userId: string, limit = 5, client = getSupabaseClient()): Promise<DailyReportRow[]> {
  const { data, error } = await client
    .from(DAILY_REPORTS_TABLE)
    .select('*')
    .eq('user_id', userId)
    .order('report_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to list reports: ${error.message}`);
  }

  return (data as DailyReportRow[]) ?? [];
}

const completionDefinitions: { key: DailyReportFieldKey; label: string; optional?: boolean; type?: 'boolean' | 'number' | 'text' | 'time' }[] = [
  { key: 'gym', label: 'باشگاه', type: 'boolean' },
  { key: 'running', label: 'دویدن', type: 'boolean' },
  { key: 'studying', label: 'مطالعه', type: 'boolean' },
  { key: 'sleep_hours', label: 'میزان خواب', type: 'number' },
  { key: 'routine_morning', label: 'روتین صبح', type: 'boolean' },
  { key: 'routine_language', label: 'روتین زبان', type: 'boolean' },
  { key: 'routine_meditation', label: 'مدیتیشن/مکث', type: 'boolean' },
  { key: 'routine_mobility', label: 'تحرک/راه رفتن', type: 'boolean' },
  { key: 'routine_english', label: 'انگلیسی', type: 'boolean' },
  { key: 'routine_learning', label: 'یادگیری', type: 'boolean' },
  { key: 'work_small_1_pomodoro', label: 'کمی کار (1 پومودورو)', type: 'boolean' },
  { key: 'work_big_3_pomodoro', label: 'کار زیاد (3 پومودورو)', type: 'boolean' },
  { key: 'rest', label: 'استراحت', type: 'boolean' },
  { key: 'citylib_time_hours', label: 'مطالعه کتابخانه (کل)', type: 'number' },
  { key: 'citylib_book_hours', label: 'کتاب', type: 'number' },
  { key: 'citylib_notes_hours', label: 'جزوه', type: 'number' },
  { key: 'citylib_programming_hours', label: 'برنامه‌نویسی', type: 'number' },
  { key: 'citylib_tests_hours', label: 'تست‌زنی', type: 'number' },
  { key: 'citylib_school_hours', label: 'اسکول', type: 'number' },
  { key: 'strengths', label: 'نقاط قوت', optional: true, type: 'text' },
  { key: 'weaknesses', label: 'نقاط ضعف', optional: true, type: 'text' },
  { key: 'weakness_reasons', label: 'دلایل ضعف', optional: true, type: 'text' },
  { key: 'solutions', label: 'راهکار', optional: true, type: 'text' },
  { key: 'daily_cost', label: 'هزینه روز', optional: true, type: 'number' },
  { key: 'cost_reason', label: 'علت هزینه', optional: true, type: 'text' },
  { key: 'supp_creatine', label: 'کراتین', type: 'boolean' },
  { key: 'supp_zinc', label: 'زینک', type: 'boolean' },
  { key: 'supp_omega3', label: 'امگا3', type: 'boolean' },
  { key: 'sleep_time_local', label: 'ساعت خواب', optional: true, type: 'time' },
  { key: 'last_caffeine', label: 'آخرین مصرف کافئین', optional: true, type: 'boolean' },
  { key: 'burned_calories', label: 'کالری سوزانده', optional: true, type: 'number' },
  { key: 'routine_night', label: 'روتین شب', optional: true, type: 'boolean' },
  { key: 'routine_evening', label: 'روتین عصر', optional: true, type: 'boolean' },
  { key: 'diet_ok', label: 'رعایت رژیم', optional: true, type: 'boolean' },
  { key: 'web_browsing', label: 'وبگردی', optional: true, type: 'boolean' },
  { key: 'today_result', label: 'نتیجه امروز', optional: true, type: 'text' }
];

const isFilledValue = (value: unknown): boolean => {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return !Number.isNaN(value);
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== null && typeof value !== 'undefined';
};

export function computeCompletionStatus(report: DailyReportRow): DailyReportCompletionItem[] {
  return completionDefinitions.map((def) => ({
    key: def.key,
    label: def.label,
    filled: isFilledValue(report[def.key])
  }));
}

export type DailyReportFieldDefinition = typeof completionDefinitions[number];
export const DAILY_REPORT_FIELD_DEFINITIONS = completionDefinitions;
