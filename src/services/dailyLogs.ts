import { getSupabaseClient } from '../db';
import type { Database, DailyLogRow } from '../types/supabase';
import { config } from '../config';

const DAILY_LOGS_TABLE = 'daily_logs';

const buildFormatter = (timezone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

export function getTodayDateString(timezone?: string): string {
  const tz = timezone && timezone.trim().length > 0 ? timezone : config.defaultTimezone;
  const formatter = buildFormatter(tz);
  const parts = formatter.formatToParts(new Date());
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      lookup[part.type] = part.value;
    }
  }

  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

export async function upsertTodayLog(
  params: { userId: string; timezone?: string | null; summary: string },
  client = getSupabaseClient()
): Promise<DailyLogRow> {
  const { userId, timezone, summary } = params;
  const logDate = getTodayDateString(timezone ?? config.defaultTimezone);

  const { data: existing, error: selectError } = await client
    .from(DAILY_LOGS_TABLE)
    .select('*')
    .eq('user_id', userId)
    .eq('log_date', logDate)
    .maybeSingle();

  if (selectError) {
    throw new Error(`Failed to upsert daily log: ${selectError.message}`);
  }

  if (existing) {
    const { data, error } = await client
      .from(DAILY_LOGS_TABLE)
      .update({ summary, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select('*')
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to upsert daily log: ${error.message}`);
    }
    if (!data) {
      throw new Error('Failed to upsert daily log: no data returned after update');
    }

    return data as DailyLogRow;
  }

  const { data, error } = await client
    .from(DAILY_LOGS_TABLE)
    .insert({ user_id: userId, log_date: logDate, summary })
    .select('*')
    .single();

  if (error) {
    throw new Error(`Failed to upsert daily log: ${error.message}`);
  }

  return data as DailyLogRow;
}

export async function listRecentLogs(
  params: { userId: string; limit?: number },
  client = getSupabaseClient()
): Promise<DailyLogRow[]> {
  const { userId, limit = 5 } = params;

  const { data, error } = await client
    .from(DAILY_LOGS_TABLE)
    .select('*')
    .eq('user_id', userId)
    .order('log_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to list daily logs: ${error.message}`);
  }

  return (data as DailyLogRow[]) ?? [];
}
