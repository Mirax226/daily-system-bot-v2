import { getSupabaseClient } from '../db';
import type { ReportDayRow, ReportItemRow, ReportValueRow } from '../types/supabase';
import { addXpDelta } from './xpLedger';

const REPORT_DAYS_TABLE = 'report_days';
const REPORT_VALUES_TABLE = 'report_values';

type Client = ReturnType<typeof getSupabaseClient>;

export async function getOrCreateReportDay(
  params: { userId: string; templateId: string; localDate: string },
  client: Client = getSupabaseClient()
): Promise<ReportDayRow> {
  const { data, error } = await client
    .from(REPORT_DAYS_TABLE)
    .upsert(
      { user_id: params.userId, template_id: params.templateId, local_date: params.localDate },
      { onConflict: 'user_id,template_id,local_date' }
    )
    .select('*')
    .single();

  if (error || !data) {
    console.error({ scope: 'daily_report', event: 'day_upsert_error', params, error });
    throw new Error(`Failed to get or create report day: ${error?.message}`);
  }

  return data as ReportDayRow;
}

export async function listCompletionStatus(
  reportDayId: string,
  items: ReportItemRow[],
  client: Client = getSupabaseClient()
): Promise<{ item: ReportItemRow; filled: boolean; skipped: boolean; value?: ReportValueRow | null }[]> {
  const { data, error } = await client.from(REPORT_VALUES_TABLE).select('*').eq('report_day_id', reportDayId);

  if (error) {
    console.error({ scope: 'daily_report', event: 'values_list_error', reportDayId, error });
    throw new Error(`Failed to load report values: ${error.message}`);
  }

  const values = (data as ReportValueRow[]) ?? [];
  const lookup = new Map<string, ReportValueRow>();
  values.forEach((v) => lookup.set(v.item_id, v));

  return items.map((item) => {
    const value = lookup.get(item.id) ?? null;
    const skipped = Boolean(value?.value_json && (value.value_json as { skipped?: boolean }).skipped === true);
    const filled = Boolean(value && !skipped && value.value_json !== null);
    return { item, filled, skipped, value };
  });
}

const shouldApplyXp = (existing: ReportValueRow | null): boolean => !existing || existing.xp_delta_applied === false;

type XpMode = 'fixed' | 'per_minute' | 'per_number' | 'none';

const resolveXpMode = (xpMode?: string | null): XpMode => {
  if (xpMode === 'fixed') return 'fixed';
  if (xpMode === 'per_minute' || xpMode === 'time') return 'per_minute';
  if (xpMode === 'per_number') return 'per_number';
  return 'none';
};

const extractMinutes = (item: ReportItemRow, valueJson: Record<string, unknown> | null): number => {
  if (!valueJson) return 0;
  if (item.item_type === 'duration_minutes') {
    const minutes = Number((valueJson as { minutes?: number; value?: number }).minutes ?? (valueJson as { value?: number }).value ?? 0);
    return Number.isFinite(minutes) ? Math.max(0, minutes) : 0;
  }
  const minutesFromJson = Number((valueJson as { minutes?: number }).minutes ?? 0);
  if (Number.isFinite(minutesFromJson) && minutesFromJson > 0) return minutesFromJson;
  return 0;
};

const extractNumber = (valueJson: Record<string, unknown> | null): number => {
  if (!valueJson) return 0;
  const raw =
    Number(
      (valueJson as { units?: number }).units ??
        (valueJson as { number?: number }).number ??
        (valueJson as { value?: number }).value ??
        (valueJson as { count?: number }).count ??
        0
    );
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, raw);
};

const isBooleanTrue = (valueJson: Record<string, unknown> | null): boolean => {
  if (!valueJson) return false;
  const val = (valueJson as { value?: unknown; checked?: unknown }).value ?? (valueJson as { checked?: unknown }).checked;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val > 0;
  if (typeof val === 'string') {
    const normalized = val.trim().toLowerCase();
    return ['true', '1', 'yes', 'y', 'on', 'ok', 'done', '✅', '✔️'].includes(normalized);
  }
  return false;
};

const computeXpDelta = (item: ReportItemRow, valueJson: Record<string, unknown> | null): { delta: number; minutes: number; units: number } => {
  const xpMode = resolveXpMode(item.xp_mode);

  if (item.item_type === 'boolean') {
    const checked = isBooleanTrue(valueJson);
    if (!checked) return { delta: 0, minutes: 0, units: 0 };
    if (xpMode !== 'fixed') return { delta: 0, minutes: 0, units: 0 };
    const fixed = item.xp_value ?? 0;
    return { delta: fixed > 0 ? fixed : 0, minutes: 0, units: 0 };
  }

  if (xpMode === 'none') return { delta: 0, minutes: 0, units: 0 };
  if (xpMode === 'fixed') {
    const fixed = item.xp_value ?? 0;
    return { delta: fixed > 0 ? fixed : 0, minutes: 0, units: 0 };
  }
  if (xpMode === 'per_number') {
    const units = extractNumber(valueJson);
    const raw = units * (item.xp_value ?? 0);
    const capped = item.xp_max_per_day != null && item.xp_max_per_day > 0 ? Math.min(raw, item.xp_max_per_day) : raw;
    const delta = Math.max(0, Math.floor(capped));
    return { delta, minutes: 0, units };
  }
  const minutes = extractMinutes(item, valueJson);
  const perMinute = item.xp_value ?? 0;
  const raw = minutes * perMinute;
  const capped =
    item.xp_max_per_day != null && item.xp_max_per_day > 0 ? Math.min(raw, item.xp_max_per_day) : raw;
  const delta = Math.max(0, Math.floor(capped));
  return { delta, minutes, units: 0 };
};

export async function saveValue(
  params: {
    reportDayId: string;
    item: ReportItemRow;
    valueJson: Record<string, unknown> | null;
    userId: string;
  },
  client: Client = getSupabaseClient()
): Promise<ReportValueRow> {
  const { data: existing, error: existingError } = await client
    .from(REPORT_VALUES_TABLE)
    .select('*')
    .eq('report_day_id', params.reportDayId)
    .eq('item_id', params.item.id)
    .maybeSingle();

  if (existingError) {
    console.error({ scope: 'daily_report', event: 'value_load_error', params, error: existingError });
    throw new Error(`Failed to load report value: ${existingError.message}`);
  }

  const payload = {
    report_day_id: params.reportDayId,
    item_id: params.item.id,
    value_json: params.valueJson,
    xp_delta_applied: existing?.xp_delta_applied ?? false
  };

  const { data, error } = await client
    .from(REPORT_VALUES_TABLE)
    .upsert(payload, { onConflict: 'report_day_id,item_id' })
    .select('*')
    .single();

  if (error || !data) {
    console.error({ scope: 'daily_report', event: 'value_upsert_error', params, error });
    throw new Error(`Failed to save report value: ${error?.message}`);
  }

  const valueRow = data as ReportValueRow;

  if (shouldApplyXp(existing ?? null)) {
    const { delta, minutes, units } = computeXpDelta(params.item, params.valueJson);
    if (delta !== 0) {
      try {
        await addXpDelta({
          userId: params.userId,
          delta,
          reason: `report:${params.reportDayId}:${params.item.id}`,
          refType: 'daily_report',
          refId: params.item.id,
          metadata: {
            source_type: 'daily_report',
            item_id: params.item.id,
            xp_mode: resolveXpMode(params.item.xp_mode),
            minutes,
            units
          }
        });
        await client
          .from(REPORT_VALUES_TABLE)
          .update({ xp_delta_applied: true })
          .eq('id', valueRow.id);
      } catch (xpError) {
        console.error({ scope: 'daily_report', event: 'xp_apply_error', params, error: xpError });
      }
    }
  }

  return valueRow;
}

export type ReportDayRowWithCompletion = { day: ReportDayRow; completed: number; total: number; skipped: number };

const formatDate = (d: Date): string => d.toISOString().slice(0, 10);

export async function listRecentReportDays(
  params: { userId: string; range: '7d' | '30d' },
  client: Client = getSupabaseClient()
): Promise<ReportDayRowWithCompletion[]> {
  const days = params.range === '30d' ? 30 : 7;
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  const startDate = formatDate(start);

  const { data, error } = await client
    .from(REPORT_DAYS_TABLE)
    .select('*')
    .eq('user_id', params.userId)
    .gte('local_date', startDate)
    .order('local_date', { ascending: false });

  if (error) {
    console.error({ scope: 'daily_report', event: 'recent_days_error', params, error });
    throw new Error(`Failed to list recent report days: ${error.message}`);
  }

  const daysList = (data as ReportDayRow[]) ?? [];
  const result: ReportDayRowWithCompletion[] = [];

  for (const day of daysList) {
    const { data: itemsData, error: itemsError } = await client
      .from('report_items')
      .select('*')
      .eq('template_id', day.template_id)
      .eq('enabled', true)
      .order('sort_order', { ascending: true });

    if (itemsError) {
      console.error({ scope: 'daily_report', event: 'recent_items_error', dayId: day.id, error: itemsError });
      continue;
    }

    const items = (itemsData as ReportItemRow[]) ?? [];
    const statuses = await listCompletionStatus(day.id, items, client);
    const completed = statuses.filter((s) => s.filled).length;
    const skipped = statuses.filter((s) => s.skipped).length;
    result.push({ day, completed, skipped, total: statuses.length });
  }

  return result;
}

export async function listReportDaysByRange(
  params: { userId: string; startLocalDate: string; endLocalDate: string },
  client: Client = getSupabaseClient()
): Promise<ReportDayRow[]> {
  const { data, error } = await client
    .from(REPORT_DAYS_TABLE)
    .select('*')
    .eq('user_id', params.userId)
    .gte('local_date', params.startLocalDate)
    .lte('local_date', params.endLocalDate)
    .order('local_date', { ascending: false });

  if (error) {
    console.error({ scope: 'daily_report', event: 'days_range_error', params, error });
    throw new Error(`Failed to list report days: ${error.message}`);
  }

  return (data as ReportDayRow[]) ?? [];
}

export async function getReportDayById(reportDayId: string, client: Client = getSupabaseClient()): Promise<ReportDayRow | null> {
  const { data, error } = await client.from(REPORT_DAYS_TABLE).select('*').eq('id', reportDayId).maybeSingle();

  if (error) {
    console.error({ scope: 'daily_report', event: 'day_get_error', reportDayId, error });
    throw new Error(`Failed to load report day: ${error.message}`);
  }

  return (data as ReportDayRow | null) ?? null;
}

export async function lockReportDay(
  params: { reportDayId: string; userId?: string; reason?: string },
  client: Client = getSupabaseClient()
): Promise<ReportDayRow> {
  const query = client.from(REPORT_DAYS_TABLE).update({ locked: true }).eq('id', params.reportDayId);
  if (params.userId) query.eq('user_id', params.userId);
  const { data, error } = await query.select('*').maybeSingle();
  if (error) {
    console.error({ scope: 'daily_report', event: 'lock_error', reportDayId: params.reportDayId, error, reason: params.reason });
    throw new Error(`Failed to lock report day: ${error.message}`);
  }
  if (!data) {
    throw new Error('Report day not found');
  }
  return data as ReportDayRow;
}

export async function unlockReportDay(
  params: { reportDayId: string; userId: string },
  client: Client = getSupabaseClient()
): Promise<ReportDayRow> {
  const { data, error } = await client
    .from(REPORT_DAYS_TABLE)
    .update({ locked: false })
    .eq('id', params.reportDayId)
    .eq('user_id', params.userId)
    .select('*')
    .maybeSingle();
  if (error) {
    console.error({ scope: 'daily_report', event: 'unlock_error', params, error });
    throw new Error(`Failed to unlock report day: ${error.message}`);
  }
  if (!data) throw new Error('Report day not found');
  return data as ReportDayRow;
}

export async function getReportDayByDate(
  params: { userId: string; templateId: string; localDate: string },
  client: Client = getSupabaseClient()
): Promise<ReportDayRow | null> {
  const { data, error } = await client
    .from(REPORT_DAYS_TABLE)
    .select('*')
    .eq('user_id', params.userId)
    .eq('template_id', params.templateId)
    .eq('local_date', params.localDate)
    .maybeSingle();

  if (error) {
    console.error({ scope: 'daily_report', event: 'day_get_by_date_error', params, error });
    throw new Error(`Failed to load report day: ${error.message}`);
  }
  return (data as ReportDayRow | null) ?? null;
}

export async function autoLockIfCompleted(
  params: { reportDay: ReportDayRow; items: ReportItemRow[] },
  client: Client = getSupabaseClient()
): Promise<ReportDayRow> {
  const { reportDay, items } = params;
  if (reportDay.locked) return reportDay;
  const statuses = await listCompletionStatus(reportDay.id, items, client);
  const openCount = statuses.filter((s) => !s.filled && !s.skipped).length;
  if (openCount === 0) {
    return lockReportDay({ reportDayId: reportDay.id, userId: reportDay.user_id, reason: 'auto_midnight' }, client);
  }
  return reportDay;
}
