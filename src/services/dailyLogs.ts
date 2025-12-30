import { getSupabaseClient } from '../db';
import type { DailyReportRow } from '../types/supabase';
import { config } from '../config';

const DAILY_REPORTS_TABLE = 'daily_reports';

const buildFormatter = (timezone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long'
  });

export function getTodayDateString(timezone?: string): { date: string; weekday: string } {
  const tz = timezone && timezone.trim().length > 0 ? timezone : config.defaultTimezone;
  const formatter = buildFormatter(tz);
  const parts = formatter.formatToParts(new Date());
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
}

// Preserve prior interface but store in daily_reports.note and report_date
export async function upsertTodayLog(
  params: { userId: string; timezone?: string | null; summary: string },
  client = getSupabaseClient()
): Promise<DailyReportRow> {
  const { userId, timezone, summary } = params;
  const { date, weekday } = getTodayDateString(timezone ?? config.defaultTimezone);

  const payload = {
    user_id: userId,
    report_date: date,
    weekday,
    note: summary,
    updated_at: new Date().toISOString()
  } as const;

  const { data, error } = await client
    .from(DAILY_REPORTS_TABLE)
    .upsert(payload, { onConflict: 'user_id,report_date' })
    .select('*')
    .single();

  if (error) {
    console.error({ scope: 'daily_reports', event: 'upsert_error', userId, error });
    throw new Error(`Failed to upsert daily report: ${error.message}`);
  }

  console.log({ scope: 'daily_reports', event: 'upsert_today', userId, reportDate: date });
  return data as DailyReportRow;
}

export async function listRecentLogs(
  params: { userId: string; limit?: number },
  client = getSupabaseClient()
): Promise<DailyReportRow[]> {
  const { userId, limit = 5 } = params;

  const { data, error } = await client
    .from(DAILY_REPORTS_TABLE)
    .select('*')
    .eq('user_id', userId)
    .order('report_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error({ scope: 'daily_reports', event: 'list_error', userId, error });
    throw new Error(`Failed to list daily reports: ${error.message}`);
  }

  return (data as DailyReportRow[]) ?? [];
}
