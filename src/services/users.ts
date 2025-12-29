import { getSupabaseClient } from '../db';
import { config } from '../config';
import type { Database } from '../types/supabase';

export type UsersTable = Database['public']['Tables']['users'];
export type UserRecord = UsersTable['Row'];

export async function getUserByTelegramId(telegramId: string, supabase = getSupabaseClient()): Promise<UserRecord | null> {
  const { data, error } = await supabase
    .from('users')
    .select('id, telegram_id, username, timezone, created_at, updated_at')
    .eq('telegram_id', telegramId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ?? null;
}

export async function createUser(
  params: { telegramId: string; username: string | null; timezone?: string },
  supabase = getSupabaseClient()
): Promise<UserRecord> {
  const timezone = params.timezone ?? config.defaultTimezone;

  const { data, error } = await supabase
    .from('users')
    .insert({
      telegram_id: params.telegramId,
      username: params.username,
      timezone
    })
    .select('id, telegram_id, username, timezone, created_at, updated_at')
    .single();

  if (error) {
    throw error;
  }

  console.log({ scope: 'services/users', event: 'user_created', telegramId: params.telegramId, username: params.username });
  return data;
}

export async function updateUsernameIfChanged(
  userId: string,
  telegramId: string,
  currentUsername: string | null,
  nextUsername: string | null | undefined,
  supabase = getSupabaseClient()
): Promise<UserRecord | null> {
  if (!nextUsername || nextUsername === currentUsername) {
    return getUserByTelegramId(telegramId, supabase);
  }

  const { data, error } = await supabase
    .from('users')
    .update({ username: nextUsername, updated_at: new Date().toISOString() })
    .eq('id', userId)
    .select('id, telegram_id, username, timezone, created_at, updated_at')
    .single();

  if (error) {
    throw error;
  }

  console.log({ scope: 'services/users', event: 'user_username_updated', telegramId, username: nextUsername });
  return data;
}

export async function ensureUser(
  params: { telegramId: string | undefined; username: string | null; timezone?: string },
  supabase = getSupabaseClient()
): Promise<UserRecord> {
  const telegramId = params.telegramId;

  if (!telegramId) {
    throw new Error('telegramId is required');
  }

  const existing = await getUserByTelegramId(telegramId, supabase);

  if (existing) {
    const updated = await updateUsernameIfChanged(existing.id, telegramId, existing.username, params.username, supabase);
    return updated ?? existing;
  }

  return createUser({ telegramId, username: params.username, timezone: params.timezone }, supabase);
}
