import { randomUUID } from 'crypto';
import { getSupabaseClient } from '../db';
import type { ReportItemRow } from '../types/supabase';
import { getOrCreateUserSettings } from './userSettings';
import { listUserTemplates, listAllItems } from './reportTemplates';

export type TemplateCategory = {
  id: string;
  name: string;
  emoji: string;
  sortOrder: number;
};

type Client = ReturnType<typeof getSupabaseClient>;

const DEFAULT_CATEGORIES: TemplateCategory[] = [
  { id: 'sleep', name: 'sleep', emoji: '😴', sortOrder: 10 },
  { id: 'routine', name: 'routine', emoji: '🔁', sortOrder: 20 },
  { id: 'study', name: 'study', emoji: '📚', sortOrder: 30 },
  { id: 'tasks', name: 'tasks', emoji: '✅', sortOrder: 40 },
  { id: 'other', name: 'other', emoji: '🏷', sortOrder: 50 }
];

const isValidCategory = (input: unknown): input is TemplateCategory =>
  Boolean(
    input &&
      typeof input === 'object' &&
      typeof (input as TemplateCategory).id === 'string' &&
      typeof (input as TemplateCategory).name === 'string' &&
      typeof (input as TemplateCategory).emoji === 'string' &&
      typeof (input as TemplateCategory).sortOrder === 'number'
  );

const normalizeFromSettings = (settingsJson?: Record<string, unknown> | null): TemplateCategory[] => {
  const raw = (settingsJson as { templateCategories?: unknown } | null)?.templateCategories;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidCategory).sort((a, b) => a.sortOrder - b.sortOrder);
};

const inferFromItems = async (userId: string, client: Client): Promise<TemplateCategory[]> => {
  const templates = await listUserTemplates(userId, client);
  if (templates.length === 0) return [];

  const templateIds = templates.map((tpl) => tpl.id);
  const uniqueCategories = new Set<string>();
  for (const tplId of templateIds) {
    const items = await listAllItems(tplId, client);
    (items as ReportItemRow[]).forEach((item) => {
      if (item.category) uniqueCategories.add(item.category);
    });
  }

  if (uniqueCategories.size === 0) return [];

  const sorted = Array.from(uniqueCategories).sort();
  return sorted.map<TemplateCategory>((name, idx) => ({
    id: randomUUID(),
    name,
    emoji: '🏷',
    sortOrder: (idx + 1) * 10
  }));
};

const persistCategories = async (userId: string, categories: TemplateCategory[], client: Client): Promise<void> => {
  const settings = await getOrCreateUserSettings(userId, client);
  const current = (settings.settings_json ?? {}) as Record<string, unknown>;
  const next = { ...current, templateCategories: categories };
  const { error } = await client
    .from('user_settings')
    .update({ settings_json: next, updated_at: new Date().toISOString() })
    .eq('id', settings.id);
  if (error) {
    console.error({ scope: 'template_categories', event: 'persist_error', userId, error });
    throw new Error(`Failed to save categories: ${error.message}`);
  }
};

export async function getTemplateCategories(userId: string, client: Client = getSupabaseClient()): Promise<TemplateCategory[]> {
  const settings = await getOrCreateUserSettings(userId, client);
  const fromSettings = normalizeFromSettings(settings.settings_json as Record<string, unknown>);
  if (fromSettings.length > 0) return fromSettings;

  const inferred = await inferFromItems(userId, client);
  if (inferred.length > 0) {
    await persistCategories(userId, inferred, client);
    return inferred;
  }

  await persistCategories(userId, DEFAULT_CATEGORIES, client);
  return DEFAULT_CATEGORIES;
}

export async function saveTemplateCategories(
  userId: string,
  categories: TemplateCategory[],
  client: Client = getSupabaseClient()
): Promise<void> {
  const normalized = categories
    .filter(isValidCategory)
    .map((cat, idx) => ({
      ...cat,
      sortOrder: typeof cat.sortOrder === 'number' ? cat.sortOrder : (idx + 1) * 10
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder);

  await persistCategories(userId, normalized, client);
}

export const isDefaultCategoryName = (name?: string | null): boolean => {
  if (!name) return false;
  const lower = name.toLowerCase();
  return DEFAULT_CATEGORIES.some((cat) => cat.name.toLowerCase() === lower);
};

export const ensureFallbackCategory = (categories: TemplateCategory[]): TemplateCategory => {
  const existing = categories.find((cat) => cat.name.toLowerCase() === 'other');
  if (existing) return existing;
  return { id: randomUUID(), name: 'other', emoji: '🏷', sortOrder: (categories.length + 1) * 10 };
};
