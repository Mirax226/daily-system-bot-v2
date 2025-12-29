import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import type { BotError, Context } from 'grammy';
import { config } from './config';
import { ensureUser } from './services/users';
import { getSupabaseClient } from './db';
import { listUpcomingRemindersForUser } from './services/reminders';
import { formatLocalTime } from './utils/time';

export const bot = new Bot(config.telegram.botToken);

const replyKeyboard = new Keyboard().text('خانه 🏠').text('🔔 یادآوری‌ها').resized();

const remindersReplyKeyboard = new Keyboard()
  .text('➕ یادآوری جدید')
  .row()
  .text('📋 لیست یادآوری‌ها')
  .row()
  .text('⬅️ بازگشت')
  .resized();

type ReminderState = {
  stage: 'title' | 'delay';
  title?: string;
};

const reminderStates = new Map<string, ReminderState>();

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

    console.log({ scope: 'reminders', event: 'list', userId: user.id, count: reminders.length });

    if (!reminders.length) {
      await ctx.reply('🔔 هیچ یادآوری فعالی نداری.', { reply_markup: remindersReplyKeyboard });
      return;
    }

    const lines = reminders.map((reminder) => `• ${reminder.title} — زمان ارسال: ${reminder.next_run_at_utc ?? 'نامشخص'}`);
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
  reminderStates.set(telegramId, { stage: 'title' });

  await ctx.reply('✏️ لطفاً عنوان یادآوری را بنویس.\nمثال: دارو، تماس، تمرین و ...', {
    reply_markup: remindersReplyKeyboard
  });
});

bot.on('message:text', async (ctx) => {
  if (!ctx.from) {
    return;
  }

  const telegramId = String(ctx.from.id);
  const state = reminderStates.get(telegramId);

  if (!state || state.stage !== 'title') {
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
