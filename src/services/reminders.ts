import type { Bot } from 'grammy';
import { getSupabaseClient } from '../db';
import type { Database, ReminderRow } from '../types/supabase';

const REMINDERS_TABLE = 'reminders';
const USERS_TABLE = 'users';

export type UserRow = Database['public']['Tables']['users']['Row'];

function toIsoString(date: Date): string {
  return date.toISOString();
}

export async function findDueReminders(
  nowUtc: Date,
  client = getSupabaseClient()
): Promise<ReminderRow[]> {
  const { data, error } = await client
    .from(REMINDERS_TABLE)
    .select('*')
    .eq('enabled', true)
    .not('next_run_at_utc', 'is', null)
    .lte('next_run_at_utc', toIsoString(nowUtc));

  if (error) {
    throw new Error(`Failed to find due reminders: ${error.message}`);
  }

  return data ?? [];
}

export async function loadUser(userId: string, client = getSupabaseClient()): Promise<UserRow | null> {
  const { data, error } = await client
    .from(USERS_TABLE)
    .select('id, telegram_id, username, timezone, home_chat_id, home_message_id, settings_json, created_at, updated_at')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load user ${userId}: ${error.message}`);
  }

  return data ?? null;
}

export async function sendReminderMessage(params: {
  reminder: ReminderRow;
  user: UserRow;
  botClient: Bot;
}): Promise<void> {
  const { reminder, user, botClient } = params;
  const chatId = user.telegram_id;

  if (!chatId) {
    console.log({ scope: 'reminders', event: 'reminder_skipped', reason: 'missing_telegram_id', reminderId: reminder.id, userId: user.id });
    return;
  }

  const lines = [`⏰ یادآوری: ${reminder.title}`];
  if (reminder.detail) {
    lines.push('', reminder.detail);
  }

  const text = lines.join('\n');

  await botClient.api.sendMessage(chatId, text);
}

export async function processDueReminders(
  nowUtc: Date,
  botClient: Bot,
  client = getSupabaseClient()
): Promise<{ processed: string[] }> {
  console.log({ scope: 'reminders', event: 'reminder_due', timestamp: toIsoString(nowUtc) });

  const reminders = await findDueReminders(nowUtc, client);
  const processed: string[] = [];

  for (const reminder of reminders) {
    try {
      const user = await loadUser(reminder.user_id, client);
      if (!user || !user.telegram_id) {
        console.log({ scope: 'reminders', event: 'reminder_skipped', reminderId: reminder.id, userId: reminder.user_id, reason: 'user_missing_or_no_telegram_id' });
        continue;
      }

      const { data: updatedRow, error: updateError } = await client
        .from(REMINDERS_TABLE)
        .update({
          last_sent_at_utc: toIsoString(nowUtc),
          next_run_at_utc: null,
          enabled: false,
          updated_at: toIsoString(nowUtc)
        })
        .eq('id', reminder.id)
        .is('last_sent_at_utc', null)
        .select('id')
        .maybeSingle();

      if (updateError) {
        throw new Error(`Failed to mark reminder as sent: ${updateError.message}`);
      }

      if (!updatedRow) {
        console.log({ scope: 'reminders', event: 'already_processed', reminderId: reminder.id, userId: reminder.user_id });
        continue;
      }

      await sendReminderMessage({ reminder, user, botClient });

      console.log({
        scope: 'reminders',
        event: 'reminder_sent',
        reminderId: reminder.id,
        userId: reminder.user_id,
        telegramId: user.telegram_id
      });

      processed.push(reminder.id);
    } catch (error) {
      console.error({ scope: 'reminders', event: 'reminder_error', reminderId: reminder.id, userId: reminder.user_id, error });
    }
  }

  return { processed };
}

export async function listUpcomingRemindersForUser(
  userId: string,
  limit = 10,
  client = getSupabaseClient()
): Promise<ReminderRow[]> {
  const { data, error } = await client
    .from(REMINDERS_TABLE)
    .select('*')
    .eq('user_id', userId)
    .eq('enabled', true)
    .not('next_run_at_utc', 'is', null)
    .order('next_run_at_utc', { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to list reminders: ${error.message}`);
  }

  return data ?? [];
}
