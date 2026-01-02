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

const computeTimeXp = (item: ReportItemRow, valueJson: Record<string, unknown> | null): number => {
  if (!valueJson || item.xp_mode !== 'time') return 0;
  const minutes = Number((valueJson as { minutes?: number }).minutes ?? 0);
  if (Number.isNaN(minutes) || minutes <= 0) return 0;
  const perMinute = item.xp_value ?? 0;
  return perMinute * minutes;
};

const shouldApplyXp = (existing: ReportValueRow | null): boolean => !existing || existing.xp_delta_applied === false;

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
    let delta = 0;
    if (params.item.xp_mode === 'fixed') {
      delta = params.item.xp_value ?? 0;
    } else if (params.item.xp_mode === 'time') {
      delta = computeTimeXp(params.item, params.valueJson);
    }

    if (delta !== 0) {
      try {
        await addXpDelta({
          userId: params.userId,
          delta,
          reason: `report:${params.reportDayId}:${params.item.id}`,
          refType: 'report_item',
          refId: params.item.id
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

export async function getReportDayById(reportDayId: string, client: Client = getSupabaseClient()): Promise<ReportDayRow | null> {
  const { data, error } = await client.from(REPORT_DAYS_TABLE).select('*').eq('id', reportDayId).maybeSingle();

  if (error) {
    console.error({ scope: 'daily_report', event: 'day_get_error', reportDayId, error });
    throw new Error(`Failed to load report day: ${error.message}`);
  }

  return (data as ReportDayRow | null) ?? null;
}

export async function lockReportDay(reportDayId: string, client: Client = getSupabaseClient()): Promise<ReportDayRow> {
  const { data, error } = await client.from(REPORT_DAYS_TABLE).update({ locked: true }).eq('id', reportDayId).select('*').maybeSingle();
  if (error) {
    console.error({ scope: 'daily_report', event: 'lock_error', reportDayId, error });
    throw new Error(`Failed to lock report day: ${error.message}`);
  }
  if (!data) {
    throw new Error('Report day not found');
  }
  return data as ReportDayRow;
}
