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
import { computeCompletionStatus, getReportById, listRecentReports, updateReport, upsertTodayReport } from './services/dailyReports';
import { formatInstantToLocal, formatLocalTime } from './utils/time';
import type { DailyReportRow, DailyReportUpdate, ReminderRow } from './types/supabase';

export const bot = new Bot(config.telegram.botToken);

// ===== Inline keyboards (no ReplyKeyboard) =====

const homeKeyboard = new InlineKeyboard().text('🗒️ گزارش روزانه', 'daily:menu').row().text('🔔 یادآوری‌ها', 'reminders:menu');

const remindersMenuKeyboard = new InlineKeyboard()
  .text('➕ یادآوری جدید', 'reminders:new')
  .row()
  .text('📋 لیست و مدیریت یادآوری‌ها', 'reminders:list')
  .row()
  .text('⬅️ خانه', 'home:back');

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

const dailyMenuKeyboard = new InlineKeyboard()
  .text('➕ ثبت/ویرایش گزارش امروز', 'daily:today')
  .row()
  .text('📋 لیست گزارش‌ها', 'daily:list')
  .row()
  .text('⬅️ خانه', 'home:back');

// ===== Reminder state =====

type ReminderStage = 'create_title' | 'create_detail' | 'create_delay' | 'edit_title' | 'edit_detail';
type ReminderState = {
  stage: ReminderStage;
  reminderId?: string;
  title?: string;
  detail?: string | null;
};

const reminderStates = new Map<string, ReminderState>();

const clearReminderState = (telegramId: string): void => {
  reminderStates.delete(telegramId);
};

// ===== Daily report wizard definitions =====

type FieldType = 'boolean' | 'number' | 'integer' | 'time' | 'text';
type DailyField = { key: keyof DailyReportRow; label: string; type: FieldType };

const dailyFields: DailyField[] = [
  { key: 'wake_time', label: 'زمان بیداری', type: 'time' },
  { key: 'weekday', label: 'روز هفته', type: 'text' },
  { key: 'routine_morning', label: 'روتین صبح', type: 'boolean' },
  { key: 'routine_school', label: 'روتین مدرسه', type: 'boolean' },
  { key: 'routine_taxi', label: 'روتین تاکسی', type: 'boolean' },
  { key: 'routine_evening', label: 'روتین عصر', type: 'boolean' },
  { key: 'routine_night', label: 'روتین شب', type: 'boolean' },
  { key: 'review_today_hours', label: 'مرور دروس امروز (ساعت)', type: 'number' },
  { key: 'preview_tomorrow_hours', label: 'پیش‌خوانی دروس فردا (ساعت)', type: 'number' },
  { key: 'homework_done', label: 'تکالیف', type: 'boolean' },
  { key: 'workout_morning', label: 'ورزش صبح', type: 'boolean' },
  { key: 'workout_night', label: 'ورزش شب', type: 'boolean' },
  { key: 'pomodoro_3_count', label: 'چند 3 پارتی؟', type: 'integer' },
  { key: 'pomodoro_2_count', label: 'چند 2 پارتی؟', type: 'integer' },
  { key: 'pomodoro_1_count', label: 'چند 1 پارتی؟', type: 'integer' },
  { key: 'city_library_hours', label: 'مطالعه در کتابخانه شهر (ساعت)', type: 'number' },
  { key: 'exam_school_questions', label: 'آزمون مدرسه', type: 'integer' },
  { key: 'exam_maz_questions', label: 'آزمون ماز', type: 'integer' },
  { key: 'exam_hesaban_questions', label: 'آزمون حسابان', type: 'integer' },
  { key: 'exam_physics_questions', label: 'آزمون فیزیک', type: 'integer' },
  { key: 'exam_chemistry_questions', label: 'آزمون شیمی', type: 'integer' },
  { key: 'exam_geology_questions', label: 'آزمون زمین‌شناسی', type: 'integer' },
  { key: 'exam_language_questions', label: 'آزمون زبان', type: 'integer' },
  { key: 'exam_religion_questions', label: 'آزمون دینی', type: 'integer' },
  { key: 'exam_arabic_questions', label: 'آزمون عربی', type: 'integer' },
  { key: 'exam_farsi_questions', label: 'آزمون فارسی', type: 'integer' },
  { key: 'exam_philosophy_questions', label: 'آزمون فلسفه و منطق', type: 'integer' },
  { key: 'exam_sociology_questions', label: 'آزمون جامعه‌شناسی', type: 'integer' },
  { key: 'exam_konkur_questions', label: 'آزمون کنکور', type: 'integer' },
  { key: 'non_academic_book_hours', label: 'مطالعه غیر درسی - کتاب', type: 'number' },
  { key: 'non_academic_article_hours', label: 'مطالعه غیر درسی - مقاله', type: 'number' },
  { key: 'non_academic_video_hours', label: 'مطالعه غیر درسی - ویدیو', type: 'number' },
  { key: 'non_academic_course_hours', label: 'مطالعه غیر درسی - دوره', type: 'number' },
  { key: 'english_content_hours', label: 'English - تولید محتوا', type: 'number' },
  { key: 'english_speaking_hours', label: 'English - تمرین مکالمه', type: 'number' },
  { key: 'english_class_hours', label: 'English - کلاس زبان', type: 'number' },
  { key: 'extra_skill_learning', label: 'یادگیری مهارت خاص', type: 'boolean' },
  { key: 'extra_telegram_bot', label: 'ساخت ربات تلگرام', type: 'boolean' },
  { key: 'extra_trading_strategy', label: 'استراتژی ترید', type: 'boolean' },
  { key: 'organize_study_space', label: 'مرتب‌سازی محیط مطالعه', type: 'boolean' },
  { key: 'clean_room', label: 'جارو و گردگیری اتاق', type: 'boolean' },
  { key: 'plan_tomorrow', label: 'برنامه‌ریزی فردا', type: 'boolean' },
  { key: 'family_time_hours', label: 'زمان با خانواده (ساعت)', type: 'number' },
  { key: 'planned_study_hours', label: 'زمان تحت برنامه - مطالعه', type: 'number' },
  { key: 'planned_skills_hours', label: 'زمان تحت برنامه - مهارت‌ها', type: 'number' },
  { key: 'planned_misc_hours', label: 'زمان تحت برنامه - متفرقه', type: 'number' },
  { key: 'streak_done', label: 'Streak - Done', type: 'boolean' },
  { key: 'streak_days', label: 'Streak - Days', type: 'integer' },
  { key: 'xp_s', label: 'XP S', type: 'integer' },
  { key: 'xp_study', label: 'XP درسی', type: 'integer' },
  { key: 'xp_misc', label: 'XP متفرقه', type: 'integer' },
  { key: 'xp_total', label: 'XP کل روز', type: 'integer' },
  { key: 'sleep_time', label: 'زمان خواب', type: 'time' },
  { key: 'note', label: 'توضیحات', type: 'text' }
];

type DailyWizardState = {
  reportId: string;
  userId: string;
  stepIndex: number;
  tempNumber?: number;
  timeHour?: number;
  awaitingText?: boolean;
};

const dailyWizardStates = new Map<string, DailyWizardState>();

const clearDailyState = (telegramId: string): void => {
  dailyWizardStates.delete(telegramId);
};

const nextStepIndex = (currentIndex: number): number | null => {
  if (currentIndex < 0 || currentIndex >= dailyFields.length - 1) return null;
  return currentIndex + 1;
};

const firstUnfilledStepIndex = (report: DailyReportRow): number => {
  const statuses = computeCompletionStatus(report);
  const firstEmptyKey = statuses.find((s) => !s.filled)?.key;
  const idx = firstEmptyKey ? dailyFields.findIndex((f) => f.key === firstEmptyKey) : -1;
  return idx >= 0 ? idx : 0;
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

// ===== Reminders helpers =====

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

const formatReportValue = (report: DailyReportRow, key: keyof DailyReportRow): string => {
  const value = report[key];
  if (typeof value === 'boolean') return value ? 'بله' : 'خیر';
  if (typeof value === 'number') return value.toString();
  if (typeof value === 'string' && value.trim().length > 0) return value;
  return '—';
};

const buildDailyMenuText = (report: DailyReportRow, timezone?: string | null): string => {
  const local = formatLocalTime(timezone ?? config.defaultTimezone);
  const status = computeCompletionStatus(report);
  const lines = [
    '🗒️ گزارش روزانه',
    `تاریخ: ${report.report_date}`,
    `زمان محلی: ${local.date} | ${local.time} (${local.timezone})`,
    '',
    'وضعیت تکمیل:'
  ];
  status.forEach((s) => {
    const def = dailyFields.find((f) => f.key === s.key);
    if (def) {
      lines.push(`${s.filled ? '✅' : '⬜'} ${def.label}`);
    }
  });
  return lines.join('\n');
};

const renderDailyMenu = async (ctx: Context, report: DailyReportRow, timezone?: string | null): Promise<void> => {
  const text = buildDailyMenuText(report, timezone);
  const statuses = computeCompletionStatus(report);
  const keyboard = new InlineKeyboard();
  statuses.forEach((s, idx) => {
    const label = `${s.filled ? '✅' : '⬜'} ${dailyFields.find((f) => f.key === s.key)?.label ?? s.key}`;
    keyboard.text(label, `daily:field:${s.key}:${report.id}`);
    if (idx % 2 === 1) keyboard.row();
  });
  keyboard
    .row()
    .text('▶️ تکمیل / ویرایش موارد', `daily:wizard_start:${report.id}`)
    .row()
    .text('🧾 مشاهده خلاصه امروز', `daily:summary:${report.id}`)
    .row()
    .text('⬅️ خانه', 'home:back');
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { reply_markup: keyboard });
      return;
    } catch {
      // fallback
    }
  }
  await ctx.reply(text, { reply_markup: keyboard });
};

const renderDailySummary = async (ctx: Context, report: DailyReportRow): Promise<void> => {
  const lines: string[] = [`🧾 خلاصه گزارش (${report.report_date})`, ''];
  dailyFields.forEach((f) => {
    lines.push(`${f.label}: ${formatReportValue(report, f.key)}`);
  });

  const keyboard = new InlineKeyboard()
    .text('✏️ ویرایش', `daily:wizard_start:${report.id}`)
    .row()
    .text('⬅️ بازگشت', 'daily:list')
    .row()
    .text('⬅️ خانه', 'home:back');

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

const renderWizardStep = async (ctx: Context, report: DailyReportRow, state: DailyWizardState): Promise<void> => {
  const field = dailyFields[state.stepIndex];
  const currentVal = report[field.key];
  const textParts = [`${field.label}`, `مقدار فعلی: ${formatReportValue(report, field.key)}`];
  const keyboard = new InlineKeyboard();

  if (field.type === 'boolean') {
    keyboard.text('✅ بله', `daily:set_bool:${report.id}:${field.key}:1`).row().text('❌ خیر', `daily:set_bool:${report.id}:${field.key}:0`);
    keyboard.row().text('⏭️ رد کن', `daily:skip:${report.id}:${field.key}`).row().text('✖️ لغو', `daily:cancel:${report.id}`).row().text('⬅️ خانه', 'home:back');
    const prompt = textParts.join('\n');
    await ctx.editMessageText(prompt, { reply_markup: keyboard }).catch(async () => {
      await ctx.reply(prompt, { reply_markup: keyboard });
    });
    return;
  }

  if (field.type === 'number' || field.type === 'integer') {
    const delta = field.type === 'integer' ? 1 : 0.25;
    const value = typeof state.tempNumber === 'number' ? state.tempNumber : typeof currentVal === 'number' ? currentVal : 0;
    keyboard
      .text(`-${delta}`, `daily:num_step:${report.id}:${field.key}:-${delta}`)
      .text('0', `daily:num_reset:${report.id}:${field.key}`)
      .text(`+${delta}`, `daily:num_step:${report.id}:${field.key}:${delta}`)
      .row()
      .text('✅ تایید', `daily:num_confirm:${report.id}:${field.key}`)
      .row()
      .text('⏭️ رد کن', `daily:skip:${report.id}:${field.key}`)
      .row()
      .text('✖️ لغو', `daily:cancel:${report.id}`)
      .row()
      .text('⬅️ خانه', 'home:back');
    const prompt = `${textParts.join('\n')}\nمقدار در حال تنظیم: ${value}`;
    await ctx.editMessageText(prompt, { reply_markup: keyboard }).catch(async () => {
      await ctx.reply(prompt, { reply_markup: keyboard });
    });
    return;
  }

  if (field.type === 'time') {
    if (state.timeHour === undefined) {
      const hours = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4];
      hours.forEach((hour, idx) => {
        keyboard.text(hour.toString().padStart(2, '0'), `daily:time_hour:${report.id}:${field.key}:${hour}`);
        if (idx % 4 === 3) keyboard.row();
      });
      keyboard.row().text('⏭️ رد کن', `daily:skip:${report.id}:${field.key}`).row().text('✖️ لغو', `daily:cancel:${report.id}`).row().text('⬅️ خانه', 'home:back');
      const prompt = `${textParts.join('\n')}\nساعت خواب/بیداری را انتخاب کن.`;
      await ctx.editMessageText(prompt, { reply_markup: keyboard }).catch(async () => {
        await ctx.reply(prompt, { reply_markup: keyboard });
      });
    } else {
      const minutes = ['00', '15', '30', '45'];
      minutes.forEach((min, idx) => {
        keyboard.text(min, `daily:time_min:${report.id}:${field.key}:${state.timeHour}:${min}`);
        if (idx % 4 === 3) keyboard.row();
      });
      keyboard.row().text('⏭️ رد کن', `daily:skip:${report.id}:${field.key}`).row().text('✖️ لغو', `daily:cancel:${report.id}`).row().text('⬅️ خانه', 'home:back');
      const prompt = `${textParts.join('\n')}\nدقیقه را انتخاب کن (ساعت ${state.timeHour.toString().padStart(2, '0')}).`;
      await ctx.editMessageText(prompt, { reply_markup: keyboard }).catch(async () => {
        await ctx.reply(prompt, { reply_markup: keyboard });
      });
    }
    return;
  }

  if (field.type === 'text') {
    dailyWizardStates.set(String(ctx.from?.id ?? ''), { ...state, awaitingText: true });
    keyboard.text('⏭️ رد کن', `daily:skip:${report.id}:${field.key}`).row().text('✖️ لغو', `daily:cancel:${report.id}`).row().text('⬅️ خانه', 'home:back');
    const prompt = `${textParts.join('\n')}\n\nمتن جدید را ارسال کن.`;
    await ctx.editMessageText(prompt, { reply_markup: keyboard }).catch(async () => {
      await ctx.reply(prompt, { reply_markup: keyboard });
    });
  }
};

const goToStep = async (ctx: Context, report: DailyReportRow, stepIndex: number, extra?: Partial<DailyWizardState>): Promise<void> => {
  const telegramId = String(ctx.from?.id ?? '');
  const state: DailyWizardState = {
    reportId: report.id,
    userId: report.user_id,
    stepIndex,
    tempNumber: extra?.tempNumber,
    timeHour: extra?.timeHour,
    awaitingText: extra?.awaitingText
  };
  dailyWizardStates.set(telegramId, state);
  await renderWizardStep(ctx, report, state);
};

const advanceWizard = async (ctx: Context, reportId: string, currentIndex: number): Promise<void> => {
  const report = await getReportById(reportId);
  if (!report) {
    await ctx.reply('گزارش پیدا نشد.');
    clearDailyState(String(ctx.from?.id ?? ''));
    return;
  }
  const nextIndex = nextStepIndex(currentIndex);
  if (nextIndex === null) {
    clearDailyState(String(ctx.from?.id ?? ''));
    await renderDailyMenu(ctx, report, undefined);
    return;
  }
  await goToStep(ctx, report, nextIndex);
};

const startWizardFrom = async (ctx: Context, report: DailyReportRow, startIndex?: number): Promise<void> => {
  const idx = typeof startIndex === 'number' ? startIndex : firstUnfilledStepIndex(report);
  await goToStep(ctx, report, idx);
};

// ===== Commands / main menus =====

bot.command('start', async (ctx: Context) => {
  await sendHome(ctx);
});

bot.command('home', async (ctx: Context) => {
  await sendHome(ctx);
});

// ===== Home/back navigation =====

bot.callbackQuery('home:back', async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendHome(ctx, true);
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

// ===== Daily report menus =====

bot.callbackQuery('daily:menu', async (ctx) => {
  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageText('📒 گزارش روزانه', { reply_markup: dailyMenuKeyboard });
  } catch {
    await ctx.reply('📒 گزارش روزانه', { reply_markup: dailyMenuKeyboard });
  }
});

bot.callbackQuery('daily:today', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const telegramId = String(ctx.from.id);
  const username = ctx.from.username ?? null;

  try {
    const user = await ensureUser({ telegramId, username });
    const report = await upsertTodayReport({ userId: user.id, timezone: user.timezone ?? config.defaultTimezone });
    console.log({ scope: 'daily_reports', event: 'open', telegramId, userId: user.id, reportId: report.id });
    await renderDailyMenu(ctx, report, user.timezone);
  } catch (error) {
    console.error({ scope: 'daily_reports', event: 'open_error', telegramId, error });
    await ctx.reply('❌ خطا در باز کردن گزارش روزانه.', { reply_markup: homeKeyboard });
  }
});

bot.callbackQuery('daily:list', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const telegramId = String(ctx.from.id);
  const username = ctx.from.username ?? null;

  try {
    const user = await ensureUser({ telegramId, username });
    const reports = await listRecentReports(user.id, 10);
    console.log({ scope: 'daily_reports', event: 'list', userId: user.id, count: reports.length });

    if (!reports.length) {
      const text = '📋 هنوز گزارشی ثبت نکرده‌ای.';
      await ctx.editMessageText(text, { reply_markup: dailyMenuKeyboard }).catch(async () => {
        await ctx.reply(text, { reply_markup: dailyMenuKeyboard });
      });
      return;
    }

    const keyboard = new InlineKeyboard();
    reports.forEach((report) => {
      keyboard.text(`📅 ${report.report_date}`, `daily:open:${report.id}`).row();
    });
    keyboard.text('⬅️ خانه', 'home:back');

    const lines = ['📋 لیست گزارش‌ها:'];
    reports.forEach((r) => lines.push(`- ${r.report_date}`));
    await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard }).catch(async () => {
      await ctx.reply(lines.join('\n'), { reply_markup: keyboard });
    });
  } catch (error) {
    console.error({ scope: 'daily_reports', event: 'list_error', telegramId, error });
    await ctx.reply('❌ خطا در دریافت گزارش‌ها.', { reply_markup: dailyMenuKeyboard });
  }
});

bot.callbackQuery(/^daily:open:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reportId = ctx.match?.[1];
  if (!reportId) return;
  const report = await getReportById(reportId);
  if (!report) {
    await ctx.reply('گزارش پیدا نشد.');
    return;
  }
  const keyboard = new InlineKeyboard()
    .text('✏️ ویرایش', `daily:wizard_start:${report.id}`)
    .row()
    .text('⬅️ بازگشت', 'daily:list')
    .row()
    .text('⬅️ خانه', 'home:back');
  const lines = [`📄 گزارش (${report.report_date})`, '', ...dailyFields.map((f) => `${f.label}: ${formatReportValue(report, f.key)}`)];
  await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard }).catch(async () => {
    await ctx.reply(lines.join('\n'), { reply_markup: keyboard });
  });
});

bot.callbackQuery(/^daily:summary:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reportId = ctx.match?.[1];
  if (!reportId) return;
  const report = await getReportById(reportId);
  if (!report) {
    await ctx.reply('گزارش پیدا نشد.');
    return;
  }
  console.log({ scope: 'daily_reports', event: 'summary', reportId });
  await renderDailySummary(ctx, report);
});

bot.callbackQuery(/^daily:wizard_start:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reportId = ctx.match?.[1];
  if (!reportId) return;
  const report = await getReportById(reportId);
  if (!report) {
    await ctx.reply('گزارش پیدا نشد.');
    return;
  }
  await startWizardFrom(ctx, report);
});

bot.callbackQuery(/^daily:field:([^:]+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const key = ctx.match?.[1];
  const reportId = ctx.match?.[2];
  if (!key || !reportId) return;
  const report = await getReportById(reportId);
  if (!report) {
    await ctx.reply('گزارش پیدا نشد.');
    return;
  }
  const idx = dailyFields.findIndex((f) => f.key === key);
  if (idx < 0) return;
  await goToStep(ctx, report, idx);
});

// Boolean set
bot.callbackQuery(/^daily:set_bool:([^:]+):([^:]+):([01])$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reportId = ctx.match?.[1];
  const key = ctx.match?.[2] as keyof DailyReportRow | undefined;
  const val = ctx.match?.[3] === '1';
  if (!reportId || !key) return;
  const state = dailyWizardStates.get(String(ctx.from?.id ?? ''));
  const stepIndex = state?.stepIndex ?? dailyFields.findIndex((f) => f.key === key);
  const updated = await updateReport(reportId, { [key]: val } as DailyReportUpdate);
  await advanceWizard(ctx, reportId, stepIndex ?? 0);
});

// Number steppers
bot.callbackQuery(/^daily:num_step:([^:]+):([^:]+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reportId = ctx.match?.[1];
  const key = ctx.match?.[2] as keyof DailyReportRow | undefined;
  const delta = Number(ctx.match?.[3]);
  if (!reportId || !key || Number.isNaN(delta)) return;
  const telegramId = String(ctx.from?.id ?? '');
  const state = dailyWizardStates.get(telegramId);
  if (!state) return;
  const field = dailyFields[state.stepIndex];
  if (!field || field.key !== key) return;
  const report = await getReportById(reportId);
  if (!report) return;
  const current = typeof state.tempNumber === 'number' ? state.tempNumber : typeof report[key] === 'number' ? (report[key] as number) : 0;
  const next = Math.round((current + delta) * 100) / 100;
  await goToStep(ctx, report, state.stepIndex, { ...state, tempNumber: next });
});

bot.callbackQuery(/^daily:num_reset:([^:]+):([^:]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reportId = ctx.match?.[1];
  const key = ctx.match?.[2] as keyof DailyReportRow | undefined;
  if (!reportId || !key) return;
  const telegramId = String(ctx.from?.id ?? '');
  const state = dailyWizardStates.get(telegramId);
  if (!state) return;
  const report = await getReportById(reportId);
  if (!report) return;
  await goToStep(ctx, report, state.stepIndex, { ...state, tempNumber: 0 });
});

bot.callbackQuery(/^daily:num_confirm:([^:]+):([^:]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reportId = ctx.match?.[1];
  const key = ctx.match?.[2] as keyof DailyReportRow | undefined;
  if (!reportId || !key) return;
  const telegramId = String(ctx.from?.id ?? '');
  const state = dailyWizardStates.get(telegramId);
  if (!state) return;
  const value = typeof state.tempNumber === 'number' ? state.tempNumber : 0;
  const stepIndex = state.stepIndex;
  await updateReport(reportId, { [key]: value } as DailyReportUpdate);
  await advanceWizard(ctx, reportId, stepIndex);
});

// Time picker
bot.callbackQuery(/^daily:time_hour:([^:]+):([^:]+):(\d{1,2})$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reportId = ctx.match?.[1];
  const key = ctx.match?.[2] as keyof DailyReportRow | undefined;
  const hour = Number(ctx.match?.[3]);
  if (!reportId || !key || Number.isNaN(hour)) return;
  const telegramId = String(ctx.from?.id ?? '');
  const state = dailyWizardStates.get(telegramId);
  const stepIndex = state?.stepIndex ?? dailyFields.findIndex((f) => f.key === key);
  const report = await getReportById(reportId);
  if (!report) return;
  await goToStep(ctx, report, stepIndex >= 0 ? stepIndex : 0, { timeHour: hour });
});

bot.callbackQuery(/^daily:time_min:([^:]+):([^:]+):(\d{1,2}):(\d{2})$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reportId = ctx.match?.[1];
  const key = ctx.match?.[2] as keyof DailyReportRow | undefined;
  const hour = Number(ctx.match?.[3]);
  const minute = ctx.match?.[4];
  if (!reportId || !key || Number.isNaN(hour) || !minute) return;
  const telegramId = String(ctx.from?.id ?? '');
  const state = dailyWizardStates.get(telegramId);
  const stepIndex = state?.stepIndex ?? dailyFields.findIndex((f) => f.key === key);
  const timeValue = `${hour.toString().padStart(2, '0')}:${minute}`;
  await updateReport(reportId, { [key]: timeValue } as DailyReportUpdate);
  await advanceWizard(ctx, reportId, stepIndex >= 0 ? stepIndex : 0);
});

// Skip / cancel
bot.callbackQuery(/^daily:skip:([^:]+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reportId = ctx.match?.[1];
  const key = ctx.match?.[2] as keyof DailyReportRow | undefined;
  if (!reportId || !key) return;
  const telegramId = String(ctx.from?.id ?? '');
  const state = dailyWizardStates.get(telegramId);
  const stepIndex = state?.stepIndex ?? dailyFields.findIndex((f) => f.key === key);
  await updateReport(reportId, { [key]: null } as DailyReportUpdate);
  await advanceWizard(ctx, reportId, stepIndex >= 0 ? stepIndex : 0);
});

bot.callbackQuery(/^daily:cancel:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reportId = ctx.match?.[1];
  const report = reportId ? await getReportById(reportId) : null;
  clearDailyState(String(ctx.from?.id ?? ''));
  if (report) {
    await renderDailyMenu(ctx, report, undefined);
  } else {
    await ctx.reply('فرآیند لغو شد.', { reply_markup: dailyMenuKeyboard });
  }
});

// Text input step (note, weekday)
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
        clearReminderState(telegramId);
        await renderManageView(ctx, updated.id);
      } catch (error) {
        console.error({ scope: 'reminders', event: 'manage_edit_detail_error', reminderId: reminderState.reminderId, error });
        await ctx.reply('❌ خطا در ویرایش توضیحات.', { reply_markup: remindersMenuKeyboard });
      }
      return;
    }
  }

  // Daily report text fields
  const drState = dailyWizardStates.get(telegramId);
  if (drState && drState.awaitingText) {
    const report = await getReportById(drState.reportId);
    if (!report) {
      clearDailyState(telegramId);
      await ctx.reply('گزارش پیدا نشد.');
      return;
    }
    const field = dailyFields[drState.stepIndex];
    if (field && field.type === 'text') {
      if (!text) {
        await ctx.reply('❗ متن خالی است. دوباره امتحان کن.');
        return;
      }
      await updateReport(report.id, { [field.key]: text } as DailyReportUpdate);
      await advanceWizard(ctx, report.id, drState.stepIndex);
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
  await ctx.editMessageText('⏱ یک بازه زمانی انتخاب کن.', { reply_markup: keyboard }).catch(async () => {
    await ctx.reply('⏱ یک بازه زمانی انتخاب کن.', { reply_markup: keyboard });
  });
});

bot.callbackQuery(/^reminders:edit_delay:([^:]+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reminderId = ctx.match?.[1];
  const delayMinutes = Number(ctx.match?.[2] ?? 'NaN');
  if (!reminderId || Number.isNaN(delayMinutes)) return;

  try {
    const nextRunUtc = new Date(Date.now() + delayMinutes * 60 * 1000);
    const updated = await updateReminder(reminderId, { nextRunAtUtc: nextRunUtc, enabled: true });
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
    await ctx.editMessageText('🗑 یادآوری حذف شد.', { reply_markup: deletedReminderKeyboard });
  } catch (error) {
    console.error({ scope: 'reminders', event: 'manage_delete_error', reminderId, error });
    await ctx.reply('❌ خطا در حذف یادآوری.', { reply_markup: remindersMenuKeyboard });
  }
});

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

bot.callbackQuery('reminders:new', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const telegramId = String(ctx.from.id);
  reminderStates.set(telegramId, { stage: 'create_title' });
  const prompt = '✏️ لطفاً عنوان یادآوری را بنویس.\nمثال: دارو، تماس، تمرین و ...';
  await ctx.editMessageText(prompt).catch(async () => {
    await ctx.reply(prompt);
  });
});

// ===== Global error handler =====

bot.catch((err: BotError<Context>) => {
  const { ctx, error } = err;
  console.error('Bot error:', {
    updateId: ctx.update?.update_id,
    error
  });
});
