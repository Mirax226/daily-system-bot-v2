import { getSupabaseClient } from '../db';
import type { ReportItemRow, ReportTemplateRow } from '../types/supabase';

const REPORT_TEMPLATES_TABLE = 'report_templates';
const REPORT_ITEMS_TABLE = 'report_items';

type Client = ReturnType<typeof getSupabaseClient>;

const defaultItems = (templateId: string): Omit<ReportItemRow, 'id' | 'created_at' | 'updated_at'>[] => [
  {
    template_id: templateId,
    label: 'Bed Time',
    item_key: 'bed_time',
    item_type: 'time_hhmm',
    category: 'sleep',
    xp_mode: 'fixed',
    xp_value: 5,
    options_json: {},
    sort_order: 10,
    enabled: true
  },
  {
    template_id: templateId,
    label: 'Wake Time',
    item_key: 'wake_time',
    item_type: 'time_hhmm',
    category: 'sleep',
    xp_mode: 'fixed',
    xp_value: 5,
    options_json: {},
    sort_order: 20,
    enabled: true
  },
  {
    template_id: templateId,
    label: 'Routine Completed',
    item_key: 'routine_done',
    item_type: 'boolean',
    category: 'routine',
    xp_mode: 'fixed',
    xp_value: 10,
    options_json: {},
    sort_order: 30,
    enabled: true
  },
  {
    template_id: templateId,
    label: 'Study Session (minutes)',
    item_key: 'study_minutes',
    item_type: 'number',
    category: 'study',
    xp_mode: 'time',
    xp_value: 1,
    options_json: { study_mode: 'minutes' },
    sort_order: 40,
    enabled: true
  }
];

export async function ensureDefaultTemplate(userId: string, client: Client = getSupabaseClient()): Promise<ReportTemplateRow> {
  const { data, error } = await client
    .from(REPORT_TEMPLATES_TABLE)
    .select('*')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error({ scope: 'report_templates', event: 'template_load_error', userId, error });
    throw new Error(`Failed to load report template: ${error.message}`);
  }

  if (data) return data as ReportTemplateRow;

  const insertPayload = { user_id: userId, title: 'Daily Report' };
  const { data: inserted, error: insertError } = await client.from(REPORT_TEMPLATES_TABLE).insert(insertPayload).select('*').single();
  if (insertError || !inserted) {
    console.error({ scope: 'report_templates', event: 'template_insert_error', userId, error: insertError });
    throw new Error(`Failed to create default report template: ${insertError?.message}`);
  }
  return inserted as ReportTemplateRow;
}

export async function ensureDefaultItems(userId: string, client: Client = getSupabaseClient()): Promise<ReportItemRow[]> {
  const template = await ensureDefaultTemplate(userId, client);
  const { data: existing, error: listError } = await client
    .from(REPORT_ITEMS_TABLE)
    .select('*')
    .eq('template_id', template.id)
    .order('sort_order', { ascending: true });

  if (listError) {
    console.error({ scope: 'report_templates', event: 'items_load_error', templateId: template.id, error: listError });
    throw new Error(`Failed to load report items: ${listError.message}`);
  }

  if (existing && existing.length > 0) return existing as ReportItemRow[];

  const seeds = defaultItems(template.id).map((item) => ({
    ...item
  }));

  const { data: inserted, error: insertError } = await client.from(REPORT_ITEMS_TABLE).insert(seeds).select('*');
  if (insertError) {
    console.error({ scope: 'report_templates', event: 'items_insert_error', templateId: template.id, error: insertError });
    throw new Error(`Failed to seed default report items: ${insertError.message}`);
  }

  return (inserted as ReportItemRow[]) ?? [];
}

export async function listItems(templateId: string, client: Client = getSupabaseClient()): Promise<ReportItemRow[]> {
  const { data, error } = await client
    .from(REPORT_ITEMS_TABLE)
    .select('*')
    .eq('template_id', templateId)
    .eq('enabled', true)
    .order('sort_order', { ascending: true });

  if (error) {
    console.error({ scope: 'report_templates', event: 'items_list_error', templateId, error });
    throw new Error(`Failed to list report items: ${error.message}`);
  }

  return (data as ReportItemRow[]) ?? [];
}

export async function upsertItem(
  params: {
    templateId: string;
    label: string;
    itemKey: string;
    itemType: string;
    category?: string | null;
    xpMode?: string | null;
    xpValue?: number | null;
    optionsJson?: Record<string, unknown>;
    sortOrder?: number;
  },
  client: Client = getSupabaseClient()
): Promise<ReportItemRow> {
  const payload = {
    template_id: params.templateId,
    label: params.label,
    item_key: params.itemKey,
    item_type: params.itemType,
    category: params.category ?? null,
    xp_mode: params.xpMode ?? null,
    xp_value: params.xpValue ?? null,
    options_json: params.optionsJson ?? {},
    sort_order: params.sortOrder ?? 0,
    enabled: true
  };

  const { data, error } = await client
    .from(REPORT_ITEMS_TABLE)
    .upsert(payload, { onConflict: 'template_id,item_key' })
    .select('*')
    .single();

  if (error || !data) {
    console.error({ scope: 'report_templates', event: 'item_upsert_error', payload, error });
    throw new Error(`Failed to upsert report item: ${error?.message}`);
  }

  return data as ReportItemRow;
}
