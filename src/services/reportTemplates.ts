import { getSupabaseClient } from '../db';
import type { ReportItemRow, ReportTemplateRow } from '../types/supabase';
import { getOrCreateUserSettings } from './userSettings';

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

export async function getTemplateById(templateId: string, client: Client = getSupabaseClient()): Promise<ReportTemplateRow | null> {
  const { data, error } = await client.from(REPORT_TEMPLATES_TABLE).select('*').eq('id', templateId).maybeSingle();
  if (error) {
    console.error({ scope: 'report_templates', event: 'template_get_error', templateId, error });
    throw new Error(`Failed to load report template: ${error.message}`);
  }
  return (data as ReportTemplateRow | null) ?? null;
}

export type TemplateWithCount = ReportTemplateRow & { itemCount: number };

export async function listUserTemplates(userId: string, client: Client = getSupabaseClient()): Promise<TemplateWithCount[]> {
  const { data, error } = await client
    .from(REPORT_TEMPLATES_TABLE)
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error({ scope: 'report_templates', event: 'list_user_error', userId, error });
    throw new Error(`Failed to list templates: ${error.message}`);
  }

  const templates = (data as ReportTemplateRow[]) ?? [];
  if (templates.length === 0) return [];

  const templateIds = templates.map((t) => t.id);
  const { data: itemsData, error: itemsError } = await client.from(REPORT_ITEMS_TABLE).select('id,template_id').in('template_id', templateIds);
  if (itemsError) {
    console.error({ scope: 'report_templates', event: 'list_user_items_error', userId, error: itemsError });
    throw new Error(`Failed to load template items: ${itemsError.message}`);
  }

  const counts = new Map<string, number>();
  (itemsData as { id: string; template_id: string }[] | null)?.forEach((row) => {
    counts.set(row.template_id, (counts.get(row.template_id) ?? 0) + 1);
  });

  return templates.map((t) => ({ ...t, itemCount: counts.get(t.id) ?? 0 }));
}

export async function setActiveTemplate(params: { userId: string; templateId: string }, client: Client = getSupabaseClient()): Promise<void> {
  const settings = await getOrCreateUserSettings(params.userId, client);
  const currentJson = (settings.settings_json as Record<string, unknown> | null) ?? {};
  const nextSettingsJson = { ...currentJson, active_template_id: params.templateId };
  const { error } = await client
    .from('user_settings')
    .update({ settings_json: nextSettingsJson, updated_at: new Date().toISOString() })
    .eq('id', settings.id);
  if (error) {
    console.error({ scope: 'report_templates', event: 'set_active_error', params, error });
    throw new Error(`Failed to set active template: ${error.message}`);
  }
}

export async function deleteTemplate(params: { userId: string; templateId: string }, client: Client = getSupabaseClient()): Promise<void> {
  const { error } = await client.from(REPORT_TEMPLATES_TABLE).delete().eq('id', params.templateId).eq('user_id', params.userId);
  if (error) {
    console.error({ scope: 'report_templates', event: 'delete_error', params, error });
    throw new Error(`Failed to delete template: ${error.message}`);
  }
}

export async function createUserTemplate(
  params: { userId: string; title: string },
  client: Client = getSupabaseClient()
): Promise<ReportTemplateRow> {
  const payload = { user_id: params.userId, title: params.title };
  const { data, error } = await client.from(REPORT_TEMPLATES_TABLE).insert(payload).select('*').single();
  if (error || !data) {
    console.error({ scope: 'report_templates', event: 'create_error', params, error });
    throw new Error(`Failed to create template: ${error?.message}`);
  }
  return data as ReportTemplateRow;
}

export async function duplicateTemplate(
  params: { userId: string; sourceTemplateId: string; newTitle?: string; copySuffix?: string; copyBaseTitle?: string },
  client: Client = getSupabaseClient()
): Promise<ReportTemplateRow> {
  const existing = await getTemplateById(params.sourceTemplateId, client);
  if (!existing || existing.user_id !== params.userId) {
    throw new Error('Template not found');
  }

  const suffix = params.copySuffix ?? ' (copy)';
  const baseTitle = existing.title ?? params.copyBaseTitle ?? 'Template';
  const title = params.newTitle ?? `${baseTitle}${suffix}`;
  const newTemplatePayload = { user_id: params.userId, title };
  const { data: inserted, error: insertError } = await client.from(REPORT_TEMPLATES_TABLE).insert(newTemplatePayload).select('*').single();
  if (insertError || !inserted) {
    console.error({ scope: 'report_templates', event: 'duplicate_insert_error', params, error: insertError });
    throw new Error(`Failed to duplicate template: ${insertError?.message}`);
  }
  const newTemplate = inserted as ReportTemplateRow;

  const { data: items, error: itemsError } = await client
    .from(REPORT_ITEMS_TABLE)
    .select('*')
    .eq('template_id', params.sourceTemplateId)
    .order('sort_order', { ascending: true });
  if (itemsError) {
    console.error({ scope: 'report_templates', event: 'duplicate_items_error', params, error: itemsError });
    throw new Error(`Failed to copy template items: ${itemsError.message}`);
  }

  const itemsPayload = (items as ReportItemRow[]).map((item) => ({
    template_id: newTemplate.id,
    label: item.label,
    item_key: item.item_key,
    item_type: item.item_type,
    category: item.category,
    xp_mode: item.xp_mode,
    xp_value: item.xp_value,
    options_json: item.options_json ?? {},
    sort_order: item.sort_order,
    enabled: item.enabled
  }));

  if (itemsPayload.length > 0) {
    const { error: insertItemsError } = await client.from(REPORT_ITEMS_TABLE).insert(itemsPayload);
    if (insertItemsError) {
      console.error({ scope: 'report_templates', event: 'duplicate_items_insert_error', params, error: insertItemsError });
    }
  }

  return newTemplate;
}
