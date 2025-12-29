import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import type { BotError, Context } from 'grammy';
import { config } from './config';
import { ensureUser } from './services/users';
import { getSupabaseClient } from './db';
import { formatLocalTime, formatInstantToLocal } from './utils/time';
import type { ReminderRow } from './types/supabase';

export const bot = new Bot(config.telegram.botToken);

// ===== Keyboards =====

const homeKeyboard = new Keyboard()
  .text('خانه 🏠')
  .text('🔔 یادآوری‌ها')
  .resized();

// Main reminders menu (reply keyboard at bottom)
const remindersMainKeyboard = new Keyboard()
  .text('➕ یادآوری جدید')
  .row()
  .text('📋 لیست و مدیریت یادآوری‌ها')
  .row()
  .text('⬅️ بازگشت به خانه')
  .resized();

// Per-reminder actions (reply keyboard)
const reminderActionsKeyboard = new Keyboard()
  .text('✏️ ویرایش عنوان')
  .row()
  .text('🔁 تغییر وضعیت فعال/غیرفعال')
  .row()
  .text('🗑 حذف یادآوری')
  .row()
  .text('⬅️ بازگشت به لیست یادآوری‌ها')
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

// ===== State =====

type ReminderCreateState = {
  stage: 'title' | 'delay';
  title?: string;
};

type ReminderManageStage =
  | 'idle'
  | 'list'
  | 'select_index'
  | 'actions'
  | 'edit_title_wait';

type ReminderManageState = {
  stage: ReminderManageStage;
  reminders: ReminderRow[];
  selectedId?: string;
};

const createStates = new Map<string, ReminderCreateState>();
const manageStates = new Map<string, ReminderManageState>();

// ===== Helpers =====

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
    return '🔔 هیچ یادآوری‌ای ثبت نشده است.';
  }

  const lines: string[] = [];
  if (withIndices) {
    lines.push('📋 لیست و مدیریت یادآوری‌ها');
    lines.push('یک شماره از فهرست زیر را ارسال کن تا آن یادآوری را مدیریت کنی:');
    lines.push('');
  } else {
    lines.push('📋 فهرست یادآوری‌ها:');
  }

  reminders.forEach((reminder, idx) => {
    const prefix = withIndices ? `${idx + 1})` : '•';
    const statusLabel = reminder.enabled ? 'فعال' : 'غیرفعال';

    if (reminder.next_run_at_utc) {
      const local = formatInstantToLocal(
        reminder.next_run_at_utc,
        userTimezone ?? undefined,
      );
      lines.push(
        `${prefix} [${statusLabel}] ${reminder.title}\n   زمان ارسال: ${local.date} | ${local.time}`,
      );
    } else {
      lines.push(
        `${prefix} [${statusLabel}] ${reminder.title}\n   زمان ارسال: نامشخص`,
      );
    }
  });

  return lines.join('\n');
};

const loadAllRemindersForUser = async (
  userId: string,
): Promise<ReminderRow[]> => {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('reminders')
    .select('*')
    .eq('user_id', userId)
    .order('next_run_at_utc', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to load reminders for user ${userId}: ${error.message}`);
  }

  return (data as ReminderRow[]) ?? [];
};

const reloadManageList = async (
  telegramId: string,
  ctx: Context,
): Promise<void> => {
  if (!ctx.from) {
    await ctx.reply('خطا: کاربر یافت نشد.', { reply_markup: remindersMainKeyboard });
    return;
  }
  const username = ctx.from.username ?? null;
  const user = await ensureUser({ telegramId, username });

  const reminders = await loadAllRemindersForUser(user.id);

  if (!reminders.length) {
    manageStates.delete(telegramId);
    await ctx.reply('🔔 هنوز یادآوری‌ای ثبت نکرده‌ای.', {
      reply_markup: remindersMainKeyboard,
    });
    return;
  }

  manageStates.set(telegramId, { stage: 'select_index', reminders });
  const text = renderReminderListText(reminders, user.timezone, true);

  await ctx.reply(text, { reply_markup: remindersMainKeyboard });
};

// ===== Commands / main menus =====

bot.command('start', sendHome);
bot.command('home', sendHome);

bot.hears(['خانه 🏠', '🏠 خانه'], sendHome);

// Main entry to reminders
bot.hears('🔔 یادآوری‌ها', async (ctx: Context) => {
  await ctx.reply('🔔 مدیریت یادآوری‌ها\nیکی از گزینه‌های زیر را انتخاب کن.', {
    reply_markup: remindersMainKeyboard,
  });
});

bot.hears('⬅️ بازگشت به خانه', async (ctx: Context) => {
  await sendHome(ctx);
});

// ===== Simple list + manage (merged) =====

bot.hears('📋 لیست و مدیریت یادآوری‌ها', async (ctx: Context) => {
  if (!ctx.from) return;

  const telegramId = String(ctx.from.id);

  try {
    await reloadManageList(telegramId, ctx);
  } catch (error) {
    console.error({
      scope: 'reminders',
      event: 'list_manage_error',
      telegramId,
      error,
    });
    await ctx.reply('❌ خطا در دریافت لیست یادآوری‌ها.', {
      reply_markup: remindersMainKeyboard,
    });
  }
});

// ===== Create reminder flow =====

bot.hears('➕ یادآوری جدید', async (ctx: Context) => {
  if (!ctx.from) return;

  const telegramId = String(ctx.from.id);
  createStates.set(telegramId, { stage: 'title' });

  await ctx.reply('✏️ لطفاً عنوان یادآوری را بنویس.\nمثال: دارو، تماس، تمرین و ...');
});

// ===== Global text handler for stateful flows =====

bot.on('message:text', async (ctx: Context) => {
  if (!ctx.from || !ctx.message || typeof ctx.message.text !== 'string') return;

  const telegramId = String(ctx.from.id);
  const text = ctx.message.text.trim();

  // 1) Creation flow: waiting for title
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

  // 2) Manage flow: waiting for index or new title
  const manageState = manageStates.get(telegramId);

  if (!manageState) {
    // No state: ignore, other hears/commands have already handled.
    return;
  }

  // a) user is selecting reminder index
  if (manageState.stage === 'select_index') {
    const index = Number(text);
    if (!Number.isInteger(index) || index < 1 || index > manageState.reminders.length) {
      await ctx.reply('❗ شماره نامعتبر است. یک عدد از فهرست ارسال کن.', {
        reply_markup: remindersMainKeyboard,
      });
      return;
    }

    const selected = manageState.reminders[index - 1];
    manageStates.set(telegramId, {
      ...manageState,
      stage: 'actions',
      selectedId: selected.id,
    });

    const local = selected.next_run_at_utc
      ? formatInstantToLocal(selected.next_run_at_utc, undefined)
      : null;

    const summary: string[] = [
      'یادآوری انتخاب شد:',
      `عنوان: ${selected.title}`,
      `وضعیت: ${selected.enabled ? 'فعال' : 'غیرفعال'}`,
    ];
    if (local) {
      summary.push(`زمان ارسال: ${local.date} | ${local.time}`);
    }

    console.log({
      scope: 'reminders',
      event: 'manage_select',
      reminderId: selected.id,
      userId: selected.user_id,
    });

    await ctx.reply(summary.join('\n'), { reply_markup: reminderActionsKeyboard });
    return;
  }

  // b) user is sending new title
  if (manageState.stage === 'edit_title_wait' && manageState.selectedId) {
    if (!text) {
      await ctx.reply('❗ عنوان معتبر نیست. دوباره امتحان کن.', {
        reply_markup: reminderActionsKeyboard,
      });
      return;
    }

    const client = getSupabaseClient();

    try {
      const { error } = await client
        .from('reminders')
        .update({ title: text, updated_at: new Date().toISOString() })
        .eq('id', manageState.selectedId);

      if (error) throw error;

      // update local copy
      const updatedReminders = manageState.reminders.map((r) =>
        r.id === manageState.selectedId ? { ...r, title: text } : r,
      );

      manageStates.set(telegramId, {
        stage: 'actions',
        selectedId: manageState.selectedId,
        reminders: updatedReminders,
      });

      await ctx.reply('✅ عنوان یادآوری به‌روزرسانی شد.', {
        reply_markup: reminderActionsKeyboard,
      });
    } catch (error) {
      console.error({
        scope: 'reminders',
        event: 'manage_edit_title_error',
        reminderId: manageState.selectedId,
        error,
      });
      await ctx.reply('❌ خطا در ویرایش عنوان یادآوری.', {
        reply_markup: reminderActionsKeyboard,
      });
    }

    return;
  }
});

// ===== Delay selection (inline) =====

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

// ===== Management actions (reply keyboard) =====

bot.hears('⬅️ بازگشت به لیست یادآوری‌ها', async (ctx: Context) => {
  if (!ctx.from) return;

  const telegramId = String(ctx.from.id);
  const state = manageStates.get(telegramId);

  if (!state || !state.reminders.length) {
    await ctx.reply('لیست یادآوری خالی است.', {
      reply_markup: remindersMainKeyboard,
    });
    return;
  }

  manageStates.set(telegramId, { ...state, stage: 'select_index' });

  await ctx.reply(
    renderReminderListText(state.reminders, undefined, true),
    { reply_markup: remindersMainKeyboard },
  );
});

bot.hears('✏️ ویرایش عنوان', async (ctx: Context) => {
  if (!ctx.from) return;

  const telegramId = String(ctx.from.id);
  const state = manageStates.get(telegramId);

  if (!state || state.stage !== 'actions' || !state.selectedId) {
    await ctx.reply('ابتدا از لیست یک یادآوری را انتخاب کن.', {
      reply_markup: remindersMainKeyboard,
    });
    return;
  }

  manageStates.set(telegramId, { ...state, stage: 'edit_title_wait' });

  await ctx.reply('✏️ عنوان جدید یادآوری را ارسال کن.', {
    reply_markup: reminderActionsKeyboard,
  });
});

bot.hears('🔁 تغییر وضعیت فعال/غیرفعال', async (ctx: Context) => {
  if (!ctx.from) return;

  const telegramId = String(ctx.from.id);
  const state = manageStates.get(telegramId);

  if (!state || state.stage !== 'actions' || !state.selectedId) {
    await ctx.reply('ابتدا از لیست یک یادآوری را انتخاب کن.', {
      reply_markup: remindersMainKeyboard,
    });
    return;
  }

  const client = getSupabaseClient();

  try {
    const current = state.reminders.find((r) => r.id === state.selectedId);
    if (!current) {
      await ctx.reply('یادآوری پیدا نشد.', {
        reply_markup: remindersMainKeyboard,
      });
      return;
    }

    const nextEnabled = !current.enabled;

    const { error } = await client
      .from('reminders')
      .update({ enabled: nextEnabled, updated_at: new Date().toISOString() })
      .eq('id', current.id);

    if (error) throw error;

    const updatedReminders = state.reminders.map((r) =>
      r.id === current.id ? { ...r, enabled: nextEnabled } : r,
    );

    manageStates.set(telegramId, {
      ...state,
      reminders: updatedReminders,
    });

    console.log({
      scope: 'reminders',
      event: 'manage_toggle',
      reminderId: current.id,
      userId: current.user_id,
      enabled: nextEnabled,
    });

    await ctx.reply(
      `وضعیت یادآوری به "${nextEnabled ? 'فعال' : 'غیرفعال'}" تغییر کرد.`,
      { reply_markup: reminderActionsKeyboard },
    );
  } catch (error) {
    console.error({
      scope: 'reminders',
      event: 'manage_toggle_error',
      reminderId: state.selectedId,
      error,
    });
    await ctx.reply('❌ خطا در تغییر وضعیت یادآوری.', {
      reply_markup: reminderActionsKeyboard,
    });
  }
});

bot.hears('🗑 حذف یادآوری', async (ctx: Context) => {
  if (!ctx.from) return;

  const telegramId = String(ctx.from.id);
  const state = manageStates.get(telegramId);

  if (!state || state.stage !== 'actions' || !state.selectedId) {
    await ctx.reply('ابتدا از لیست یک یادآوری را انتخاب کن.', {
      reply_markup: remindersMainKeyboard,
    });
    return;
  }

  const client = getSupabaseClient();

  try {
    const { error } = await client
      .from('reminders')
      .delete()
      .eq('id', state.selectedId);

    if (error) throw error;

    const remaining = state.reminders.filter((r) => r.id !== state.selectedId);

    console.log({
      scope: 'reminders',
      event: 'manage_delete',
      reminderId: state.selectedId,
    });

    if (!remaining.length) {
      manageStates.delete(telegramId);
      await ctx.reply(
        'یادآوری حذف شد و دیگر یادآوری‌ای برای مدیریت وجود ندارد.',
        { reply_markup: remindersMainKeyboard },
      );
      return;
    }

    manageStates.set(telegramId, {
      stage: 'select_index',
      reminders: remaining,
      selectedId: undefined,
    });

    await ctx.reply(
      renderReminderListText(remaining, undefined, true),
      { reply_markup: remindersMainKeyboard },
    );
  } catch (error) {
    console.error({
      scope: 'reminders',
      event: 'manage_delete_error',
      reminderId: state.selectedId,
      error,
    });
    await ctx.reply('❌ خطا در حذف یادآوری.', {
      reply_markup: reminderActionsKeyboard,
    });
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
