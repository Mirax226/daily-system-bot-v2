import { getSupabaseClient } from '../db';
import type { Database } from '../types/supabase';

export type UserRecord = Database['public']['Tables']['users']['Row'];

function handleSupabaseError(context: string, error: unknown): never {
  const message = error instanceof Error ? error.message : 'Unknown error';
  throw new Error(`${context}: ${message}`);
}

export async function getUserByTelegramId(telegramId: string): Promise<UserRecord | null> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('users')
    .select('id, telegram_id, username, timezone, home_chat_id, home_message_id, settings_json, created_at, updated_at')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (error) {
    handleSupabaseError('Failed to fetch user', error);
  }

  return data ?? null;
}

export async function createUser(params: { telegramId: string; username?: string | null }): Promise<UserRecord> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('users')
    .insert({
      telegram_id: params.telegramId,
      username: params.username ?? null
    })
    .select('id, telegram_id, username, timezone, home_chat_id, home_message_id, settings_json, created_at, updated_at')
    .single();

  if (error) {
    handleSupabaseError('Failed to create user', error);
  }

  console.log({ scope: 'services/users', event: 'user_created', telegramId: params.telegramId, username: params.username ?? null });
  return data as UserRecord;
}

export async function ensureUser(params: { telegramId: string; username?: string | null }): Promise<UserRecord> {
  const telegramId = params.telegramId;
  if (!telegramId) {
    throw new Error('telegramId is required');
  }

  const existing = await getUserByTelegramId(telegramId);

  if (!existing) {
    return createUser({ telegramId, username: params.username ?? null });
  }

  const shouldUpdateUsername = typeof params.username !== 'undefined' && params.username !== existing.username;

  if (!shouldUpdateUsername) {
    return existing;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('users')
    .update({ username: params.username ?? null, updated_at: new Date().toISOString() })
    .eq('id', existing.id)
    .select('id, telegram_id, username, timezone, home_chat_id, home_message_id, settings_json, created_at, updated_at')
    .single();

  if (error) {
    handleSupabaseError('Failed to update user', error);
  }

  console.log({ scope: 'services/users', event: 'user_username_updated', telegramId, username: params.username ?? null });
  return data as UserRecord;
}
