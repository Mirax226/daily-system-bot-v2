import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import type { BotError, Context } from 'grammy';
import { config } from './config';
import { ensureUser } from './services/users';
import { getSupabaseClient } from './db';
import { listUpcomingRemindersForUser } from './services/reminders';
import { formatLocalTime, formatInstantToLocal } from './utils/time';
import type { ReminderRow } from './types/supabase';

export const bot = new Bot(config.telegram.botToken);

// ----- Keyboards -----

const homeKeyboard = new Keyboard()
  .text('خانه 🏠')
  .text('🔔 یادآوری‌ها')
  .resized();

const remindersKeyboard = new Keyboard()
  .text('➕ یادآوری جدید')
  .row()
  .text('📋 لیست یادآوری‌ها')
  .row()
  .text('⚙️ مدیریت یادآوری‌ها')
  .row()
  .text('⬅️ بازگشت')
  .resized();

const buildSingleReminderKeyboard = (): Keyboard =>
  new Keyboard()
    .text('🔁 تغییر وضعیت فعال/غیرفعال')
    .row()
    .text('🗑 حذف یادآوری')
    .row()
    .text('⬅️ بازگشت به فهرست یادآوری‌ها')
    .resized();

// Inline keyboard ONLY for delay selection when creating a reminder
const buildDelayKeyboard = (): InlineKeyboard =>
  new InlineKeyboard()
    .text('۵ دقیقه دیگر', 'reminders:delay:5')
    .row()
    .text('۱۵ دقیقه دیگر', 'reminders:delay:15')
    .row()
    .text('۳۰ دقیقه دیگر', 'reminders:delay:30')
    .row()
    .text('۱ ساعت دیگر', 'reminders:delay:60');

// ----- State -----

type ReminderCreateState = {
  stage: 'title' | 'delay';
  title?: string;
};

type ReminderManageState = {
  stage: 'select_index' | 'choose_action';
  reminders: ReminderRow[];
  selectedId?: string;
};

const createStates = new Map<string, ReminderCreateState>();
const manageStates = new Map<string, ReminderManageState>();

// ----- Helpers -----

const sendHome = async (ctx: Context): Promise<void> => {
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

    await ctx.reply(homeMessage, { reply_markup: homeKeyboard });
  } catch (error) {
    console.error({ scope: 'services/users', error });
    await ctx.reply('خطا در اتصال به بانک اطلاعاتی. لطفاً بعداً دوباره امتحان کن.');
  }
};

const renderReminderListText = (
  reminders: ReminderRow[],
  userTimezone?: string | null,
  withIndices = false,
): string => {
  if (!reminders.length) {
    return '🔔 هیچ یادآوری فعالی نداری.';
  }

  const lines: string[] = [];
  if (withIndices) {
    lines.push('⚙️ مدیریت یادآوری‌ها');
    lines.push('یکی از یادآوری‌ها را با ارسال شماره انتخاب کن:');
    lines.push('');
  } else {
    lines.push('📋 فهرست یادآوری‌های فعال:');
  }

  const tz = userTimezone ?? config.defaultTimezone;

  reminders.forEach((reminder, idx) => {
    const prefix = withIndices ? `${idx + 1})` : '•';
    if (reminder.next_run_at_utc) {
      const local = formatInstantToLocal(reminder.next_run_at_utc, tz);
      lines.push(
        `${prefix} ${reminder.title}\n   زمان ارسال: ${local.date} | ${local.time}`,
      );
    } else {
      lines.push(`${prefix} ${reminder.title}\n   زمان ارسال: نامشخص`);
    }
  });

  return lines.join('\n');
};

const reloadAndRenderManageList = async (
  telegramId: string,
  userId: string,
  userTimezone: string | null,
  ctx: Context,
): Promise<void> => {
  const reminders = await listUpcomingRemindersForUser(userId, 20);
  if (!reminders.length) {
    manageStates.delete(telegramId);
    await ctx.reply('یادآوری‌ای برای مدیریت وجود ندارد.', {
      reply_markup: remindersKeyboard,
    });
    return;
  }

  manageStates.set(telegramId, { stage: 'select_index', reminders });
  const text = renderReminderListText(reminders, userTimezone, true);

  await ctx.reply(text, { reply_markup: remindersKeyboard });
};

// ----- Commands / main menus -----

bot.command('start', sendHome);
bot.command('home', sendHome);

bot.hears(['خانه 🏠', '🏠 خانه'], sendHome);

bot.hears('🔔 یادآوری‌ها', async (ctx: Context) => {
  await ctx.reply('🔔 مدیریت یادآوری‌ها\nیکی از گزینه‌های زیر را انتخاب کن.', {
    reply_markup: remindersKeyboard,
  });
});

bot.hears('⬅️ بازگشت', async (ctx: Context) => {
  await sendHome(ctx);
});

// ----- Simple list (no management) -----

bot.hears('📋 لیست یادآوری‌ها', async (ctx: Context) => {
  if (!ctx.from) return;

  const telegramId = String(ctx.from.id);
  const username = ctx.from.username ?? null;

  try {
    const user = await ensureUser({ telegramId, username });
    const reminders = await listUpcomingRemindersForUser(user.id);

    console.log({
      scope: 'reminders',
      event: 'list',
      userId: user.id,
      count: reminders.length,
    });

    const text = renderReminderListText(reminders, user.timezone);
    await ctx.reply(text, { reply_markup: remindersKeyboard });
  } catch (error) {
    console.error({ scope: 'reminders', event: 'list_error', telegramId, error });
    await ctx.reply('❌ خطا در دریافت یادآوری‌ها.', {
      reply_markup: remindersKeyboard,
    });
  }
});

// ----- Reminder creation -----

bot.hears('➕ یادآوری جدید', async (ctx: Context) => {
  if (!ctx.from) return;

  const telegramId = String(ctx.from.id);
  createStates.set(telegramId, { stage: 'title' });

  await ctx.reply('✏️ لطفاً عنوان یادآوری را بنویس.\nمثال: دارو، تماس، تمرین و ...');
});

// Text handler for both creation (title) and management (select index)
bot.on('message:text', async (ctx: Context) => {
  if (!ctx.from || !ctx.message || typeof ctx.message.text !== 'string') return;

  const telegramId = String(ctx.from.id);
  const text = ctx.message.text.trim();

  // 1) Creation: waiting for title
  const createState = createStates.get(telegramId);
  if (createState && createState.stage === 'title') {
    if (!text) {
      await ctx.reply('❗ عنوان معتبر نیست. دوباره امتحان کن.');
      return;
    }

    createStates.set(telegramId, { stage: 'delay', title: text });

    await ctx.reply('⏰ چه زمانی بهت یادآوری کنم؟', {
      reply_markup: buildDelayKeyboard(),
    });
    return;
  }

  // 2) Management: waiting for index
  const manageState = manageStates.get(telegramId);
  if (manageState && manageState.stage === 'select_index') {
    const index = Number(text);
    if (!Number.isInteger(index) || index < 1 || index > manageState.reminders.length) {
      await ctx.reply('❗ شماره نامعتبر است. یک عدد از فهرست ارسال کن.', {
        reply_markup: remindersKeyboard,
      });
      return;
    }

    const selected = manageState.reminders[index - 1];
    manageStates.set(telegramId, {
      stage: 'choose_action',
      reminders: manageState.reminders,
      selectedId: selected.id,
    });

    const local = selected.next_run_at_utc
      ? formatInstantToLocal(selected.next_run_at_utc, undefined)
      : null;

    const summaryLines = [
      'یادآوری انتخاب شد:',
      selected.title,
    ];
    if (local) {
      summaryLines.push(`زمان ارسال: ${local.date} | ${local.time}`);
    }

    console.log({
      scope: 'reminders',
      event: 'manage_select',
      reminderId: selected.id,
      userId: selected.user_id,
    });

    await ctx.reply(summaryLines.join('\n'), {
      reply_markup: buildSingleReminderKeyboard(),
    });
    return;
  }

  // Otherwise: ignore, other handlers (like hears) will have already run.
});

// Delay callback (inline)
bot.callbackQuery(/reminders:delay:(\d+)/, async (ctx) => {
  if (!ctx.from) {
    await ctx.answerCallbackQuery();
    return;
  }

  const delayMinutes = Number(ctx.match?.[1] ?? 'NaN');
  const telegramId = String(ctx.from.id);
  const username = ctx.from.username ?? null;
  const state = createStates.get(telegramId);

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
        enabled: true,
      })
      .select('id')
      .single();

    if (error) throw error;

    console.log({
      scope: 'reminders',
      event: 'created',
      userId: user.id,
      telegramId,
      reminderId: data?.id,
      delayMinutes,
    });

    await ctx.editMessageText(
      `✅ یادآوری ثبت شد.\nربات حدود ${delayMinutes} دقیقه دیگر بهت پیام می‌دهد.`,
    );
  } catch (error) {
    console.error({ scope: 'reminders', event: 'create_error', telegramId, error });
    await ctx.editMessageText('❌ خطا در ثبت یادآوری. لطفاً بعداً دوباره امتحان کن.');
  } finally {
    createStates.delete(telegramId);
  }
});

// ----- Management actions -----

bot.hears('⚙️ مدیریت یادآوری‌ها', async (ctx: Context) => {
  if (!ctx.from) return;

  const telegramId = String(ctx.from.id);
  const username = ctx.from.username ?? null;

  try {
    const user = await ensureUser({ telegramId, username });

    console.log({
      scope: 'reminders',
      event: 'manage_enter',
      userId: user.id,
    });

    await reloadAndRenderManageList(telegramId, user.id, user.timezone, ctx);
  } catch (error) {
    console.error({ scope: 'reminders', event: 'manage_error', step: 'enter', error });
    await ctx.reply('❌ خطا در ورود به مدیریت یادآوری‌ها.', {
      reply_markup: remindersKeyboard,
    });
  }
});

bot.hears('⬅️ بازگشت به فهرست یادآوری‌ها', async (ctx: Context) => {
  if (!ctx.from) {
    await ctx.reply('هیچ لیستی برای بازگشت وجود ندارد.', {
      reply_markup: remindersKeyboard,
    });
    return;
  }

  const telegramId = String(ctx.from.id);
  const state = manageStates.get(telegramId);
  if (!state) {
    await ctx.reply('هیچ لیستی برای بازگشت وجود ندارد.', {
      reply_markup: remindersKeyboard,
    });
    return;
  }

  // Re-render list with existing reminders
  const text = renderReminderListText(state.reminders, undefined, true);
  manageStates.set(telegramId, { ...state, stage: 'select_index' });

  await ctx.reply(text, { reply_markup: remindersKeyboard });
});

bot.hears('🔁 تغییر وضعیت فعال/غیرفعال', async (ctx: Context) => {
  if (!ctx.from) return;

  const telegramId = String(ctx.from.id);
  const state = manageStates.get(telegramId);
  if (!state || state.stage !== 'choose_action' || !state.selectedId) {
    await ctx.reply('ابتدا یک یادآوری را از فهرست انتخاب کن.', {
      reply_markup: remindersKeyboard,
    });
    return;
  }

  const client = getSupabaseClient();

  try {
    const { data: reminder, error } = await client
      .from('reminders')
      .select('*')
      .eq('id', state.selectedId)
      .maybeSingle();

    if (error) throw error;
    if (!reminder) {
      await ctx.reply('یادآوری پیدا نشد.', { reply_markup: remindersKeyboard });
      return;
    }

    const nextEnabled = !reminder.enabled;
    const { error: updateError } = await client
      .from('reminders')
      .update({ enabled: nextEnabled, updated_at: new Date().toISOString() })
      .eq('id', reminder.id);

    if (updateError) throw updateError;

    console.log({
      scope: 'reminders',
      event: 'manage_toggle',
      reminderId: reminder.id,
      userId: reminder.user_id,
      enabled: nextEnabled,
    });

    await ctx.reply(
      `وضعیت یادآوری به "${nextEnabled ? 'فعال' : 'غیرفعال'}" تغییر کرد.`,
      { reply_markup: buildSingleReminderKeyboard() },
    );
  } catch (error) {
    console.error({ scope: 'reminders', event: 'manage_error', action: 'toggle', error });
    await ctx.reply('❌ خطا در تغییر وضعیت یادآوری.', {
      reply_markup: buildSingleReminderKeyboard(),
    });
  }
});

bot.hears('🗑 حذف یادآوری', async (ctx: Context) => {
  if (!ctx.from) return;

  const telegramId = String(ctx.from.id);
  const state = manageStates.get(telegramId);
  if (!state || state.stage !== 'choose_action' || !state.selectedId) {
    await ctx.reply('ابتدا یک یادآوری را از فهرست انتخاب کن.', {
      reply_markup: remindersKeyboard,
    });
    return;
  }

  const client = getSupabaseClient();

  try {
    const { error } = await client.from('reminders').delete().eq('id', state.selectedId);
    if (error) throw error;

    console.log({
      scope: 'reminders',
      event: 'manage_delete',
      reminderId: state.selectedId,
    });

    // حذف از آرایه محلی
    const remaining = state.reminders.filter((r) => r.id !== state.selectedId);

    if (remaining.length === 0) {
      manageStates.delete(telegramId);
      await ctx.reply(
        'یادآوری حذف شد و دیگر یادآوری فعالی برای مدیریت وجود ندارد.',
        { reply_markup: remindersKeyboard },
      );
      return;
    }

    manageStates.set(telegramId, {
      stage: 'select_index',
      reminders: remaining,
      selectedId: undefined,
    });

    const text = renderReminderListText(remaining, undefined, true);
    await ctx.reply(text, { reply_markup: remindersKeyboard });
  } catch (error) {
    console.error({ scope: 'reminders', event: 'manage_error', action: 'delete', error });
    await ctx.reply('❌ خطا در حذف یادآوری.', {
      reply_markup: buildSingleReminderKeyboard(),
    });
  }
});

// ----- Global error handler -----

bot.catch((err: BotError<Context>) => {
  const { ctx, error } = err;
  console.error('Bot error:', {
    updateId: ctx.update?.update_id,
    error,
  });
});
