import { Bot, InlineKeyboard } from 'grammy';
import type { BotError, Context } from 'grammy';
import { config } from './config';
import { ensureUser } from './services/users';
import {
  createReminder,
  deleteReminder,
  getReminderById,
  listRemindersForUser,
  toggleReminderEnabled,
  updateReminder
} from './services/reminders';
import {
  DAILY_REPORT_FIELD_DEFINITIONS,
  type DailyReportPatch,
  type DailyReportFieldDefinition,
  type DailyReportFieldKey,
  computeCompletionStatus,
  getOrCreateTodayReport,
  getReportById,
  listRecentReports,
  updateReportFields
} from './services/dailyReports';
import { formatInstantToLocal, formatLocalTime } from './utils/time';
import type { DailyReportRow, ReminderRow } from './types/supabase';

export const bot = new Bot(config.telegram.botToken);

// ===== Keyboards (inline-only) =====

const homeKeyboard = new InlineKeyboard().text('🗒️ گزارش روزانه', 'dr:menu').row().text('🔔 یادآوری‌ها', 'reminders:menu');

const remindersMenuKeyboard = new InlineKeyboard()
  .text('➕ یادآوری جدید', 'reminders:new')
  .row()
  .text('📋 لیست و مدیریت یادآوری‌ها', 'reminders:list')
  .row()
  .text('⬅️ خانه', 'reminders:back_home');

const buildReminderListKeyboard = (reminders: ReminderRow[]): InlineKeyboard => {
  const keyboard = new InlineKeyboard();

  reminders.forEach((reminder, idx) => {
    keyboard.text(`⚙ مدیریت #${idx + 1}`, `reminders:manage:${reminder.id}`).row();
  });

  keyboard.text('➕ یادآوری جدید', 'reminders:new').row().text('⬅️ بازگشت', 'reminders:menu');

  return keyboard;
};

const buildManageKeyboard = (reminder: ReminderRow): InlineKeyboard =>
  new InlineKeyboard()
    .text('✏️ ویرایش عنوان', `reminders:edit_title:${reminder.id}`)
    .row()
    .text('📝 توضیحات', `reminders:edit_detail:${reminder.id}`)
    .row()
    .text('⏭ حذف توضیحات', `reminders:clear_detail:${reminder.id}`)
    .row()
    .text(reminder.enabled ? '🔕 غیرفعال کن' : '🔔 فعال کن', `reminders:toggle:${reminder.id}`)
    .row()
    .text('⏱ تغییر زمان', `reminders:edit_time:${reminder.id}`)
    .row()
    .text('🗑 حذف', `reminders:delete:${reminder.id}`)
    .row()
    .text('⬅️ بازگشت به لیست', 'reminders:list');

const buildCreateDelayKeyboard = (): InlineKeyboard =>
  new InlineKeyboard()
    .text('۵ دقیقه دیگر', 'reminders:new_delay:5')
    .row()
    .text('۱۵ دقیقه دیگر', 'reminders:new_delay:15')
    .row()
    .text('۳۰ دقیقه دیگر', 'reminders:new_delay:30')
    .row()
    .text('۱ ساعت دیگر', 'reminders:new_delay:60')
    .row()
    .text('⬅️ لغو', 'reminders:cancel');

const buildEditDelayKeyboard = (reminderId: string): InlineKeyboard =>
  new InlineKeyboard()
    .text('۵ دقیقه دیگر', `reminders:edit_delay:${reminderId}:5`)
    .row()
    .text('۱۵ دقیقه دیگر', `reminders:edit_delay:${reminderId}:15`)
    .row()
    .text('۳۰ دقیقه دیگر', `reminders:edit_delay:${reminderId}:30`)
    .row()
    .text('۱ ساعت دیگر', `reminders:edit_delay:${reminderId}:60`)
    .row()
    .text('⬅️ بازگشت', `reminders:manage:${reminderId}`);

const skipDetailKeyboard = new InlineKeyboard().text('⏭ بدون توضیحات', 'reminders:create_skip_detail');

const deletedReminderKeyboard = new InlineKeyboard()
  .text('📋 بازگشت به لیست', 'reminders:list')
  .row()
  .text('➕ یادآوری جدید', 'reminders:new');

const dailyReportMenuKeyboard = new InlineKeyboard()
  .text('📝 گزارش امروز', 'dr:today')
  .row()
  .text('📋 گزارش‌های اخیر', 'dr:list')
  .row()
  .text('⬅️ خانه', 'dr:home');

// ===== State =====

type ReminderStage = 'create_title' | 'create_detail' | 'create_delay' | 'edit_title' | 'edit_detail';

type ReminderState = {
  stage: ReminderStage;
  reminderId?: string;
  title?: string;
  detail?: string | null;
};

const reminderStates = new Map<string, ReminderState>();

type DailyReportState = {
  reportId: string;
  userId: string;
  stepKey: DailyReportFieldKey;
  awaitingText?: boolean;
};

const dailyReportStates = new Map<string, DailyReportState>();

const clearReminderState = (telegramId: string): void => {
  reminderStates.delete(telegramId);
};

const clearDailyReportState = (telegramId: string): void => {
  dailyReportStates.delete(telegramId);
};

// ===== Daily report field metadata =====

const range = (start: number, end: number, step: number): number[] => {
  const vals: number[] = [];
  for (let v = start; v <= end + 1e-9; v += step) {
    vals.push(Math.round(v * 100) / 100);
  }
  return vals;
};

const numberOptions: Partial<Record<DailyReportFieldKey, number[]>> = {
  sleep_hours: range(0, 12, 0.5),
  citylib_time_hours: range(0, 12, 0.5),
  citylib_book_hours: range(0, 6, 0.5),
  citylib_notes_hours: range(0, 6, 0.5),
  citylib_programming_hours: range(0, 6, 0.5),
  citylib_tests_hours: range(0, 6, 0.5),
  citylib_school_hours: range(0, 6, 0.5),
  daily_cost: range(0, 1000, 50),
  burned_calories: range(0, 1500, 100)
};

const timeOptions: Partial<Record<DailyReportFieldKey, string[]>> = {
  sleep_time_local: ['20:00', '21:00', '22:00', '23:00', '00:00', '01:00', '02:00', '06:00', '07:00', '08:00']
};

const dailyReportFieldMap: Record<DailyReportFieldKey, DailyReportFieldDefinition> = DAILY_REPORT_FIELD_DEFINITIONS.reduce(
  (acc, def) => {
    acc[def.key] = def;
    return acc;
  },
  {} as Record<DailyReportFieldKey, DailyReportFieldDefinition>
);

const reportStepOrder: DailyReportFieldKey[] = DAILY_REPORT_FIELD_DEFINITIONS.map((d) => d.key);

const getNextStepKey = (current: DailyReportFieldKey): DailyReportFieldKey | null => {
  const idx = reportStepOrder.findIndex((k) => k === current);
  if (idx < 0 || idx === reportStepOrder.length - 1) return null;
  return reportStepOrder[idx + 1];
};

const getFirstUnfilledStep = (report: DailyReportRow): DailyReportFieldKey => {
  const statuses = computeCompletionStatus(report);
  const firstEmpty = statuses.find((s) => !s.filled);
  return firstEmpty?.key ?? reportStepOrder[0];
};

// ===== Helpers =====

const sendHome = async (ctx: Context, edit = false): Promise<void> => {
  if (!ctx.from) {
    await ctx.reply('خطا: اطلاعات کاربری در دسترس نیست.');
    return;
  }

  const telegramId = String(ctx.from.id);
  const username = ctx.from.username ?? null;

  try {
    const user = await ensureUser({ telegramId, username });
    const localTime = formatLocalTime(user.timezone ?? config.defaultTimezone);

    const homeMessage = [
      'سلام! خوش آمدی به داشبورد خانه.',
      'در اینجا وضعیت کلی روزانه‌ات را می‌بینی.',
      `⏱ زمان فعلی: ${localTime.date} | ${localTime.time} (${localTime.timezone})`
    ].join('\n');

    if (edit && ctx.callbackQuery) {
      try {
        await ctx.editMessageText(homeMessage, { reply_markup: homeKeyboard });
        return;
      } catch {
        // fallback
      }
    }

    await ctx.reply(homeMessage, { reply_markup: homeKeyboard });
  } catch (error) {
    console.error({ scope: 'services/users', error });
    await ctx.reply('خطا در اتصال به بانک اطلاعاتی. لطفاً بعداً دوباره امتحان کن.');
  }
};

const formatReminderLine = (reminder: ReminderRow, tz?: string | null): string => {
  const statusLabel = reminder.enabled ? 'فعال' : 'غیرفعال';
  const nextRun = reminder.next_run_at_utc
    ? formatInstantToLocal(reminder.next_run_at_utc, tz ?? undefined)
    : null;

  const parts = [
    `عنوان: ${reminder.title}`,
    `وضعیت: ${statusLabel}`,
    `ارسال بعدی: ${nextRun ? `${nextRun.date} | ${nextRun.time}` : '—'}`
  ];

  return parts.join('\n   ');
};

// ===== Reminder helpers =====

const renderManageView = async (ctx: Context, reminderId: string): Promise<void> => {
  if (!ctx.from) return;
  const reminder = await getReminderById(reminderId);
  if (!reminder) {
    await ctx.reply('یادآوری پیدا نشد.');
    return;
  }

  const local = reminder.next_run_at_utc ? formatInstantToLocal(reminder.next_run_at_utc, undefined) : null;
  const detailText = reminder.detail && reminder.detail.trim().length > 0 ? reminder.detail : '—';

  const lines = [
    '⚙ مدیریت یادآوری',
    `عنوان: ${reminder.title}`,
    `توضیحات: ${detailText}`,
    `وضعیت: ${reminder.enabled ? 'فعال' : 'غیرفعال'}`,
    `ارسال بعدی (UTC): ${local ? `${local.date} | ${local.time}` : '—'}`
  ];

  const keyboard = buildManageKeyboard(reminder);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard });
      return;
    } catch {
      // fallback
    }
  }

  await ctx.reply(lines.join('\n'), { reply_markup: keyboard });
};

const renderRemindersList = async (ctx: Context, telegramId: string): Promise<void> => {
  const username = ctx.from?.username ?? null;
  const user = await ensureUser({ telegramId, username });
  const reminders = await listRemindersForUser(user.id);

  console.log({ scope: 'reminders', event: 'list', userId: user.id, count: reminders.length });

  if (!reminders.length) {
    const emptyText = '🔔 هیچ یادآوری‌ای ثبت نکرده‌ای.';
    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(emptyText, { reply_markup: remindersMenuKeyboard });
        return;
      } catch {
        // fallback
      }
    }
    await ctx.reply(emptyText, { reply_markup: remindersMenuKeyboard });
    return;
  }

  const lines: string[] = ['📋 لیست یادآوری‌ها:'];
  reminders.forEach((reminder, idx) => {
    const statusLabel = reminder.enabled ? 'فعال' : 'غیرفعال';
    const nextRun = reminder.next_run_at_utc
      ? formatInstantToLocal(reminder.next_run_at_utc, user.timezone ?? undefined)
      : null;
    lines.push(
      `${idx + 1}) عنوان: ${reminder.title}\n   وضعیت: ${statusLabel}\n   ارسال بعدی: ${nextRun ? `${nextRun.date} | ${nextRun.time}` : '—'}`
    );
  });

  const keyboard = buildReminderListKeyboard(reminders);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard });
      return;
    } catch {
      // fallback
    }
  }

  await ctx.reply(lines.join('\n'), { reply_markup: keyboard });
};

const handleCreateDelay = async (ctx: Context, delayMinutes: number): Promise<void> => {
  if (!ctx.from) return;
  const telegramId = String(ctx.from.id);
  const username = ctx.from.username ?? null;
  const state = reminderStates.get(telegramId);

  if (!state || state.stage !== 'create_delay' || !state.title || Number.isNaN(delayMinutes)) {
    await ctx.answerCallbackQuery?.({ text: 'درخواست نامعتبر است.', show_alert: true });
    return;
  }

  try {
    const nowUtc = new Date();
    const nextRunUtc = new Date(nowUtc.getTime() + delayMinutes * 60 * 1000);
    const user = await ensureUser({ telegramId, username });
    const reminder = await createReminder(user.id, state.title, state.detail ?? null, nextRunUtc);

    console.log({ scope: 'reminders', event: 'created', userId: user.id, telegramId, reminderId: reminder.id, delayMinutes });

    const confirmation = `✅ یادآوری ثبت شد.\nربات حدود ${delayMinutes} دقیقه دیگر بهت پیام می‌دهد.`;
    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(confirmation, { reply_markup: remindersMenuKeyboard });
      } catch {
        await ctx.reply(confirmation, { reply_markup: remindersMenuKeyboard });
      }
    } else {
      await ctx.reply(confirmation, { reply_markup: remindersMenuKeyboard });
    }
  } catch (error) {
    console.error({ scope: 'reminders', event: 'create_error', telegramId, error });
    const errorText = '❌ خطا در ثبت یادآوری. لطفاً بعداً دوباره امتحان کن.';
    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(errorText, { reply_markup: remindersMenuKeyboard });
        return;
      } catch {
        // fallback
      }
    }
    await ctx.reply(errorText, { reply_markup: remindersMenuKeyboard });
  } finally {
    clearReminderState(telegramId);
  }
};

// ===== Daily report helpers =====

const formatReportValue = (report: DailyReportRow, key: DailyReportFieldKey): string => {
  const value = report[key];
  if (typeof value === 'boolean') return value ? 'بله' : 'خیر';
  if (typeof value === 'number') return value.toString();
  if (typeof value === 'string' && value.trim().length > 0) return value;
  return '—';
};

const buildReportChecklistKeyboard = (report: DailyReportRow): InlineKeyboard => {
  const statuses = computeCompletionStatus(report);
  const keyboard = new InlineKeyboard();

  statuses.forEach((item, idx) => {
    const label = `${item.filled ? '✅' : '⬜'} ${item.label}`;
    keyboard.text(label, `dr:field:${item.key}:${report.id}`);
    if (idx % 2 === 1) keyboard.row();
  });

  keyboard
    .row()
    .text('▶️ تکمیل / ویرایش موارد', `dr:wizard_start:${report.id}`)
    .row()
    .text('🧾 مشاهده خلاصه امروز', `dr:summary:${report.id}`)
    .row()
    .text('⬅️ خانه', 'dr:home');

  return keyboard;
};

const renderDailyReportOverview = async (ctx: Context, report: DailyReportRow, timezone?: string | null): Promise<void> => {
  const localTime = formatLocalTime(timezone ?? config.defaultTimezone);
  const statuses = computeCompletionStatus(report);
  const lines = [
    '🗒️ گزارش روزانه',
    `تاریخ: ${report.report_date}`,
    `زمان محلی: ${localTime.date} | ${localTime.time} (${localTime.timezone})`,
    '',
    'وضعیت موارد:'
  ];

  statuses.forEach((item) => {
    lines.push(`${item.filled ? '✅' : '⬜'} ${item.label}`);
  });

  const keyboard = buildReportChecklistKeyboard(report);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard });
      return;
    } catch {
      // fallback
    }
  }

  await ctx.reply(lines.join('\n'), { reply_markup: keyboard });
};

const renderReportSummary = async (ctx: Context, report: DailyReportRow): Promise<void> => {
  const lines: string[] = [
    '🧾 خلاصه گزارش امروز',
    `تاریخ: ${report.report_date}`,
    ''
  ];

  DAILY_REPORT_FIELD_DEFINITIONS.forEach((def) => {
    lines.push(`${def.label}: ${formatReportValue(report, def.key)}`);
  });

  const keyboard = new InlineKeyboard()
    .text('▶️ ویرایش', `dr:wizard_start:${report.id}`)
    .row()
    .text('⬅️ بازگشت', `dr:today_resume:${report.id}`)
    .row()
    .text('⬅️ خانه', 'dr:home');

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard });
      return;
    } catch {
      // fallback
    }
  }

  await ctx.reply(lines.join('\n'), { reply_markup: keyboard });
};

const setDailyReportState = (telegramId: string, state: DailyReportState): void => {
  dailyReportStates.set(telegramId, state);
};

const startWizard = async (ctx: Context, report: DailyReportRow, telegramId: string, userId: string): Promise<void> => {
  const nextKey = getFirstUnfilledStep(report);
  setDailyReportState(telegramId, { reportId: report.id, userId, stepKey: nextKey, awaitingText: false });
  await renderStep(ctx, report, nextKey);
};

const renderStep = async (ctx: Context, report: DailyReportRow, key: DailyReportFieldKey): Promise<void> => {
  const def = dailyReportFieldMap[key];
  const type = def.type ?? 'text';
  const promptLines = [`${def.label}`];
  const current = formatReportValue(report, key);
  promptLines.push(`مقدار فعلی: ${current}`);

  const keyboard = new InlineKeyboard();

  if (type === 'boolean') {
    keyboard.text('✅ بله', `dr:set_bool:${report.id}:${key}:1`).row().text('❌ خیر', `dr:set_bool:${report.id}:${key}:0`);
  } else if (type === 'number') {
    const options = numberOptions[key] ?? [0, 0.5, 1, 1.5, 2];
    options.forEach((opt, idx) => {
      keyboard.text(opt.toString(), `dr:set_num:${report.id}:${key}:${opt}`);
      if (idx % 3 === 2) keyboard.row();
    });
  } else if (type === 'time') {
    const options = timeOptions[key] ?? ['21:00', '22:00', '23:00'];
    options.forEach((opt, idx) => {
      keyboard.text(opt, `dr:set_time:${report.id}:${key}:${opt}`);
      if (idx % 3 === 2) keyboard.row();
    });
  } else if (type === 'text') {
    if (ctx.from) {
      setDailyReportState(String(ctx.from.id), { reportId: report.id, userId: report.user_id, stepKey: key, awaitingText: true });
    }
    keyboard.text('⏭️ رد کردن', `dr:skip:${report.id}:${key}`);
    keyboard.row().text('✖️ لغو', `dr:cancel:${report.id}`);
    keyboard.row().text('⬅️ خانه', 'dr:home');
    const prompt = `${promptLines.join('\n')}\n\nمتن جدید را ارسال کن.`;
    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(prompt, { reply_markup: keyboard });
      } catch {
        await ctx.reply(prompt, { reply_markup: keyboard });
      }
    } else {
      await ctx.reply(`${promptLines.join('\n')}\n\nمتن جدید را ارسال کن.`, { reply_markup: keyboard });
    }
    return;
  }

  keyboard.row().text('⏭️ رد کردن', `dr:skip:${report.id}:${key}`).row().text('✖️ لغو', `dr:cancel:${report.id}`).row().text('⬅️ خانه', 'dr:home');

  const prompt = promptLines.join('\n');
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(prompt, { reply_markup: keyboard });
      return;
    } catch {
      // fallback
    }
  }

  await ctx.reply(prompt, { reply_markup: keyboard });
};

const advanceWizard = async (ctx: Context, telegramId: string, reportId: string, nextKey: DailyReportFieldKey | null): Promise<void> => {
  const report = await getReportById(reportId);
  if (!report) {
    await ctx.reply('گزارش پیدا نشد.');
    clearDailyReportState(telegramId);
    return;
  }

  if (!nextKey) {
    clearDailyReportState(telegramId);
    await renderDailyReportOverview(ctx, report, undefined);
    return;
  }

  setDailyReportState(telegramId, { reportId, userId: report.user_id, stepKey: nextKey, awaitingText: false });
  await renderStep(ctx, report, nextKey);
};

const handleFieldUpdate = async (
  ctx: Context,
  telegramId: string,
  reportId: string,
  key: DailyReportFieldKey,
  value: unknown
): Promise<void> => {
  try {
    const report = await getReportById(reportId);
    if (!report) {
      await ctx.reply('گزارش پیدا نشد.');
      return;
    }

    await updateReportFields(reportId, { [key]: value } as DailyReportPatch);
    console.log({ scope: 'daily_reports', event: 'update_ok', telegramId, reportId, stepKey: key });
    const nextKey = getNextStepKey(key);
    await advanceWizard(ctx, telegramId, reportId, nextKey);
  } catch (error) {
    console.error({ scope: 'daily_reports', event: 'update_error', telegramId, reportId, stepKey: key, error });
    await ctx.reply('❌ خطا در به‌روزرسانی فیلد.');
  }
};

// ===== Commands / main menus =====

bot.command('start', async (ctx: Context) => {
  await sendHome(ctx);
});

bot.command('home', async (ctx: Context) => {
  await sendHome(ctx);
});

// ===== Reminders main menu =====

bot.callbackQuery('reminders:menu', async (ctx) => {
  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageText('🔔 مدیریت یادآوری‌ها\nیکی از گزینه‌های زیر را انتخاب کن.', {
      reply_markup: remindersMenuKeyboard
    });
  } catch {
    await ctx.reply('🔔 مدیریت یادآوری‌ها\nیکی از گزینه‌های زیر را انتخاب کن.', {
      reply_markup: remindersMenuKeyboard
    });
  }
});

bot.callbackQuery('reminders:back_home', async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendHome(ctx, true);
});

// ===== Daily report menus =====

bot.callbackQuery('dr:menu', async (ctx) => {
  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageText('📒 گزارش روزانه', { reply_markup: dailyReportMenuKeyboard });
  } catch {
    await ctx.reply('📒 گزارش روزانه', { reply_markup: dailyReportMenuKeyboard });
  }
});

bot.callbackQuery('dr:home', async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendHome(ctx, true);
});

bot.callbackQuery('dr:today', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const telegramId = String(ctx.from.id);
  const username = ctx.from.username ?? null;

  try {
    const user = await ensureUser({ telegramId, username });
    const report = await getOrCreateTodayReport({ userId: user.id, timezone: user.timezone ?? config.defaultTimezone });
    console.log({ scope: 'daily_reports', event: 'open', telegramId, userId: user.id, reportId: report.id });
    await renderDailyReportOverview(ctx, report, user.timezone);
  } catch (error) {
    console.error({ scope: 'daily_reports', event: 'open_error', telegramId, error });
    await ctx.reply('❌ خطا در باز کردن گزارش روزانه.', { reply_markup: homeKeyboard });
  }
});

bot.callbackQuery('dr:list', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const telegramId = String(ctx.from.id);
  const username = ctx.from.username ?? null;

  try {
    const user = await ensureUser({ telegramId, username });
    const reports = await listRecentReports(user.id, 5);
    console.log({ scope: 'daily_reports', event: 'list', telegramId, userId: user.id, count: reports.length });

    if (!reports.length) {
      const text = '📋 هنوز گزارشی ثبت نکرده‌ای.';
      try {
        await ctx.editMessageText(text, { reply_markup: dailyReportMenuKeyboard });
        return;
      } catch {
        // fallback
      }
      await ctx.reply(text, { reply_markup: dailyReportMenuKeyboard });
      return;
    }

    const keyboard = new InlineKeyboard();
    reports.forEach((report, idx) => {
      keyboard.text(`📄 ${idx + 1}) ${report.report_date}`, `dr:view:${report.id}`).row();
    });
    keyboard.text('⬅️ خانه', 'dr:home');

    const lines = ['📋 گزارش‌های اخیر:'];
    reports.forEach((r, idx) => lines.push(`${idx + 1}) ${r.report_date}`));

    try {
      await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard });
      return;
    } catch {
      // fallback
    }
    await ctx.reply(lines.join('\n'), { reply_markup: keyboard });
  } catch (error) {
    console.error({ scope: 'daily_reports', event: 'list_error', telegramId, error });
    await ctx.reply('❌ خطا در دریافت گزارش‌ها.', { reply_markup: dailyReportMenuKeyboard });
  }
});

bot.callbackQuery(/^dr:view:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reportId = ctx.match?.[1];
  if (!reportId) return;

  try {
    const report = await getReportById(reportId);
    if (!report) {
      await ctx.reply('گزارش پیدا نشد.');
      return;
    }

    const keyboard = new InlineKeyboard()
      .text('▶️ ویرایش', `dr:wizard_start:${report.id}`)
      .row()
      .text('⬅️ بازگشت به لیست', 'dr:list')
      .row()
      .text('⬅️ خانه', 'dr:home');

    const lines = ['📄 گزارش', `تاریخ: ${report.report_date}`, ''];
    DAILY_REPORT_FIELD_DEFINITIONS.forEach((def) => {
      lines.push(`${def.label}: ${formatReportValue(report, def.key)}`);
    });

    try {
      await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard });
      return;
    } catch {
      // fallback
    }
    await ctx.reply(lines.join('\n'), { reply_markup: keyboard });
  } catch (error) {
    console.error({ scope: 'daily_reports', event: 'view_error', reportId, error });
    await ctx.reply('❌ خطا در نمایش گزارش.', { reply_markup: dailyReportMenuKeyboard });
  }
});

bot.callbackQuery(/^dr:summary:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reportId = ctx.match?.[1];
  if (!reportId) return;
  const report = await getReportById(reportId);
  if (!report) {
    await ctx.reply('گزارش پیدا نشد.');
    return;
  }
  console.log({ scope: 'daily_reports', event: 'summary', reportId });
  await renderReportSummary(ctx, report);
});

bot.callbackQuery(/^dr:today_resume:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reportId = ctx.match?.[1];
  if (!reportId) return;
  const report = await getReportById(reportId);
  if (!report) {
    await ctx.reply('گزارش پیدا نشد.');
    return;
  }
  await renderDailyReportOverview(ctx, report, undefined);
});

bot.callbackQuery(/^dr:wizard_start:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const telegramId = String(ctx.from.id);
  const reportId = ctx.match?.[1];
  if (!reportId) return;

  try {
    const report = await getReportById(reportId);
    if (!report) {
      await ctx.reply('گزارش پیدا نشد.');
      return;
    }
    setDailyReportState(telegramId, { reportId, userId: report.user_id, stepKey: reportStepOrder[0], awaitingText: false });
    await startWizard(ctx, report, telegramId, report.user_id);
  } catch (error) {
    console.error({ scope: 'daily_reports', event: 'start_error', reportId, error });
    await ctx.reply('❌ خطا در شروع ویرایش گزارش.', { reply_markup: dailyReportMenuKeyboard });
  }
});

bot.callbackQuery(/^dr:field:([^:]+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const key = ctx.match?.[1] as DailyReportFieldKey | undefined;
  const reportId = ctx.match?.[2];
  if (!key || !reportId) return;

  const report = await getReportById(reportId);
  if (!report) {
    await ctx.reply('گزارش پیدا نشد.');
    return;
  }

  setDailyReportState(String(ctx.from.id), { reportId, userId: report.user_id, stepKey: key, awaitingText: false });
  await renderStep(ctx, report, key);
});

bot.callbackQuery(/^dr:set_bool:([^:]+):([^:]+):([01])$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const reportId = ctx.match?.[1];
  const key = ctx.match?.[2] as DailyReportFieldKey | undefined;
  const val = ctx.match?.[3] === '1';
  if (!reportId || !key) return;

  await handleFieldUpdate(ctx, String(ctx.from.id), reportId, key, val);
});

bot.callbackQuery(/^dr:set_num:([^:]+):([^:]+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const reportId = ctx.match?.[1];
  const key = ctx.match?.[2] as DailyReportFieldKey | undefined;
  const num = Number(ctx.match?.[3]);
  if (!reportId || !key || Number.isNaN(num)) return;

  await handleFieldUpdate(ctx, String(ctx.from.id), reportId, key, num);
});

bot.callbackQuery(/^dr:set_time:([^:]+):([^:]+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const reportId = ctx.match?.[1];
  const key = ctx.match?.[2] as DailyReportFieldKey | undefined;
  const time = ctx.match?.[3];
  if (!reportId || !key || !time) return;

  await handleFieldUpdate(ctx, String(ctx.from.id), reportId, key, time);
});

bot.callbackQuery(/^dr:skip:([^:]+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const reportId = ctx.match?.[1];
  const key = ctx.match?.[2] as DailyReportFieldKey | undefined;
  if (!reportId || !key) return;

  await handleFieldUpdate(ctx, String(ctx.from.id), reportId, key, null);
});

bot.callbackQuery(/^dr:cancel:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const reportId = ctx.match?.[1];
  const telegramId = String(ctx.from.id);
  clearDailyReportState(telegramId);
  const report = reportId ? await getReportById(reportId) : null;
  if (report) {
    await renderDailyReportOverview(ctx, report, undefined);
  } else {
    await ctx.reply('فرآیند لغو شد.', { reply_markup: dailyReportMenuKeyboard });
  }
});

// ===== Reminders list / manage =====

bot.callbackQuery('reminders:list', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const telegramId = String(ctx.from.id);

  try {
    await renderRemindersList(ctx, telegramId);
  } catch (error) {
    console.error({ scope: 'reminders', event: 'list_manage_error', telegramId, error });
    await ctx.reply('❌ خطا در دریافت لیست یادآوری‌ها.', { reply_markup: remindersMenuKeyboard });
  }
});

bot.callbackQuery(/^reminders:manage:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reminderId = ctx.match?.[1];
  if (!reminderId) return;
  try {
    await renderManageView(ctx, reminderId);
  } catch (error) {
    console.error({ scope: 'reminders', event: 'manage_error', reminderId, error });
    await ctx.reply('❌ خطا در نمایش یادآوری.', { reply_markup: remindersMenuKeyboard });
  }
});

// ===== Reminder creation flow =====

bot.callbackQuery('reminders:new', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const telegramId = String(ctx.from.id);
  reminderStates.set(telegramId, { stage: 'create_title' });

  const prompt = '✏️ لطفاً عنوان یادآوری را بنویس.\nمثال: دارو، تماس، تمرین و ...';
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(prompt);
      return;
    } catch {
      // fallthrough
    }
  }
  await ctx.reply(prompt);
});

// ===== Text handler for reminder and daily report flows =====

bot.on('message:text', async (ctx: Context) => {
  if (!ctx.from || !ctx.message || typeof ctx.message.text !== 'string') return;

  const telegramId = String(ctx.from.id);
  const text = ctx.message.text.trim();

  // Reminder flow
  const reminderState = reminderStates.get(telegramId);
  if (reminderState) {
    if (reminderState.stage === 'create_title') {
      if (!text) {
        await ctx.reply('❗ عنوان معتبر نیست. دوباره امتحان کن.');
        return;
      }

      reminderStates.set(telegramId, { stage: 'create_detail', title: text, detail: null });
      await ctx.reply('📝 اگر توضیحی برای این یادآوری داری بنویس.\nاگر نمی‌خواهی توضیح اضافه کنی، روی «⏭ بدون توضیحات» بزن.', {
        reply_markup: skipDetailKeyboard
      });
      return;
    }

    if (reminderState.stage === 'create_detail') {
      reminderStates.set(telegramId, { ...reminderState, detail: text, stage: 'create_delay' });
      await ctx.reply('⏰ چه زمانی بهت یادآوری کنم؟', { reply_markup: buildCreateDelayKeyboard() });
      return;
    }

    if (reminderState.stage === 'edit_title' && reminderState.reminderId) {
      try {
        const updated = await updateReminder(reminderState.reminderId, { title: text });
        console.log({ scope: 'reminders', event: 'manage_edit_title', reminderId: updated.id });
        clearReminderState(telegramId);
        await renderManageView(ctx, updated.id);
      } catch (error) {
        console.error({ scope: 'reminders', event: 'manage_edit_title_error', reminderId: reminderState.reminderId, error });
        await ctx.reply('❌ خطا در ویرایش عنوان.', { reply_markup: remindersMenuKeyboard });
      }
      return;
    }

    if (reminderState.stage === 'edit_detail' && reminderState.reminderId) {
      try {
        const updated = await updateReminder(reminderState.reminderId, { detail: text });
        console.log({ scope: 'reminders', event: 'manage_edit_detail', reminderId: updated.id });
        clearReminderState(telegramId);
        await renderManageView(ctx, updated.id);
      } catch (error) {
        console.error({ scope: 'reminders', event: 'manage_edit_detail_error', reminderId: reminderState.reminderId, error });
        await ctx.reply('❌ خطا در ویرایش توضیحات.', { reply_markup: remindersMenuKeyboard });
      }
      return;
    }
  }

  // Daily report wizard text steps
  const drState = dailyReportStates.get(telegramId);
  if (drState) {
    const report = await getReportById(drState.reportId);
    if (!report) {
      clearDailyReportState(telegramId);
      await ctx.reply('گزارش پیدا نشد.');
      return;
    }

    const def = dailyReportFieldMap[drState.stepKey];
    if (def?.type === 'text') {
      if (!text) {
        await ctx.reply('❗ متن خالی است. دوباره امتحان کن.');
        return;
      }

      await handleFieldUpdate(ctx, telegramId, drState.reportId, drState.stepKey, text);
      return;
    }
  }
});

// ===== Callbacks for reminder detail skip / delay selection =====

bot.callbackQuery('reminders:create_skip_detail', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const telegramId = String(ctx.from.id);
  const state = reminderStates.get(telegramId);
  if (!state || state.stage !== 'create_detail') return;

  reminderStates.set(telegramId, { ...state, detail: null, stage: 'create_delay' });
  await ctx.editMessageText('⏰ چه زمانی بهت یادآوری کنم؟', { reply_markup: buildCreateDelayKeyboard() });
});

bot.callbackQuery(/^reminders:new_delay:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const delayMinutes = Number(ctx.match?.[1] ?? 'NaN');
  await handleCreateDelay(ctx, delayMinutes);
});

bot.callbackQuery('reminders:cancel', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const telegramId = String(ctx.from.id);
  clearReminderState(telegramId);
  await ctx.editMessageText('❌ ایجاد یادآوری لغو شد.', { reply_markup: remindersMenuKeyboard });
});

// ===== Reminder manage actions =====

bot.callbackQuery(/^reminders:edit_title:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reminderId = ctx.match?.[1];
  if (!reminderId || !ctx.from) return;
  const telegramId = String(ctx.from.id);
  reminderStates.set(telegramId, { stage: 'edit_title', reminderId });
  await ctx.reply('✏️ عنوان جدید یادآوری را بنویس.');
});

bot.callbackQuery(/^reminders:edit_detail:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reminderId = ctx.match?.[1];
  if (!reminderId || !ctx.from) return;
  const telegramId = String(ctx.from.id);
  reminderStates.set(telegramId, { stage: 'edit_detail', reminderId });
  await ctx.reply('📝 توضیحات جدید را بنویس.\nبرای حذف توضیح از «⏭ حذف توضیحات» استفاده کن.');
});

bot.callbackQuery(/^reminders:clear_detail:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reminderId = ctx.match?.[1];
  if (!reminderId) return;
  try {
    const updated = await updateReminder(reminderId, { detail: null });
    console.log({ scope: 'reminders', event: 'manage_clear_detail', reminderId: updated.id });
    await renderManageView(ctx, updated.id);
  } catch (error) {
    console.error({ scope: 'reminders', event: 'manage_clear_detail_error', reminderId, error });
    await ctx.reply('❌ خطا در حذف توضیحات.', { reply_markup: remindersMenuKeyboard });
  }
});

bot.callbackQuery(/^reminders:toggle:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reminderId = ctx.match?.[1];
  if (!reminderId) return;
  try {
    const updated = await toggleReminderEnabled(reminderId);
    console.log({ scope: 'reminders', event: 'manage_toggle', reminderId: updated.id, enabled: updated.enabled });
    await renderManageView(ctx, updated.id);
  } catch (error) {
    console.error({ scope: 'reminders', event: 'manage_toggle_error', reminderId, error });
    await ctx.reply('❌ خطا در تغییر وضعیت یادآوری.', { reply_markup: remindersMenuKeyboard });
  }
});

bot.callbackQuery(/^reminders:edit_time:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reminderId = ctx.match?.[1];
  if (!reminderId) return;
  const keyboard = buildEditDelayKeyboard(reminderId);
  try {
    await ctx.editMessageText('⏱ یک بازه زمانی انتخاب کن.', { reply_markup: keyboard });
  } catch {
    await ctx.reply('⏱ یک بازه زمانی انتخاب کن.', { reply_markup: keyboard });
  }
});

bot.callbackQuery(/^reminders:edit_delay:([^:]+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reminderId = ctx.match?.[1];
  const delayMinutes = Number(ctx.match?.[2] ?? 'NaN');
  if (!reminderId || Number.isNaN(delayMinutes)) return;

  try {
    const nextRunUtc = new Date(Date.now() + delayMinutes * 60 * 1000);
    const updated = await updateReminder(reminderId, { nextRunAtUtc: nextRunUtc, enabled: true });
    console.log({ scope: 'reminders', event: 'manage_edit_time', reminderId: updated.id, delayMinutes });
    await renderManageView(ctx, updated.id);
  } catch (error) {
    console.error({ scope: 'reminders', event: 'manage_edit_time_error', reminderId, error });
    await ctx.reply('❌ خطا در تغییر زمان یادآوری.', { reply_markup: remindersMenuKeyboard });
  }
});

bot.callbackQuery(/^reminders:delete:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reminderId = ctx.match?.[1];
  if (!reminderId) return;
  try {
    await deleteReminder(reminderId);
    console.log({ scope: 'reminders', event: 'manage_delete', reminderId });
    await ctx.editMessageText('🗑 یادآوری حذف شد.', { reply_markup: deletedReminderKeyboard });
  } catch (error) {
    console.error({ scope: 'reminders', event: 'manage_delete_error', reminderId, error });
    await ctx.reply('❌ خطا در حذف یادآوری.', { reply_markup: remindersMenuKeyboard });
  }
});

// ===== Global error handler =====

bot.catch((err: BotError<Context>) => {
  const { ctx, error } = err;
  console.error('Bot error:', {
    updateId: ctx.update?.update_id,
    error
  });
});
