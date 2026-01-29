import type { Bot } from 'grammy';

import { config } from '../config';
import { listArchiveMessagesByGroupKey } from './archive';
import { getSupabaseClient, queryDb } from '../db';
import type { Database, ReminderRow } from '../types/supabase';
import { sendAttachmentsWithApi } from './telegram-media';
import { logWarn } from '../utils/logger';
import { safeTruncate } from '../utils/safe_truncate';
import { labels } from '../ui/labels';
import { formatInstantToLocal, localDateTimeToUtcIso } from '../utils/time';

const REMINDERS_TABLE = 'reminders';
const REMINDERS_ATTACHMENTS_TABLE = 'reminders_attachments';
const USERS_TABLE = 'users';
const ARCHIVE_COPY_DELAY_MS = 200;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type ReminderScheduleType = 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly';

export type ReminderSchedule = {
  scheduleType: ReminderScheduleType;
  timezone: string;
  onceAt?: Date | null;
  intervalMinutes?: number | null;
  atTime?: string | null;
  byWeekday?: number | null;
  byMonthday?: number | null;
  byMonth?: number | null;
};

export type UserRow = Database['public']['Tables']['users']['Row'];
export type ReminderAttachmentRow = Database['public']['Tables']['reminders_attachments']['Row'];

function toIsoString(date: Date): string {
  return date.toISOString();
}

const parseTimeToMinutes = (value?: string | null): number | null => {
  if (!value) return null;
  const [hh, mm] = value.split(':').map(Number);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
};

const formatMinutesToTime = (minutes: number): string => {
  const total = ((minutes % 1440) + 1440) % 1440;
  const hh = Math.floor(total / 60)
    .toString()
    .padStart(2, '0');
  const mm = Math.floor(total % 60)
    .toString()
    .padStart(2, '0');
  return `${hh}:${mm}`;
};

const getLocalWeekdayIndex = (date: Date, timezone: string): number => {
  const label = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(date);
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[label] ?? 0;
};

const addDaysToLocalDate = (localDate: string, days: number, timezone: string): string => {
  const utcIso = localDateTimeToUtcIso(localDate, '00:00', timezone);
  const next = new Date(new Date(utcIso).getTime() + days * 24 * 60 * 60 * 1000);
  return formatInstantToLocal(next.toISOString(), timezone).date;
};

const getLastDayOfMonth = (year: number, month: number): number => {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
};

const computeNextLocalDateForMonthly = (localDate: string, dayOfMonth: number): string => {
  const [year, month] = localDate.split('-').map(Number);
  const currentDay = Number(localDate.split('-')[2]);
  const lastDayCurrent = getLastDayOfMonth(year, month);
  const desiredDay = Math.min(Math.max(1, dayOfMonth), lastDayCurrent);
  if (currentDay <= desiredDay) {
    return `${year}-${String(month).padStart(2, '0')}-${String(desiredDay).padStart(2, '0')}`;
  }
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const lastDayNext = getLastDayOfMonth(nextYear, nextMonth);
  const nextDay = Math.min(Math.max(1, dayOfMonth), lastDayNext);
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(nextDay).padStart(2, '0')}`;
};

const computeNextLocalDateForYearly = (localDate: string, byMonth: number, byMonthday: number): string => {
  const [year] = localDate.split('-').map(Number);
  const currentMonth = Number(localDate.split('-')[1]);
  const currentDay = Number(localDate.split('-')[2]);
  const targetMonth = Math.min(Math.max(1, byMonth), 12);
  const lastDayTarget = getLastDayOfMonth(year, targetMonth);
  const targetDay = Math.min(Math.max(1, byMonthday), lastDayTarget);
  if (currentMonth < targetMonth || (currentMonth === targetMonth && currentDay <= targetDay)) {
    return `${year}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
  }
  const nextYear = year + 1;
  const lastDayNext = getLastDayOfMonth(nextYear, targetMonth);
  const nextDay = Math.min(Math.max(1, byMonthday), lastDayNext);
  return `${nextYear}-${String(targetMonth).padStart(2, '0')}-${String(nextDay).padStart(2, '0')}`;
};

export const computeNextRunAt = (schedule: ReminderSchedule, nowUtc: Date): Date | null => {
  const timezone = schedule.timezone || config.defaultTimezone;

  if (schedule.scheduleType === 'once') {
    return schedule.onceAt ?? null;
  }

  if (schedule.scheduleType === 'hourly') {
    const interval = schedule.intervalMinutes && schedule.intervalMinutes > 0 ? schedule.intervalMinutes : 60;
    return new Date(nowUtc.getTime() + interval * 60 * 1000);
  }

  const atMinutes = parseTimeToMinutes(schedule.atTime) ?? 9 * 60;
  const atTime = formatMinutesToTime(atMinutes);
  const localNow = formatInstantToLocal(nowUtc.toISOString(), timezone);
  const nowMinutes = parseTimeToMinutes(localNow.time) ?? 0;

  if (schedule.scheduleType === 'daily') {
    const nextDate = nowMinutes <= atMinutes ? localNow.date : addDaysToLocalDate(localNow.date, 1, timezone);
    return new Date(localDateTimeToUtcIso(nextDate, atTime, timezone));
  }

  if (schedule.scheduleType === 'weekly') {
    const targetWeekday = schedule.byWeekday ?? 0;
    const currentWeekday = getLocalWeekdayIndex(nowUtc, timezone);
    let delta = (targetWeekday - currentWeekday + 7) % 7;
    if (delta === 0 && nowMinutes > atMinutes) {
      delta = 7;
    }
    const nextDate = addDaysToLocalDate(localNow.date, delta, timezone);
    return new Date(localDateTimeToUtcIso(nextDate, atTime, timezone));
  }

  if (schedule.scheduleType === 'monthly') {
    const desiredDay = schedule.byMonthday ?? 1;
    const nextDate = computeNextLocalDateForMonthly(localNow.date, desiredDay);
    const isToday = nextDate === localNow.date;
    if (isToday && nowMinutes > atMinutes) {
      const [year, month] = localNow.date.split('-').map(Number);
      const nextMonth = month === 12 ? 1 : month + 1;
      const nextYear = month === 12 ? year + 1 : year;
      const lastDayNext = getLastDayOfMonth(nextYear, nextMonth);
      const nextDay = Math.min(Math.max(1, desiredDay), lastDayNext);
      const nextLocal = `${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(nextDay).padStart(2, '0')}`;
      return new Date(localDateTimeToUtcIso(nextLocal, atTime, timezone));
    }
    return new Date(localDateTimeToUtcIso(nextDate, atTime, timezone));
  }

  if (schedule.scheduleType === 'yearly') {
    const targetMonth = schedule.byMonth ?? 1;
    const targetDay = schedule.byMonthday ?? 1;
    let nextDate = computeNextLocalDateForYearly(localNow.date, targetMonth, targetDay);
    const isToday = nextDate === localNow.date;
    if (isToday && nowMinutes > atMinutes) {
      const [year] = localNow.date.split('-').map(Number);
      const nextYear = year + 1;
      const lastDay = getLastDayOfMonth(nextYear, Math.min(Math.max(1, targetMonth), 12));
      const nextDay = Math.min(Math.max(1, targetDay), lastDay);
      nextDate = `${nextYear}-${String(targetMonth).padStart(2, '0')}-${String(nextDay).padStart(2, '0')}`;
    }
    return new Date(localDateTimeToUtcIso(nextDate, atTime, timezone));
  }

  return null;
};

export async function findDueReminders(
  nowUtc: Date,
  client = getSupabaseClient()
): Promise<ReminderRow[]> {
  const { data, error } = await client
    .from(REMINDERS_TABLE)
    .select('*')
    .eq('is_active', true)
    .is('deleted_at', null)
    .not('next_run_at', 'is', null)
    .lte('next_run_at', toIsoString(nowUtc));

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
    .neq('status', 'draft')
    .is('deleted_at', null)
    .order('next_run_at', { ascending: true, nullsFirst: false })
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

export async function createReminderDraft(
  params: { userId: string; title: string | null; timezone: string },
  client = getSupabaseClient()
): Promise<ReminderRow> {
  const { data, error } = await client
    .from(REMINDERS_TABLE)
    .insert({
      user_id: params.userId,
      title: params.title ?? null,
      description: null,
      schedule_type: 'once',
      timezone: params.timezone,
      next_run_at: null,
      once_at: null,
      interval_minutes: null,
      at_time: null,
      by_weekday: null,
      by_monthday: null,
      by_month: null,
      is_active: false,
      enabled: false,
      status: 'draft'
    })
    .select('*')
    .single();

  if (error) {
    throw new Error(`Failed to create reminder draft: ${error.message}`);
  }

  return data as ReminderRow;
}

export async function createReminder(
  params: {
    userId: string;
    title: string | null;
    description?: string | null;
    descGroupKey?: string | null;
    schedule: ReminderSchedule;
    nextRunAt: Date | null;
    status?: string;
    isActive?: boolean;
    enabled?: boolean;
    archiveItemId?: string | null;
  },
  client = getSupabaseClient()
): Promise<ReminderRow> {
  const { userId, title, description, descGroupKey, schedule, nextRunAt, status, isActive, enabled, archiveItemId } = params;
  const { data, error } = await client
    .from(REMINDERS_TABLE)
    .insert({
      user_id: userId,
      title,
      description: description ?? null,
      desc_group_key: descGroupKey ?? null,
      archive_item_id: archiveItemId ?? null,
      schedule_type: schedule.scheduleType,
      timezone: schedule.timezone,
      next_run_at: nextRunAt ? toIsoString(nextRunAt) : null,
      once_at: schedule.onceAt ? toIsoString(schedule.onceAt) : null,
      interval_minutes: schedule.intervalMinutes ?? null,
      at_time: schedule.atTime ?? null,
      by_weekday: schedule.byWeekday ?? null,
      by_monthday: schedule.byMonthday ?? null,
      by_month: schedule.byMonth ?? null,
      is_active: isActive ?? true,
      last_sent_at_utc: null,
      enabled: enabled ?? true,
      status: status ?? 'active'
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
  patch: {
    title?: string | null;
    description?: string | null;
    descGroupKey?: string | null;
    schedule?: ReminderSchedule;
    nextRunAt?: Date | null;
    isActive?: boolean;
    enabled?: boolean;
    status?: string;
    archiveItemId?: string | null;
  },
  client = getSupabaseClient()
): Promise<ReminderRow> {
  const updates: Record<string, unknown> = {
    updated_at: toIsoString(new Date())
  };

  if (typeof patch.title !== 'undefined') updates.title = patch.title;
  if (typeof patch.description !== 'undefined') updates.description = patch.description;
  if (typeof patch.isActive !== 'undefined') updates.is_active = patch.isActive;
  if (typeof patch.enabled !== 'undefined') updates.enabled = patch.enabled;
  if (typeof patch.descGroupKey !== 'undefined') updates.desc_group_key = patch.descGroupKey;
  if (typeof patch.status !== 'undefined') updates.status = patch.status;
  if (typeof patch.archiveItemId !== 'undefined') updates.archive_item_id = patch.archiveItemId;
  if ('nextRunAt' in patch) updates.next_run_at = patch.nextRunAt ? toIsoString(patch.nextRunAt) : null;
  if (patch.schedule) {
    updates.schedule_type = patch.schedule.scheduleType;
    updates.timezone = patch.schedule.timezone;
    updates.once_at = patch.schedule.onceAt ? toIsoString(patch.schedule.onceAt) : null;
    updates.interval_minutes = patch.schedule.intervalMinutes ?? null;
    updates.at_time = patch.schedule.atTime ?? null;
    updates.by_weekday = patch.schedule.byWeekday ?? null;
    updates.by_monthday = patch.schedule.byMonthday ?? null;
    updates.by_month = patch.schedule.byMonth ?? null;
  }

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
  const isActive = nextEnabled && Boolean(current.next_run_at);
  const status = isActive ? 'active' : 'inactive';
  return updateReminder(reminderId, { enabled: nextEnabled, isActive, status }, client);
}

export async function createReminderAttachment(
  params: {
    reminderId: string;
    archiveChatId: number;
    archiveMessageId: number;
    kind: ReminderAttachmentRow['kind'];
    fileId: string | null;
    caption?: string | null;
    fileUniqueId?: string | null;
    mimeType?: string | null;
  },
  client = getSupabaseClient()
): Promise<ReminderAttachmentRow> {
  const { reminderId, archiveChatId, archiveMessageId, kind, fileId, caption, fileUniqueId, mimeType } = params;
  const { data, error } = await client
    .from(REMINDERS_ATTACHMENTS_TABLE)
    .insert({
      reminder_id: reminderId,
      archive_chat_id: archiveChatId,
      archive_message_id: archiveMessageId,
      file_id: fileId,
      kind,
      caption: caption ?? null,
      file_unique_id: fileUniqueId ?? null,
      mime_type: mimeType ?? null
    })
    .select('*')
    .single();

  if (error) {
    throw new Error(`Failed to create reminder attachment: ${error.message}`);
  }

  return data as ReminderAttachmentRow;
}

export async function listReminderAttachments(
  params: { reminderId: string },
  client = getSupabaseClient()
): Promise<ReminderAttachmentRow[]> {
  const { reminderId } = params;
  const { data, error } = await client
    .from(REMINDERS_ATTACHMENTS_TABLE)
    .select('*')
    .eq('reminder_id', reminderId)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to list reminder attachments: ${error.message}`);
  }

  return (data as ReminderAttachmentRow[]) ?? [];
}

export async function listReminderAttachmentCounts(
  params: { reminderIds: string[] },
  client = getSupabaseClient()
): Promise<Record<string, number>> {
  const { reminderIds } = params;
  if (reminderIds.length === 0) return {};
  const { data, error } = await client
    .from(REMINDERS_ATTACHMENTS_TABLE)
    .select('reminder_id')
    .in('reminder_id', reminderIds);

  if (error) {
    throw new Error(`Failed to count reminder attachments: ${error.message}`);
  }

  const counts: Record<string, number> = {};
  for (const row of (data as { reminder_id: string }[]) ?? []) {
    counts[row.reminder_id] = (counts[row.reminder_id] ?? 0) + 1;
  }
  return counts;
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

  const title = reminder.title?.trim().length ? reminder.title : labels.reminders.untitled();
  const lines = [labels.reminders.messageTitle({ title })];
  const description = reminder.description?.trim() ?? '';
  if (description.length > 0) {
    const preview = description.length > 600 ? `${description.slice(0, 600)}…` : description;
    lines.push('', preview);
    if (reminder.desc_group_key || description.length > 600) {
      lines.push(labels.reminders.messageArchivedNotice());
    }
  }

  const text = safeTruncate(lines.join('\n'), 3500);

  await botClient.api.sendMessage(chatId, text);

  if (reminder.desc_group_key) {
    const entries = await listArchiveMessagesByGroupKey({ groupKey: reminder.desc_group_key });
    for (const entry of entries) {
      await botClient.api.copyMessage(chatId, entry.archive_chat_id, entry.archive_message_id);
      await sleep(ARCHIVE_COPY_DELAY_MS);
    }
  }
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

      await sendReminderMessage({ reminder, user, botClient });

      const attachments = await listReminderAttachments({ reminderId: reminder.id }, client);
      if (attachments.length) {
        const stored = attachments
          .filter((attachment) => Boolean(attachment.file_id))
          .map((attachment) => ({
            kind: attachment.kind as 'photo' | 'video' | 'voice' | 'document' | 'video_note' | 'audio',
            fileId: attachment.file_id as string,
            caption: attachment.caption ?? undefined
          }));
        if (stored.length === 0) {
          logWarn('Reminder attachments missing file_id; skipping resend', {
            scope: 'reminders',
            reminderId: reminder.id
          });
        } else {
          if (stored.length !== attachments.length) {
            logWarn('Reminder attachments missing file_id; sending available only', {
              scope: 'reminders',
              reminderId: reminder.id,
              total: attachments.length,
              available: stored.length
            });
          }
          await sendAttachmentsWithApi(botClient.api, Number(user.telegram_id), stored);
        }
      }

      const schedule: ReminderSchedule = {
        scheduleType: reminder.schedule_type as ReminderScheduleType,
        timezone: reminder.timezone ?? config.defaultTimezone,
        onceAt: reminder.once_at ? new Date(reminder.once_at) : null,
        intervalMinutes: reminder.interval_minutes,
        atTime: reminder.at_time,
        byWeekday: reminder.by_weekday,
        byMonthday: reminder.by_monthday,
        byMonth: reminder.by_month
      };

      const nextRunAt = computeNextRunAt(schedule, nowUtc);
      const isOnce = schedule.scheduleType === 'once';

      await client
        .from(REMINDERS_TABLE)
        .update({
          last_sent_at_utc: toIsoString(nowUtc),
          next_run_at: nextRunAt ? toIsoString(nextRunAt) : null,
          is_active: isOnce ? false : true,
          updated_at: toIsoString(nowUtc)
        })
        .eq('id', reminder.id);

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
    .eq('is_active', true)
    .is('deleted_at', null)
    .not('next_run_at', 'is', null)
    .order('next_run_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to list reminders: ${error.message}`);
  }

  return data ?? [];
}

export async function deleteReminder(reminderId: string, client = getSupabaseClient()): Promise<void> {
  const { error } = await client
    .from(REMINDERS_TABLE)
    .update({ deleted_at: toIsoString(new Date()), deleted_by: 'user', is_active: false })
    .eq('id', reminderId);

  if (error) {
    throw new Error(`Failed to delete reminder: ${error.message}`);
  }
}

export async function getRemindersCronStatus(
  client = getSupabaseClient()
): Promise<{ lastRunUtc: string | null; processedCount: number }> {
  const { data: agg, error } = await client
    .from(REMINDERS_TABLE)
    .select('last_sent_at_utc')
    .not('last_sent_at_utc', 'is', null)
    .order('last_sent_at_utc', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load cron status: ${error.message}`);
  }

  if (!agg || !agg.last_sent_at_utc) {
    return { lastRunUtc: null, processedCount: 0 };
  }

  const lastRunUtc = agg.last_sent_at_utc as string;

  const { data: countRows, error: countError } = await client
    .from(REMINDERS_TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('last_sent_at_utc', lastRunUtc);

  if (countError) {
    throw new Error(`Failed to count processed reminders: ${countError.message}`);
  }

  const processedCount = (countRows as unknown as { length?: number } | null)?.length ?? 0;

  return { lastRunUtc, processedCount };
}

export type ReminderAttachmentBackfillSummary = {
  updated: number;
  skipped: number;
  needsManualFix: number;
  durationMs: number;
};

export async function backfillReminderAttachmentFileIds(): Promise<ReminderAttachmentBackfillSummary> {
  const start = Date.now();

  const { rows } = await queryDb<{
    with_file: number;
    manual: number;
    missing: number;
  }>(`
    select
      sum(case when file_id is not null then 1 else 0 end)::int as with_file,
      sum(case when file_id is null and coalesce(needs_manual_fix, false) = true then 1 else 0 end)::int as manual,
      sum(case when file_id is null and coalesce(needs_manual_fix, false) = false then 1 else 0 end)::int as missing
    from public.reminders_attachments
  `);

  const withFile = rows?.[0]?.with_file ?? 0;
  const manual = rows?.[0]?.manual ?? 0;
  const missing = rows?.[0]?.missing ?? 0;

  if (missing > 0) {
    await queryDb(
      `
        update public.reminders_attachments
        set needs_manual_fix = true
        where file_id is null
          and coalesce(needs_manual_fix, false) = false
      `
    );
  }

  return {
    updated: 0,
    skipped: withFile + manual,
    needsManualFix: missing,
    durationMs: Date.now() - start
  };
}
