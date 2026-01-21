import type { Bot } from 'grammy';
import crypto from 'node:crypto';
import os from 'node:os';

import { config } from '../config';
import { getSupabaseClient } from '../db';
import type { ReminderRow } from '../types/supabase';
import {
  computeNextRunAt as computeNextRunAtFromSchedule,
  loadUser,
  listReminderAttachments,
  sendReminderMessage,
  type ReminderSchedule,
  type ReminderScheduleType
} from './reminders';
import { parseTelegramError } from './telegramSend';
import { logError, logInfo, logWarn } from '../utils/logger';

const REMINDERS_TABLE = 'reminders';
const REMINDER_DELIVERIES_TABLE = 'reminder_deliveries';
const CRON_RUNS_TABLE = 'cron_runs';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type CronTickSummary = {
  ok: boolean;
  tick_id?: string;
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
  duration_ms: number;
  error?: string;
};

type CronUnauthorized = {
  ok: false;
  error: 'unauthorized';
};

type CronTickResult = CronTickSummary | CronUnauthorized;

type ReminderDeliveryRow = {
  id: string;
  ok: boolean;
};

const getCronLockTimeoutSeconds = (): number => {
  const base = Math.ceil(config.cron.maxRuntimeMs / 1000);
  return Math.max(60, base * 3);
};

const buildDeliveryKey = (reminder: ReminderRow, occurrenceIso: string): string => {
  return `${reminder.id}:${occurrenceIso}`;
};

const shouldRequireCronSecret = (): boolean => {
  return process.env.NODE_ENV === 'production';
};

const isCronAuthorized = (key: string | undefined): boolean => {
  const secret = config.cron.secret?.trim();
  if (!secret) {
    return !shouldRequireCronSecret();
  }
  return key === secret;
};

const asIsoString = (value: Date): string => value.toISOString();

const toScheduleFromReminder = (reminder: ReminderRow): ReminderSchedule => {
  return {
    scheduleType: reminder.schedule_type as ReminderScheduleType,
    timezone: reminder.timezone ?? config.defaultTimezone,
    onceAt: reminder.once_at ? new Date(reminder.once_at) : null,
    intervalMinutes: reminder.interval_minutes,
    atTime: reminder.at_time,
    byWeekday: reminder.by_weekday,
    byMonthday: reminder.by_monthday,
    byMonth: reminder.by_month
  };
};

export const computeNextRunAt = (reminder: ReminderRow, sentAtUtc: Date): Date | null => {
  return computeNextRunAtFromSchedule(toScheduleFromReminder(reminder), sentAtUtc);
};

const insertCronRunStart = async (tickId: string): Promise<void> => {
  const client = getSupabaseClient();
  const { error } = await client.from(CRON_RUNS_TABLE).insert({ tick_id: tickId });
  if (error) {
    logWarn('Failed to insert cron run start', { scope: 'cron', tickId, error: error.message });
  }
};

const updateCronRunFinish = async (tickId: string, data: Record<string, unknown>): Promise<void> => {
  const client = getSupabaseClient();
  const { error } = await client.from(CRON_RUNS_TABLE).update(data).eq('tick_id', tickId);
  if (error) {
    logWarn('Failed to update cron run finish', { scope: 'cron', tickId, error: error.message });
  }
};

const claimDueReminders = async (tickId: string, batchLimit: number): Promise<ReminderRow[]> => {
  const client = getSupabaseClient();
  const lockTimeoutSeconds = getCronLockTimeoutSeconds();
  const lockedBy = `${os.hostname()}:${process.pid}`;

  const { data, error } = await client.rpc('claim_due_reminders', {
    batch_limit: batchLimit,
    tick_id: tickId,
    locked_by: lockedBy,
    lock_timeout_seconds: lockTimeoutSeconds
  });

  if (error) {
    throw new Error(`Failed to claim reminders: ${error.message}`);
  }

  return (data as ReminderRow[]) ?? [];
};

const findExistingDelivery = async (
  reminderId: string,
  deliveryKey: string
): Promise<ReminderDeliveryRow | null> => {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from(REMINDER_DELIVERIES_TABLE)
    .select('id, ok')
    .eq('reminder_id', reminderId)
    .eq('delivery_key', deliveryKey)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to lookup delivery key: ${error.message}`);
  }

  return data ?? null;
};

const upsertDelivery = async (params: {
  reminderId: string;
  tickId: string;
  deliveryKey: string;
  ok: boolean;
  error?: string | null;
  sentAtUtc: Date;
}): Promise<void> => {
  const client = getSupabaseClient();
  const { error } = await client
    .from(REMINDER_DELIVERIES_TABLE)
    .upsert(
      {
        reminder_id: params.reminderId,
        tick_id: params.tickId,
        delivery_key: params.deliveryKey,
        ok: params.ok,
        error: params.error ?? null,
        sent_at_utc: asIsoString(params.sentAtUtc)
      },
      { onConflict: 'reminder_id,delivery_key' }
    );

  if (error) {
    throw new Error(`Failed to upsert delivery: ${error.message}`);
  }
};

const releaseUnprocessedReminders = async (reminderIds: string[]): Promise<void> => {
  if (reminderIds.length === 0) return;
  const client = getSupabaseClient();
  const { error } = await client
    .from(REMINDERS_TABLE)
    .update({
      status: 'active',
      locked_at: null,
      locked_by: null
    })
    .in('id', reminderIds);

  if (error) {
    logWarn('Failed to release unprocessed reminders', { scope: 'cron', error: error.message });
  }
};

const updateReminderAfterSuccess = async (
  reminder: ReminderRow,
  sentAtUtc: Date,
  tickId: string
): Promise<void> => {
  const client = getSupabaseClient();
  const isOnce = reminder.schedule_type === 'once';
  const nextRunAt = isOnce ? null : computeNextRunAt(reminder, sentAtUtc);

  const { error } = await client
    .from(REMINDERS_TABLE)
    .update({
      last_sent_at_utc: asIsoString(sentAtUtc),
      next_run_at_utc: nextRunAt ? asIsoString(nextRunAt) : null,
      next_run_at: nextRunAt ? asIsoString(nextRunAt) : null,
      status: isOnce ? 'sent' : 'active',
      is_active: !isOnce,
      send_attempt_count: 0,
      last_error: null,
      retry_after_utc: null,
      locked_at: null,
      locked_by: null,
      last_tick_id: tickId,
      updated_at: asIsoString(new Date())
    })
    .eq('id', reminder.id);

  if (error) {
    throw new Error(`Failed to update reminder after success: ${error.message}`);
  }
};

const updateReminderAfterFailure = async (
  reminder: ReminderRow,
  params: { tickId: string; errorMessage: string; retryAfterSeconds?: number | null }
): Promise<void> => {
  const client = getSupabaseClient();
  const attemptCount = (reminder.send_attempt_count ?? 0) + 1;
  const fallbackRetrySeconds = Math.min(2 ** attemptCount * 30, 3600);
  const retryAfterSeconds =
    params.retryAfterSeconds && params.retryAfterSeconds > 0
      ? params.retryAfterSeconds
      : fallbackRetrySeconds;

  const retryAfterUtc = new Date(Date.now() + retryAfterSeconds * 1000);

  const { error } = await client
    .from(REMINDERS_TABLE)
    .update({
      status: 'failed',
      send_attempt_count: attemptCount,
      last_error: params.errorMessage,
      retry_after_utc: asIsoString(retryAfterUtc),
      locked_at: null,
      locked_by: null,
      last_tick_id: params.tickId,
      updated_at: asIsoString(new Date())
    })
    .eq('id', reminder.id);

  if (error) {
    throw new Error(`Failed to update reminder after failure: ${error.message}`);
  }
};

const sendReminderWithAttachments = async (reminder: ReminderRow, botClient: Bot): Promise<void> => {
  const user = await loadUser(reminder.user_id);
  if (!user || !user.telegram_id) {
    throw new Error('Missing user or telegram id');
  }

  await sendReminderMessage({ reminder, user, botClient });

  const attachments = await listReminderAttachments({ reminderId: reminder.id });
  for (const attachment of attachments) {
    await botClient.api.copyMessage(
      user.telegram_id,
      attachment.archive_chat_id,
      attachment.archive_message_id
    );
  }
};

export const runCronTick = async (params: {
  key?: string;
  botClient: Bot;
}): Promise<CronTickResult> => {
  if (shouldRequireCronSecret() && !config.cron.secret) {
    logWarn('CRON_SECRET missing in production', { scope: 'cron' });
  }

  if (!isCronAuthorized(params.key)) {
    return {
      ok: false,
      error: 'unauthorized'
    };
  }

  const tickId = crypto.randomUUID();
  const start = Date.now();
  const counts = { claimed: 0, sent: 0, failed: 0, skipped: 0 };

  await insertCronRunStart(tickId);

  try {
    const reminders = await claimDueReminders(tickId, config.cron.maxBatch);
    counts.claimed = reminders.length;

    for (let index = 0; index < reminders.length; index += 1) {
      if (Date.now() - start > config.cron.maxRuntimeMs) {
        const remaining = reminders.slice(index).map((reminder) => reminder.id);
        counts.skipped += remaining.length;
        await releaseUnprocessedReminders(remaining);
        break;
      }

      const reminder = reminders[index];
      const occurrenceIso = reminder.next_run_at_utc ?? reminder.next_run_at;
      const occurrenceKey = occurrenceIso ?? new Date().toISOString();
      const deliveryKey = buildDeliveryKey(reminder, occurrenceKey);

      try {
        const existingDelivery = await findExistingDelivery(reminder.id, deliveryKey);
        if (existingDelivery?.ok) {
          counts.skipped += 1;
          const sentAtUtc = occurrenceIso ? new Date(occurrenceIso) : new Date();
          await updateReminderAfterSuccess(reminder, sentAtUtc, tickId);
          logInfo('Reminder skipped due to idempotency', {
            scope: 'cron',
            tickId,
            reminderId: reminder.id,
            deliveryKey
          });
          continue;
        }

        await sendReminderWithAttachments(reminder, params.botClient);

        const sentAtUtc = new Date();
        await upsertDelivery({
          reminderId: reminder.id,
          tickId,
          deliveryKey,
          ok: true,
          sentAtUtc
        });
        await updateReminderAfterSuccess(reminder, sentAtUtc, tickId);
        counts.sent += 1;

        logInfo('Reminder sent', {
          scope: 'cron',
          tickId,
          reminderId: reminder.id,
          userId: reminder.user_id,
          scheduleType: reminder.schedule_type
        });

        if (config.cron.telegramSendDelayMs > 0) {
          await sleep(config.cron.telegramSendDelayMs);
        }
      } catch (error) {
        const parsed = parseTelegramError(error);
        const retryAfterSeconds = parsed.kind === 'rate_limit' ? parsed.retryAfterSeconds : null;
        const errorMessage =
          parsed.kind === 'rate_limit'
            ? `rate_limited:${parsed.retryAfterSeconds}`
            : parsed.message;

        counts.failed += 1;

        await upsertDelivery({
          reminderId: reminder.id,
          tickId,
          deliveryKey,
          ok: false,
          error: errorMessage,
          sentAtUtc: new Date()
        });

        await updateReminderAfterFailure(reminder, {
          tickId,
          errorMessage,
          retryAfterSeconds
        });

        logError('Reminder send failed', {
          scope: 'cron',
          tickId,
          reminderId: reminder.id,
          userId: reminder.user_id,
          scheduleType: reminder.schedule_type,
          error: errorMessage
        });

        if (parsed.kind === 'rate_limit') {
          break;
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError('Cron tick failed', { scope: 'cron', tickId, error: message });
    await updateCronRunFinish(tickId, {
      finished_at: asIsoString(new Date()),
      claimed: counts.claimed,
      sent: counts.sent,
      failed: counts.failed,
      skipped: counts.skipped,
      notes: message
    });
    return {
      ok: false,
      error: message,
      tick_id: tickId,
      claimed: counts.claimed,
      sent: counts.sent,
      failed: counts.failed,
      skipped: counts.skipped,
      duration_ms: Date.now() - start
    };
  }

  await updateCronRunFinish(tickId, {
    finished_at: asIsoString(new Date()),
    claimed: counts.claimed,
    sent: counts.sent,
    failed: counts.failed,
    skipped: counts.skipped
  });

  return {
    ok: true,
    tick_id: tickId,
    claimed: counts.claimed,
    sent: counts.sent,
    failed: counts.failed,
    skipped: counts.skipped,
    duration_ms: Date.now() - start
  };
};

export const getCronHealth = async (): Promise<{
  last_success_tick_time: string | null;
  last_tick_id: string | null;
  last_sent_at: string | null;
  last_error: string | null;
}> => {
  const client = getSupabaseClient();

  const [{ data: lastRun, error: lastRunError }, { data: lastSuccess, error: lastSuccessError }, { data: lastSent, error: lastSentError }] =
    await Promise.all([
      client.from(CRON_RUNS_TABLE).select('*').order('started_at', { ascending: false }).limit(1).maybeSingle(),
      client
        .from(CRON_RUNS_TABLE)
        .select('finished_at')
        .gt('sent', 0)
        .order('finished_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      client
        .from(REMINDERS_TABLE)
        .select('last_sent_at_utc')
        .not('last_sent_at_utc', 'is', null)
        .order('last_sent_at_utc', { ascending: false })
        .limit(1)
        .maybeSingle()
    ]);

  if (lastRunError || lastSuccessError || lastSentError) {
    logWarn('Failed to load cron health data', {
      scope: 'cron',
      lastRunError: lastRunError?.message,
      lastSuccessError: lastSuccessError?.message,
      lastSentError: lastSentError?.message
    });
  }

  return {
    last_success_tick_time: lastSuccess?.finished_at ?? null,
    last_tick_id: lastRun?.tick_id ?? null,
    last_sent_at: lastSent?.last_sent_at_utc ?? null,
    last_error: lastRun?.notes ?? null
  };
};
