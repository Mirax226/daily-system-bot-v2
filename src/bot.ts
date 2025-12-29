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
import { formatInstantToLocal, formatLocalTime } from './utils/time';
import type { ReminderRow } from './types/supabase';

export const bot = new Bot(config.telegram.botToken);

// ===== Keyboards =====

const homeKeyboard = new InlineKeyboard().text('🔔 یادآوری‌ها', 'reminders:menu');

const remindersMenuKeyboard = new InlineKeyboard()
  .text('➕ یادآوری جدید', 'reminders:new')
  .row()
  .text('📋 لیست و مدیریت یادآوری‌ها', 'reminders:list')
  .row()
  .text('⬅️ بازگشت به خانه', 'reminders:back_home');

const buildListKeyboard = (reminders: ReminderRow[]): InlineKeyboard => {
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

const deletedKeyboard = new InlineKeyboard()
  .text('📋 بازگشت به لیست', 'reminders:list')
  .row()
  .text('➕ یادآوری جدید', 'reminders:new');

// ===== State =====

type ReminderStage = 'create_title' | 'create_detail' | 'create_delay' | 'edit_title' | 'edit_detail';

type ReminderState = {
  stage: ReminderStage;
  reminderId?: string;
  title?: string;
  detail?: string | null;
};

const reminderStates = new Map<string, ReminderState>();

const clearState = (telegramId: string): void => {
  reminderStates.delete(telegramId);
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
      `⏱ زمان فعلی: ${localTime.date} | ${localTime.time} (${localTime.timezone})`,
    ].join('\n');

    if (edit && ctx.callbackQuery) {
      try {
        await ctx.editMessageText(homeMessage, { reply_markup: homeKeyboard });
        return;
      } catch {
        // fall back to sending a new message
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
    `ارسال بعدی: ${nextRun ? `${nextRun.date} | ${nextRun.time}` : '—'}`,
  ];

  return parts.join('\n   ');
};

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
    `ارسال بعدی (UTC): ${local ? `${local.date} | ${local.time}` : '—'}`,
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
      `${idx + 1}) عنوان: ${reminder.title}\n   وضعیت: ${statusLabel}\n   ارسال بعدی: ${nextRun ? `${nextRun.date} | ${nextRun.time}` : '—'}`,
    );
  });

  const keyboard = buildListKeyboard(reminders);

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
      } catch {
        await ctx.reply(errorText, { reply_markup: remindersMenuKeyboard });
      }
    }
  } finally {
    clearState(telegramId);
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
      reply_markup: remindersMenuKeyboard,
    });
  } catch {
    await ctx.reply('🔔 مدیریت یادآوری‌ها\nیکی از گزینه‌های زیر را انتخاب کن.', {
      reply_markup: remindersMenuKeyboard,
    });
  }
});

bot.callbackQuery('reminders:back_home', async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendHome(ctx, true);
});

// ===== List / manage =====

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

// ===== Creation flow =====

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

// ===== Text handler for creation/edit flows =====

bot.on('message:text', async (ctx: Context) => {
  if (!ctx.from || !ctx.message || typeof ctx.message.text !== 'string') return;

  const telegramId = String(ctx.from.id);
  const text = ctx.message.text.trim();
  const state = reminderStates.get(telegramId);

  if (!state) return;

  // Creation: title
  if (state.stage === 'create_title') {
    if (!text) {
      await ctx.reply('❗ عنوان معتبر نیست. دوباره امتحان کن.');
      return;
    }

    reminderStates.set(telegramId, { stage: 'create_detail', title: text, detail: null });
    await ctx.reply('📝 اگر توضیحی برای این یادآوری داری بنویس.\nاگر نمی‌خواهی توضیح اضافه کنی، روی «⏭ بدون توضیحات» بزن.', {
      reply_markup: skipDetailKeyboard,
    });
    return;
  }

  // Creation: detail
  if (state.stage === 'create_detail') {
    reminderStates.set(telegramId, { ...state, detail: text, stage: 'create_delay' });
    await ctx.reply('⏰ چه زمانی بهت یادآوری کنم؟', { reply_markup: buildCreateDelayKeyboard() });
    return;
  }

  // Edit title
  if (state.stage === 'edit_title' && state.reminderId) {
    try {
      const updated = await updateReminder(state.reminderId, { title: text });
      console.log({ scope: 'reminders', event: 'manage_edit_title', reminderId: updated.id });
      clearState(telegramId);
      await renderManageView(ctx, updated.id);
    } catch (error) {
      console.error({ scope: 'reminders', event: 'manage_edit_title_error', reminderId: state.reminderId, error });
      await ctx.reply('❌ خطا در ویرایش عنوان.', { reply_markup: remindersMenuKeyboard });
    }
    return;
  }

  // Edit detail
  if (state.stage === 'edit_detail' && state.reminderId) {
    try {
      const updated = await updateReminder(state.reminderId, { detail: text });
      console.log({ scope: 'reminders', event: 'manage_edit_detail', reminderId: updated.id });
      clearState(telegramId);
      await renderManageView(ctx, updated.id);
    } catch (error) {
      console.error({ scope: 'reminders', event: 'manage_edit_detail_error', reminderId: state.reminderId, error });
      await ctx.reply('❌ خطا در ویرایش توضیحات.', { reply_markup: remindersMenuKeyboard });
    }
    return;
  }
});

// ===== Callbacks for creation detail skip / delay selection =====

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
  clearState(telegramId);
  await ctx.editMessageText('❌ ایجاد یادآوری لغو شد.', { reply_markup: remindersMenuKeyboard });
});

// ===== Manage actions =====

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
    await ctx.editMessageText('🗑 یادآوری حذف شد.', { reply_markup: deletedKeyboard });
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
    error,
  });
});
