import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../db';
import type { Database, UserSettingsRow } from '../types/supabase';
import { resolveLocale, type Locale } from '../i18n';

const USER_SETTINGS_TABLE = 'user_settings';

const isMissing = (error: PostgrestError | null): boolean =>
  Boolean(error?.code === '42P01' || error?.message?.toLowerCase().includes('does not exist'));

const mergeSettingsJson = (existing: Record<string, unknown> | null | undefined, patch: Record<string, unknown>): Record<string, unknown> => ({
  ...(existing ?? {}),
  ...patch
});

export async function getOrCreateUserSettings(
  userId: string,
  client: SupabaseClient<Database> = getSupabaseClient()
): Promise<UserSettingsRow> {
  const { data, error } = await client.from(USER_SETTINGS_TABLE).select('*').eq('user_id', userId).maybeSingle();
  if (error && !isMissing(error)) {
    console.error({ scope: 'user_settings', event: 'fetch_error', userId, error });
    throw new Error(`Failed to load user settings: ${error.message}`);
  }

  if (data) return data as UserSettingsRow;

  const insertPayload: Database['public']['Tables']['user_settings']['Insert'] = {
    user_id: userId,
    onboarded: false
  };

  const { data: inserted, error: insertError } = await client.from(USER_SETTINGS_TABLE).insert(insertPayload).select('*').single();
  if (insertError) {
    console.error({ scope: 'user_settings', event: 'insert_error', userId, error: insertError });
    throw new Error(`Failed to create user settings: ${insertError.message}`);
  }

  return inserted as UserSettingsRow;
}

export const updateUserSettingsJson = async (
  userId: string,
  patch: Record<string, unknown>,
  client: SupabaseClient<Database> = getSupabaseClient()
): Promise<UserSettingsRow> => {
  const current = await getOrCreateUserSettings(userId, client);
  const nextJson = mergeSettingsJson(current.settings_json as Record<string, unknown> | null | undefined, patch);
  const { data, error } = await client
    .from(USER_SETTINGS_TABLE)
    .update({ settings_json: nextJson, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .select('*')
    .single();
  if (error || !data) {
    console.error({ scope: 'user_settings', event: 'update_json_error', userId, patch, error });
    throw new Error(`Failed to update user settings: ${error?.message}`);
  }
  return data as UserSettingsRow;
};

export async function setUserOnboarded(
  userId: string,
  client: SupabaseClient<Database> = getSupabaseClient()
): Promise<void> {
  const { error } = await client.from(USER_SETTINGS_TABLE).update({ onboarded: true, updated_at: new Date().toISOString() }).eq('user_id', userId);
  if (error) {
    console.error({ scope: 'user_settings', event: 'set_onboarded_error', userId, error });
    throw new Error(`Failed to update onboarding state: ${error.message}`);
  }
}

export const getLanguageFromSettings = (settings: UserSettingsRow): Locale =>
  resolveLocale(((settings.settings_json ?? {}) as { language_code?: string | null }).language_code ?? null);

export const setUserLanguageCode = async (
  userId: string,
  languageCode: Locale,
  client: SupabaseClient<Database> = getSupabaseClient()
): Promise<UserSettingsRow> => {
  return updateUserSettingsJson(userId, { language_code: languageCode }, client);
};
