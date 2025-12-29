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

export async function listRemindersForUser(userId: string, client = getSupabaseClient()): Promise<ReminderRow[]> {
  const { data, error } = await client
    .from(REMINDERS_TABLE)
    .select('*')
    .eq('user_id', userId)
    .order('next_run_at_utc', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to list reminders: ${error.message}`);
  }

  return (data as ReminderRow[]) ?? [];
}

export async function getReminderById(reminderId: string, client = getSupabaseClient()): Promise<ReminderRow | null> {
  const { data, error } = await client.from(REMINDERS_TABLE).select('*').eq('id', reminderId).maybeSingle();

  if (error) {
    throw new Error(`Failed to load reminder: ${error.message}`);
  }

  return data ?? null;
}

export async function createReminder(
  userId: string,
  title: string,
  detail: string | null,
  nextRunUtc: Date,
  client = getSupabaseClient()
): Promise<ReminderRow> {
  const { data, error } = await client
    .from(REMINDERS_TABLE)
    .insert({
      user_id: userId,
      title,
      detail,
      next_run_at_utc: toIsoString(nextRunUtc),
      last_sent_at_utc: null,
      enabled: true
    })
    .select('*')
    .single();

  if (error) {
    throw new Error(`Failed to create reminder: ${error.message}`);
  }

  return data as ReminderRow;
}

export async function updateReminder(
  reminderId: string,
  patch: { title?: string; detail?: string | null; nextRunAtUtc?: Date | null; enabled?: boolean },
  client = getSupabaseClient()
): Promise<ReminderRow> {
  const updates: Record<string, unknown> = {
    updated_at: toIsoString(new Date())
  };

  if (typeof patch.title !== 'undefined') updates.title = patch.title;
  if (typeof patch.detail !== 'undefined') updates.detail = patch.detail;
  if (typeof patch.enabled !== 'undefined') updates.enabled = patch.enabled;
  if ('nextRunAtUtc' in patch) updates.next_run_at_utc = patch.nextRunAtUtc ? toIsoString(patch.nextRunAtUtc) : null;

  const { data, error } = await client
    .from(REMINDERS_TABLE)
    .update(updates)
    .eq('id', reminderId)
    .select('*')
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to update reminder: ${error.message}`);
  }

  if (!data) {
    throw new Error('Failed to update reminder: no data returned');
  }

  return data as ReminderRow;
}

export async function toggleReminderEnabled(reminderId: string, client = getSupabaseClient()): Promise<ReminderRow> {
  const current = await getReminderById(reminderId, client);
  if (!current) {
    throw new Error('Reminder not found');
  }

  const nextEnabled = !current.enabled;
  return updateReminder(reminderId, { enabled: nextEnabled }, client);
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

export async function sendReminderMessage(params: { reminder: ReminderRow; user: UserRow; botClient: Bot }): Promise<void> {
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

export async function deleteReminder(reminderId: string, client = getSupabaseClient()): Promise<void> {
  const { error } = await client.from(REMINDERS_TABLE).delete().eq('id', reminderId);

  if (error) {
    throw new Error(`Failed to delete reminder: ${error.message}`);
  }
}
