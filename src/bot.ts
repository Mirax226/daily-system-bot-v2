import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import type { BotError, Context } from 'grammy';
import { config } from './config';
import { ensureUser } from './services/users';
import { getSupabaseClient } from './db';
import {
  deleteReminder,
  getReminderById,
  listUpcomingRemindersForUser,
  updateReminderEnabled
} from './services/reminders';
import { formatInstantToLocal, formatLocalTime } from './utils/time';
import type { ReminderRow } from './types/supabase';

export const bot = new Bot(config.telegram.botToken);

const replyKeyboard = new Keyboard().text('خانه 🏠').text('🔔 یادآوری‌ها').resized();

const remindersReplyKeyboard = new Keyboard()
  .text('➕ یادآوری جدید')
  .row()
  .text('📋 لیست یادآوری‌ها')
  .row()
  .text('⚙️ مدیریت یادآوری‌ها')
  .row()
  .text('⬅️ بازگشت')
  .resized();

const singleReminderKeyboard = new Keyboard()
  .text('🔁 تغییر وضعیت فعال/غیرفعال')
  .row()
  .text('🗑 حذف یادآوری')
  .row()
  .text('⬅️ بازگشت به فهرست یادآوری‌ها')
  .resized();

type ReminderState = {
  stage: 'title' | 'delay';
  title?: string;
};

const reminderStates = new Map<string, ReminderState>();
type ReminderManageState = {
  stage: 'select_index' | 'choose_action' | 'confirm_delete';
  reminders: ReminderRow[];
  selectedId?: string;
  timezone: string;
  userId?: string;
};
const reminderManageStates = new Map<string, ReminderManageState>();

function buildReminderLines(reminders: ReminderRow[], timezone: string): string[] {
  return reminders.map((reminder, index) => {
    if (reminder.next_run_at_utc) {
      const localTime = formatInstantToLocal(reminder.next_run_at_utc, timezone);
      return `${index + 1}) ${reminder.title}\n  زمان ارسال: ${localTime.date} | ${localTime.time}`;
    }
    return `${index + 1}) ${reminder.title}\n  زمان ارسال: نامشخص`;
  });
}

async function renderManageList(ctx: Context, reminders: ReminderRow[], timezone: string) {
  const lines = buildReminderLines(reminders, timezone);
  await ctx.reply(['⚙️ مدیریت یادآوری‌ها', 'یکی از یادآوری‌ها را با ارسال شماره انتخاب کن:', ...lines].join('\n'), {
    reply_markup: remindersReplyKeyboard
  });
}

async function refreshManageState(
  ctx: Context,
  telegramId: string,
  userId: string,
  timezone: string
): Promise<void> {
  const reminders = await listUpcomingRemindersForUser(userId, 20);

  if (!reminders.length) {
    reminderManageStates.delete(telegramId);
    await ctx.reply('هیچ یادآوری فعالی برای مدیریت وجود ندارد.', { reply_markup: remindersReplyKeyboard });
    return;
  }

  reminderManageStates.set(telegramId, { stage: 'select_index', reminders, timezone, userId });
  await renderManageList(ctx, reminders, timezone);
}

const sendHome = async (ctx: Context) => {
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

    await ctx.reply(homeMessage, {
      reply_markup: replyKeyboard
    });
  } catch (error) {
    console.error({ scope: 'services/users', error });
    await ctx.reply('خطا در اتصال به بانک اطلاعاتی. لطفاً بعداً دوباره امتحان کن.');
    return;
  }
};

bot.command('start', async (ctx: Context) => {
  await sendHome(ctx);
});

bot.hears('🏠 خانه', async (ctx: Context) => {
  await sendHome(ctx);
});

bot.hears('خانه 🏠', async (ctx: Context) => {
  await sendHome(ctx);
});

bot.command('home', async (ctx: Context) => {
  await sendHome(ctx);
});

const sendRemindersMenu = async (ctx: Context) => {
  await ctx.reply('🔔 مدیریت یادآوری‌ها\nیکی از گزینه‌های زیر را انتخاب کن.', {
    reply_markup: remindersReplyKeyboard
  });
};

bot.hears('🔔 یادآوری‌ها', async (ctx: Context) => {
  await sendRemindersMenu(ctx);
});

bot.hears('⬅️ بازگشت', async (ctx: Context) => {
  await sendHome(ctx);
});

bot.hears('📋 لیست یادآوری‌ها', async (ctx: Context) => {
  if (!ctx.from) {
    return;
  }

  const telegramId = String(ctx.from.id);
  const username = ctx.from.username ?? null;

  try {
    const user = await ensureUser({ telegramId, username });
    const reminders = await listUpcomingRemindersForUser(user.id);
    const tz = user.timezone ?? config.defaultTimezone;

    console.log({ scope: 'reminders', event: 'list', userId: user.id, count: reminders.length });

    if (!reminders.length) {
      await ctx.reply('🔔 هیچ یادآوری فعالی نداری.', { reply_markup: remindersReplyKeyboard });
      return;
    }

    const lines = reminders.map((reminder, index) => {
      if (reminder.next_run_at_utc) {
        const localTime = formatInstantToLocal(reminder.next_run_at_utc, tz);
        return `• ${index + 1}) ${reminder.title}\n  زمان ارسال: ${localTime.date} | ${localTime.time}`;
      }
      return `• ${index + 1}) ${reminder.title}\n  زمان ارسال: نامشخص`;
    });
    const text = ['📋 فهرست یادآوری‌های فعال:', ...lines].join('\n');

    await ctx.reply(text, { reply_markup: remindersReplyKeyboard });
  } catch (error) {
    console.error({ scope: 'reminders', event: 'list_error', telegramId, error });
    await ctx.reply('❌ خطا در دریافت یادآوری‌ها.', { reply_markup: remindersReplyKeyboard });
  }
});

bot.hears('➕ یادآوری جدید', async (ctx: Context) => {
  if (!ctx.from) {
    return;
  }

  const telegramId = String(ctx.from.id);
  reminderManageStates.delete(telegramId);
  reminderStates.set(telegramId, { stage: 'title' });

  await ctx.reply('✏️ لطفاً عنوان یادآوری را بنویس.\nمثال: دارو، تماس، تمرین و ...', {
    reply_markup: remindersReplyKeyboard
  });
});

bot.hears('⚙️ مدیریت یادآوری‌ها', async (ctx: Context) => {
  if (!ctx.from) {
    return;
  }

  const telegramId = String(ctx.from.id);
  const username = ctx.from.username ?? null;

  try {
    const user = await ensureUser({ telegramId, username });
    const reminders = await listUpcomingRemindersForUser(user.id, 20);
    const tz = user.timezone ?? config.defaultTimezone;

    if (!reminders.length) {
      reminderManageStates.delete(telegramId);
      await ctx.reply('🔔 هیچ یادآوری فعالی برای مدیریت وجود ندارد.', { reply_markup: remindersReplyKeyboard });
      return;
    }

    reminderManageStates.set(telegramId, { stage: 'select_index', reminders, timezone: tz, userId: user.id });

    console.log({ scope: 'reminders', event: 'manage_enter', userId: user.id, count: reminders.length });

    await renderManageList(ctx, reminders, tz);
  } catch (error) {
    console.error({ scope: 'reminders', event: 'manage_error', telegramId, error });
    await ctx.reply('❌ خطا در مدیریت یادآوری‌ها.', { reply_markup: remindersReplyKeyboard });
  }
});

bot.on('message:text', async (ctx) => {
  if (!ctx.from) {
    return;
  }

  const telegramId = String(ctx.from.id);
  const state = reminderStates.get(telegramId);

  if (!state || state.stage !== 'title') {
    const manageState = reminderManageStates.get(telegramId);
    if (!manageState || manageState.stage !== 'select_index') {
      return;
    }

    const index = Number.parseInt(ctx.message.text.trim(), 10);
    if (Number.isNaN(index) || index < 1 || index > manageState.reminders.length) {
      await ctx.reply('❗ شماره نامعتبر است. یک عدد از فهرست ارسال کن.', { reply_markup: remindersReplyKeyboard });
      return;
    }

    const selectedReminder = manageState.reminders[index - 1];
    reminderManageStates.set(telegramId, {
      stage: 'choose_action',
      reminders: manageState.reminders,
      selectedId: selectedReminder.id,
      timezone: manageState.timezone,
      userId: manageState.userId
    });

    let summary = `یادآوری انتخاب شد:\n${selectedReminder.title}\n`;
    if (selectedReminder.next_run_at_utc) {
      const localTime = formatInstantToLocal(selectedReminder.next_run_at_utc, manageState.timezone);
      summary += `زمان ارسال: ${localTime.date} | ${localTime.time}`;
    } else {
      summary += 'زمان ارسال: نامشخص';
    }

    console.log({
      scope: 'reminders',
      event: 'manage_select',
      reminderId: selectedReminder.id,
      userId: manageState.userId ?? telegramId
    });

    await ctx.reply(`${summary}\n\nحالا انتخاب کن چه کاری انجام بدهم.`, { reply_markup: singleReminderKeyboard });
    return;
  }

  const title = ctx.message.text.trim();
  if (!title) {
    await ctx.reply('❗ عنوان معتبر نیست. دوباره امتحان کن.');
    return;
  }

  reminderStates.set(telegramId, { stage: 'delay', title });

  const delayKeyboard = new InlineKeyboard()
    .text('۵ دقیقه دیگر', 'reminders:delay:5')
    .row()
    .text('۱۵ دقیقه دیگر', 'reminders:delay:15')
    .row()
    .text('۳۰ دقیقه دیگر', 'reminders:delay:30')
    .row()
    .text('۱ ساعت دیگر', 'reminders:delay:60');

  await ctx.reply('⏰ چه زمانی بهت یادآوری کنم؟', {
    reply_markup: delayKeyboard
  });
});

bot.hears('🔁 تغییر وضعیت فعال/غیرفعال', async (ctx: Context) => {
  if (!ctx.from) return;

  const telegramId = String(ctx.from.id);
  const state = reminderManageStates.get(telegramId);

  if (!state || state.stage !== 'choose_action' || !state.selectedId) {
    await ctx.reply('ابتدا یک یادآوری را از فهرست انتخاب کن.', { reply_markup: remindersReplyKeyboard });
    return;
  }

  const userTimezone = state.timezone || config.defaultTimezone;
  const userId = state.userId ?? String(ctx.from.id);

  try {
    const reminder = await getReminderById(state.selectedId);
    if (!reminder) {
      await ctx.reply('یادآوری پیدا نشد. لطفاً دوباره فهرست را ببین.', { reply_markup: remindersReplyKeyboard });
      await refreshManageState(ctx, telegramId, userId, userTimezone);
      return;
    }

    const nextEnabled = !reminder.enabled;
    await updateReminderEnabled(reminder.id, nextEnabled);

    console.log({
      scope: 'reminders',
      event: 'manage_toggle',
      reminderId: reminder.id,
      userId,
      enabled: nextEnabled
    });

    await ctx.reply(`وضعیت یادآوری به "${nextEnabled ? 'فعال' : 'غیرفعال'}" تغییر کرد.`, {
      reply_markup: remindersReplyKeyboard
    });

    await refreshManageState(ctx, telegramId, userId, userTimezone);
  } catch (error) {
    console.error({ scope: 'reminders', event: 'manage_error', telegramId, error });
    await ctx.reply('❌ خطا در تغییر وضعیت یادآوری.', { reply_markup: remindersReplyKeyboard });
  }
});

bot.hears('🗑 حذف یادآوری', async (ctx: Context) => {
  if (!ctx.from) return;

  const telegramId = String(ctx.from.id);
  const state = reminderManageStates.get(telegramId);

  if (!state || state.stage !== 'choose_action' || !state.selectedId) {
    await ctx.reply('ابتدا یک یادآوری را از فهرست انتخاب کن.', { reply_markup: remindersReplyKeyboard });
    return;
  }

  const userTimezone = state.timezone || config.defaultTimezone;
  const userId = state.userId ?? String(ctx.from.id);

  try {
    await deleteReminder(state.selectedId);

    console.log({
      scope: 'reminders',
      event: 'manage_delete',
      reminderId: state.selectedId,
      userId,
      telegramId
    });

    const remaining = state.reminders.filter((r) => r.id !== state.selectedId);

    if (!remaining.length) {
      reminderManageStates.delete(telegramId);
      await ctx.reply('یادآوری حذف شد و دیگر یادآوری فعالی برای مدیریت وجود ندارد.', {
        reply_markup: remindersReplyKeyboard
      });
      return;
    }

    reminderManageStates.set(telegramId, { stage: 'select_index', reminders: remaining, timezone: userTimezone, userId });
    await renderManageList(ctx, remaining, userTimezone);
  } catch (error) {
    console.error({ scope: 'reminders', event: 'manage_error', telegramId, error });
    await ctx.reply('❌ خطا در حذف یادآوری.', { reply_markup: remindersReplyKeyboard });
  }
});

bot.hears('⬅️ بازگشت به فهرست یادآوری‌ها', async (ctx: Context) => {
  if (!ctx.from) {
    return;
  }

  const telegramId = String(ctx.from.id);
  const state = reminderManageStates.get(telegramId);

  if (!state || !state.reminders.length) {
    await sendRemindersMenu(ctx);
    return;
  }

  reminderManageStates.set(telegramId, { stage: 'select_index', reminders: state.reminders, timezone: state.timezone, userId: state.userId });
  await renderManageList(ctx, state.reminders, state.timezone);
});

bot.callbackQuery(/reminders:delay:(\d+)/, async (ctx) => {
  if (!ctx.from) {
    await ctx.answerCallbackQuery();
    return;
  }

  const delayMatch = ctx.match?.[1];
  const delayMinutes = delayMatch ? Number(delayMatch) : NaN;
  const telegramId = String(ctx.from.id);
  const username = ctx.from.username ?? null;
  const state = reminderStates.get(telegramId);

  if (!state || state.stage !== 'delay' || !state.title || Number.isNaN(delayMinutes)) {
    await ctx.answerCallbackQuery({ text: 'درخواست نامعتبر است.', show_alert: true });
    return;
  }

  try {
    const nowUtc = new Date();
    const nextRunUtc = new Date(nowUtc.getTime() + delayMinutes * 60 * 1000);

    const user = await ensureUser({ telegramId, username });

    const client = getSupabaseClient();

    const { data, error } = await client
      .from('reminders')
      .insert({
        user_id: user.id,
        title: state.title,
        detail: null,
        next_run_at_utc: nextRunUtc.toISOString(),
        last_sent_at_utc: null,
        enabled: true
      })
      .select('id')
      .single();

    if (error) {
      throw error;
    }

    console.log({
      scope: 'reminders',
      event: 'created',
      userId: user.id,
      telegramId,
      reminderId: data?.id,
      delayMinutes
    });

    await ctx.editMessageText(`✅ یادآوری ثبت شد.\nربات حدود ${delayMinutes} دقیقه دیگر بهت پیام می‌دهد.`);
    await ctx.reply('🔔 مدیریت یادآوری‌ها\nیکی از گزینه‌های زیر را انتخاب کن.', {
      reply_markup: remindersReplyKeyboard
    });
  } catch (error) {
    console.error({ scope: 'reminders', event: 'create_error', telegramId, error });
    await ctx.editMessageText('❌ خطا در ثبت یادآوری. لطفاً بعداً دوباره امتحان کن.');
    await ctx.reply('🔔 مدیریت یادآوری‌ها\nیکی از گزینه‌های زیر را انتخاب کن.', {
      reply_markup: remindersReplyKeyboard
    });
  } finally {
    reminderStates.delete(telegramId);
  }
});

bot.catch((err: BotError<Context>) => {
  const { ctx, error } = err;

  console.error('Bot error:', {
    updateId: ctx.update?.update_id,
    error
  });
});
