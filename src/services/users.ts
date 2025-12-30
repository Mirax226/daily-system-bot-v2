import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../db';
import type { Database } from '../types/supabase';

export type UserRecord = Database['public']['Tables']['users']['Row'];

const USERS_TABLE = 'users';
const USERS_SELECT_FIELDS =
  'id, telegram_id, username, timezone, home_chat_id, home_message_id, settings_json, created_at, updated_at';

const handleSupabaseError = (error: PostgrestError, action: string): never => {
  console.error({
    scope: 'services/users',
    event: 'supabase_error',
    action,
    supabaseError: error
  });
  throw new Error(`Failed to ${action}: ${error.message}`);
};

export async function getUserByTelegramId(
  telegramId: string,
  supabaseClient: SupabaseClient<Database> = getSupabaseClient()
): Promise<UserRecord | null> {
  const { data, error } = await supabaseClient
    .from(USERS_TABLE)
    .select(USERS_SELECT_FIELDS)
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (error) {
    handleSupabaseError(error, 'fetch user by telegram_id');
  }

  return data ?? null;
}

export async function createUser(
  params: { telegramId: string; username?: string | null },
  supabaseClient: SupabaseClient<Database> = getSupabaseClient()
): Promise<UserRecord> {
  const { data, error } = await supabaseClient
    .from(USERS_TABLE)
    .insert({
      telegram_id: params.telegramId,
      username: params.username ?? null
    })
    .select(USERS_SELECT_FIELDS)
    .single();

  if (error) {
    handleSupabaseError(error, 'create user');
  }

  if (!data) {
    console.error({ scope: 'services/users', event: 'user_create_missing_data', telegramId: params.telegramId });
    throw new Error('Failed to create user: no data returned');
  }

  console.log({ scope: 'services/users', event: 'user_created', telegramId: params.telegramId, username: params.username ?? null });
  return data as UserRecord;
}

export async function ensureUser(
  params: { telegramId: string; username?: string | null },
  supabaseClient: SupabaseClient<Database> = getSupabaseClient()
): Promise<UserRecord> {
  const telegramId = params.telegramId;
  if (!telegramId) {
    throw new Error('telegramId is required');
  }

  const existing = await getUserByTelegramId(telegramId, supabaseClient);

  if (!existing) {
    return createUser({ telegramId, username: params.username ?? null }, supabaseClient);
  }

  const shouldUpdateUsername = typeof params.username !== 'undefined' && params.username !== existing.username;

  if (!shouldUpdateUsername) {
    console.log({ scope: 'services/users', event: 'user_found', telegramId });
    return existing;
  }

  const { data, error } = await supabaseClient
    .from(USERS_TABLE)
    .update({ username: params.username ?? null, updated_at: new Date().toISOString() })
    .eq('id', existing.id)
    .select(USERS_SELECT_FIELDS)
    .single();

  if (error) {
    handleSupabaseError(error, 'update user username');
  }

  if (!data) {
    console.error({ scope: 'services/users', event: 'user_update_missing_data', telegramId });
    throw new Error('Failed to reload user after update: no data returned');
  }

  console.log({ scope: 'services/users', event: 'user_username_updated', telegramId, username: params.username ?? null });
  return data as UserRecord;
}

export async function updateUserSettings(
  userId: string,
  settings: Record<string, unknown>,
  supabaseClient: SupabaseClient<Database> = getSupabaseClient()
): Promise<UserRecord | null> {
  const { data, error } = await supabaseClient
    .from(USERS_TABLE)
    .update({ settings_json: settings, updated_at: new Date().toISOString() })
    .eq('id', userId)
    .select(USERS_SELECT_FIELDS)
    .maybeSingle();

  if (error) {
    handleSupabaseError(error, 'update user settings');
  }

  return (data as UserRecord | null) ?? null;
}
