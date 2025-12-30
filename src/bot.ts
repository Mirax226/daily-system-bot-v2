import { Bot, InlineKeyboard, Keyboard, GrammyError } from 'grammy';
import type { BotError, Context } from 'grammy';
import { config } from './config';
import { getSupabaseClient } from './db';
import { ensureUser, updateUserSettings } from './services/users';
import {
  createReminder,
  deleteReminder,
  getReminderById,
  listRemindersForUser,
  toggleReminderEnabled,
  updateReminder
} from './services/reminders';
import { seedDefaultRewardsIfEmpty, listRewards, getRewardById, purchaseReward } from './services/rewards';
import { getXpBalance, getXpSummary } from './services/xpLedger';
import { formatInstantToLocal, formatLocalTime } from './utils/time';
import type { ReminderRow, RewardRow } from './types/supabase';

export const bot = new Bot(config.telegram.botToken);

// ===== Keyboards =====

const mainMenuKeyboard = new Keyboard()
  .text('📊 Reports')
  .text('🎁 Reward Center')
  .row()
  .text('🧾 Daily Report')
  .resized();

const remindersMenuKeyboard = new InlineKeyboard()
  .text('➕ New Reminder', 'r:new')
  .row()
  .text('📋 List & Manage', 'r:list')
  .row()
  .text('⬅️ Back to Home', 'home:back');

const buildReminderListKeyboard = (reminders: ReminderRow[]): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  reminders.forEach((reminder, idx) => {
    keyboard.text(`⚙ Manage #${idx + 1}`, `r:m:${reminder.id}`).row();
  });
  keyboard.text('➕ New Reminder', 'r:new').row().text('⬅️ Back', 'r:menu');
  return keyboard;
};

const buildManageKeyboard = (reminder: ReminderRow): InlineKeyboard =>
  new InlineKeyboard()
    .text('✏️ Edit Title', `r:et:${reminder.id}`)
    .row()
    .text('📝 Edit Details', `r:ed:${reminder.id}`)
    .row()
    .text('⏭ Clear Details', `r:cd:${reminder.id}`)
    .row()
    .text(reminder.enabled ? '🔕 Disable' : '🔔 Enable', `r:t:${reminder.id}`)
    .row()
    .text('⏱ Change Time', `r:time:${reminder.id}`)
    .row()
    .text('🗑 Delete', `r:d:${reminder.id}`)
    .row()
    .text('⬅️ Back to List', 'r:list');

const buildCreateDelayKeyboard = (): InlineKeyboard =>
  new InlineKeyboard()
    .text('5 minutes later', 'r:nd:5')
    .row()
    .text('15 minutes later', 'r:nd:15')
    .row()
    .text('30 minutes later', 'r:nd:30')
    .row()
    .text('1 hour later', 'r:nd:60')
    .row()
    .text('⬅️ Cancel', 'r:new:cancel')
    .row()
    .text('⬅️ Back', 'r:new:back');

const newReminderStartKeyboard = new InlineKeyboard()
  .text('❌ Cancel', 'r:new:cancel')
  .row()
  .text('⬅️ Back', 'r:new:back');

const buildEditDelayKeyboard = (reminderId: string): InlineKeyboard =>
  new InlineKeyboard()
    .text('5 minutes later', `r:ed:${reminderId}:5`)
    .row()
    .text('15 minutes later', `r:ed:${reminderId}:15`)
    .row()
    .text('30 minutes later', `r:ed:${reminderId}:30`)
    .row()
    .text('1 hour later', `r:ed:${reminderId}:60`)
    .row()
    .text('⬅️ Back', `r:m:${reminderId}`);

const skipDetailKeyboard = new InlineKeyboard().text('⏭ No Details', 'r:skipdetail');

const deletedReminderKeyboard = new InlineKeyboard()
  .text('📋 Back to List', 'r:list')
  .row()
  .text('➕ New Reminder', 'r:new');

const reportsMenuKeyboard = new InlineKeyboard()
  .text('😴 Sleep', 'rep:sleep')
  .row()
  .text('📚 Study', 'rep:study')
  .row()
  .text('⭐ XP Earned', 'rep:xp')
  .row()
  .text('🧩 Non-Study Tasks', 'rep:tasks')
  .row()
  .text('📈 Study Chart', 'rep:chart')
  .row()
  .text('⬅️ Back to Home', 'home:back');

const rewardCenterKeyboard = new InlineKeyboard()
  .text('🛒 Buy', 'rw:buy')
  .row()
  .text('🛠 Edit Store', 'rw:edit')
  .row()
  .text('⬅️ Back to Home', 'home:back');

const dailyReportKeyboard = new InlineKeyboard()
  .text('▶️ Continue Today’s Report', 'dr:continue')
  .row()
  .text('📄 View Today’s Status', 'dr:status')
  .row()
  .text('⬅️ Back to Home', 'home:back');

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

// ===== Helpers =====

const isTooOldCallbackError = (error: unknown): error is GrammyError => {
  if (!(error instanceof GrammyError)) return false;
  return error.error_code === 400 && error.description.toLowerCase().includes('query is too old');
};

const safeAnswerCallback = async (ctx: Context, params?: Parameters<Context['answerCallbackQuery']>[0]): Promise<void> => {
  try {
    await ctx.answerCallbackQuery(params);
  } catch (error) {
    if (isTooOldCallbackError(error)) {
      console.warn({
        scope: 'telegram',
        event: 'callback_query_too_old',
        callbackQueryId: ctx.callbackQuery?.id,
        userId: ctx.from?.id
      });
      if (ctx.from?.id) {
        await ctx.api.sendMessage(ctx.from.id, 'Session expired. Please send /start to continue.');
      }
      return;
    }
    throw error;
  }
};

const greetings = [
  '👋 Hey there!',
  '🙌 Welcome!',
  '🚀 Ready to plan your day?',
  '🌟 Let’s make today productive!',
  '💪 Keep going!'
];

const chooseGreeting = (): string => greetings[Math.floor(Math.random() * greetings.length)];

const ensureOnboardedUser = async (telegramId: string, username?: string | null) => {
  const user = await ensureUser({ telegramId, username });
  const settings = (user.settings_json ?? {}) as Record<string, unknown>;
  if (settings.onboarded) return user;

  const nextSettings = { ...settings, onboarded: true };
  const updated = await updateUserSettings(user.id, nextSettings);
  return updated ?? user;
};

const buildHomeText = (isNew: boolean, timezone?: string | null): string => {
  const local = formatLocalTime(timezone ?? config.defaultTimezone);
  const lines = [chooseGreeting(), `⏱ Current time: ${local.date} | ${local.time} (${local.timezone})`];

  if (isNew) {
    lines.push(
      '',
      'Welcome to your productivity hub!',
      'You can:',
      '• Log daily reports (coming soon to match your Excel).',
      '• Earn and spend XP in the Reward Center.',
      '• Review reports and charts.',
      '• Manage reminders so you never miss a task.'
    );
  } else {
    lines.push('', 'Welcome back! Use the menu below to continue.');
  }

  return lines.join('\n');
};

const sendHome = async (ctx: Context, edit = false): Promise<void> => {
  if (!ctx.from) {
    await ctx.reply('User data is not available.');
    return;
  }

  const telegramId = String(ctx.from.id);
  const username = ctx.from.username ?? null;

  const user = await ensureOnboardedUser(telegramId, username);
  const settings = (user.settings_json ?? {}) as Record<string, unknown>;
  const isNew = !settings.onboarded;
  const text = buildHomeText(isNew, user.timezone);

  const inline = new InlineKeyboard().text('🔔 Manage Reminders', 'r:menu');

  if (edit && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { reply_markup: inline });
      await ctx.api.sendMessage(ctx.chat?.id ?? telegramId, ' ', { reply_markup: { remove_keyboard: true } }).catch(() => undefined);
      await ctx.api.sendMessage(ctx.chat?.id ?? telegramId, 'Choose an option:', { reply_markup: mainMenuKeyboard });
      return;
    } catch {
      // fall through
    }
  }

  await ctx.reply(text, { reply_markup: inline }).catch(async () => {
    await ctx.reply(text);
  });
  await ctx.reply('Choose an option:', { reply_markup: mainMenuKeyboard });
};

const renderRemindersList = async (ctx: Context, userId: string, timezone?: string | null): Promise<void> => {
  const reminders = await listRemindersForUser(userId);
  if (!reminders.length) {
    const text = 'No reminders yet. Create one to get started.';
    await ctx.editMessageText(text, { reply_markup: remindersMenuKeyboard }).catch(async () => {
      await ctx.reply(text, { reply_markup: remindersMenuKeyboard });
    });
    return;
  }

  const lines: string[] = ['📋 Your reminders:'];
  reminders.forEach((reminder, idx) => {
    const statusLabel = reminder.enabled ? 'Enabled' : 'Disabled';
    const nextRun = reminder.next_run_at_utc ? formatInstantToLocal(reminder.next_run_at_utc, timezone) : null;
    lines.push(`${idx + 1}) ${reminder.title}\n   Status: ${statusLabel}\n   Next: ${nextRun ? `${nextRun.date} | ${nextRun.time}` : '—'}`);
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
    await safeAnswerCallback(ctx, { text: 'Invalid request.', show_alert: true });
    return;
  }

  try {
    const nowUtc = new Date();
    const nextRunUtc = new Date(nowUtc.getTime() + delayMinutes * 60 * 1000);
    const user = await ensureUser({ telegramId, username });
    const reminder = await createReminder(user.id, state.title, state.detail ?? null, nextRunUtc);

    console.log({ scope: 'reminders', event: 'created', userId: user.id, telegramId, reminderId: reminder.id, delayMinutes });

    const confirmation = `✅ Reminder created.\nThe bot will message you in about ${delayMinutes} minutes.`;
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
    const errorText = '❌ Failed to create reminder. Please try again later.';
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

const renderRewardCenter = async (ctx: Context, userId: string): Promise<void> => {
  const balance = await getXpBalance(userId);
  const lines = ['🎁 Reward Center', `XP Balance: ${balance}`, '', 'Choose an option below.'];

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(lines.join('\n'), { reply_markup: rewardCenterKeyboard });
      return;
    } catch {
      // fallback
    }
  }

  await ctx.reply(lines.join('\n'), { reply_markup: rewardCenterKeyboard });
};

const renderRewardsForPurchase = async (ctx: Context): Promise<void> => {
  const rewards = await listRewards();
  if (!rewards.length) {
    await ctx.editMessageText('No rewards available yet.', { reply_markup: rewardCenterKeyboard }).catch(async () => {
      await ctx.reply('No rewards available yet.', { reply_markup: rewardCenterKeyboard });
    });
    return;
  }

  const keyboard = new InlineKeyboard();
  rewards.forEach((reward) => {
    keyboard.text(`${reward.title} (${reward.cost_xp} XP)`, `rw:buy:${reward.id}`).row();
  });
  keyboard.text('⬅️ Back', 'rw:menu');

  const lines = ['Select a reward to buy:'];
  rewards.forEach((r, idx) => lines.push(`${idx + 1}) ${r.title} — ${r.cost_xp} XP`));

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

const renderReportsMenu = async (ctx: Context): Promise<void> => {
  const text = 'Reports — choose a category:';
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { reply_markup: reportsMenuKeyboard });
      return;
    } catch {
      // fallback
    }
  }
  await ctx.reply(text, { reply_markup: reportsMenuKeyboard });
};

const renderXpSummary = async (ctx: Context, userId: string): Promise<void> => {
  try {
    const summary = await getXpSummary(userId);
    const lines = [
      'XP Summary',
      `Earned: ${summary.earned}`,
      `Spent: ${summary.spent}`,
      `Net: ${summary.net}`
    ];
    await ctx.editMessageText(lines.join('\n'), { reply_markup: reportsMenuKeyboard }).catch(async () => {
      await ctx.reply(lines.join('\n'), { reply_markup: reportsMenuKeyboard });
    });
  } catch (error) {
    console.error({ scope: 'reports', event: 'xp_summary_error', error });
    await ctx.reply('Unable to load XP summary right now.', { reply_markup: reportsMenuKeyboard });
  }
};

const checkDailyReportSchema = async (): Promise<boolean> => {
  try {
    const client = getSupabaseClient();
    const { error } = await client.from('daily_reports').select('id').limit(1);
    if (error) {
      console.warn({ scope: 'daily_reports', event: 'schema_check_error', error });
      return false;
    }
    return true;
  } catch (error) {
    console.warn({ scope: 'daily_reports', event: 'schema_check_exception', error });
    return false;
  }
};

// ===== Commands / main menus =====

bot.command('start', async (ctx: Context) => {
  await sendHome(ctx);
});

bot.command('home', async (ctx: Context) => {
  await sendHome(ctx);
});

bot.command('reminders', async (ctx: Context) => {
  await ctx.reply('Reminder menu:', { reply_markup: remindersMenuKeyboard });
});

bot.hears('📊 Reports', async (ctx: Context) => {
  await renderReportsMenu(ctx);
});

bot.hears('🎁 Reward Center', async (ctx: Context) => {
  if (!ctx.from) return;
  const telegramId = String(ctx.from.id);
  const username = ctx.from.username ?? null;
  const user = await ensureUser({ telegramId, username });
  await seedDefaultRewardsIfEmpty();
  await renderRewardCenter(ctx, user.id);
});

bot.hears('🧾 Daily Report', async (ctx: Context) => {
  const text = 'Daily Report — choose an option:';
  if (ctx.callbackQuery) {
    await safeAnswerCallback(ctx);
  }
  await ctx.reply(text, { reply_markup: dailyReportKeyboard });
});

// ===== Reminder menus =====

bot.callbackQuery('home:back', async (ctx) => {
  await safeAnswerCallback(ctx);
  await sendHome(ctx, true);
});

bot.callbackQuery('r:menu', async (ctx) => {
  await safeAnswerCallback(ctx);
  try {
    await ctx.editMessageText('🔔 Reminders — choose an option.', {
      reply_markup: remindersMenuKeyboard
    });
  } catch {
    await ctx.reply('🔔 Reminders — choose an option.', { reply_markup: remindersMenuKeyboard });
  }
});

bot.callbackQuery('r:list', async (ctx) => {
  await safeAnswerCallback(ctx);
  if (!ctx.from) return;
  const telegramId = String(ctx.from.id);
  try {
    const user = await ensureUser({ telegramId, username: ctx.from.username ?? null });
    await renderRemindersList(ctx, user.id, user.timezone);
  } catch (error) {
    console.error({ scope: 'reminders', event: 'list_error', telegramId, error });
    await ctx.reply('❌ Failed to load reminders.', { reply_markup: remindersMenuKeyboard });
  }
});

bot.callbackQuery('r:new', async (ctx) => {
  await safeAnswerCallback(ctx);
  if (!ctx.from) return;
  const telegramId = String(ctx.from.id);
  reminderStates.set(telegramId, { stage: 'create_title' });
  const prompt = '✏️ Please enter a reminder title.\nExample: medicine, call, practice, etc.';
  await ctx.editMessageText(prompt, { reply_markup: newReminderStartKeyboard }).catch(async () => {
    await ctx.reply(prompt, { reply_markup: newReminderStartKeyboard });
  });
});

bot.callbackQuery('r:skipdetail', async (ctx) => {
  await safeAnswerCallback(ctx);
  if (!ctx.from) return;
  const telegramId = String(ctx.from.id);
  const state = reminderStates.get(telegramId);
  if (!state || state.stage !== 'create_detail') return;

  reminderStates.set(telegramId, { ...state, detail: null, stage: 'create_delay' });
  await ctx.editMessageText('⏰ When should I remind you?', { reply_markup: buildCreateDelayKeyboard() });
});

bot.callbackQuery(/^r:nd:(\d+)$/, async (ctx) => {
  await safeAnswerCallback(ctx);
  const delayMinutes = Number(ctx.match?.[1] ?? 'NaN');
  await handleCreateDelay(ctx, delayMinutes);
});

bot.callbackQuery('r:new:cancel', async (ctx) => {
  await safeAnswerCallback(ctx);
  if (!ctx.from) return;
  const telegramId = String(ctx.from.id);
  clearReminderState(telegramId);
  try {
    const user = await ensureUser({ telegramId, username: ctx.from.username ?? null });
    await renderRemindersList(ctx, user.id, user.timezone);
  } catch {
    await ctx.editMessageText('❌ Reminder creation cancelled.', { reply_markup: remindersMenuKeyboard }).catch(async () => {
      await ctx.reply('❌ Reminder creation cancelled.', { reply_markup: remindersMenuKeyboard });
    });
  }
});

bot.callbackQuery('r:new:back', async (ctx) => {
  await safeAnswerCallback(ctx);
  if (!ctx.from) return;
  const telegramId = String(ctx.from.id);
  clearReminderState(telegramId);
  try {
    const user = await ensureUser({ telegramId, username: ctx.from.username ?? null });
    await renderRemindersList(ctx, user.id, user.timezone);
  } catch {
    await ctx.editMessageText('🔔 Reminders', { reply_markup: remindersMenuKeyboard }).catch(async () => {
      await ctx.reply('🔔 Reminders', { reply_markup: remindersMenuKeyboard });
    });
  }
});

bot.callbackQuery(/^r:et:(.+)$/, async (ctx) => {
  await safeAnswerCallback(ctx);
  const reminderId = ctx.match?.[1];
  if (!reminderId || !ctx.from) return;
  const telegramId = String(ctx.from.id);
  reminderStates.set(telegramId, { stage: 'edit_title', reminderId });
  await ctx.reply('✏️ Send the new reminder title.');
});

bot.callbackQuery(/^r:ed:(.+)$/, async (ctx) => {
  await safeAnswerCallback(ctx);
  const reminderId = ctx.match?.[1];
  if (!reminderId || !ctx.from) return;
  const telegramId = String(ctx.from.id);
  reminderStates.set(telegramId, { stage: 'edit_detail', reminderId });
  await ctx.reply('📝 Send the new details.\nTo remove details, use “Clear Details”.');
});

bot.callbackQuery(/^r:cd:(.+)$/, async (ctx) => {
  await safeAnswerCallback(ctx);
  const reminderId = ctx.match?.[1];
  if (!reminderId) return;
  try {
    const updated = await updateReminder(reminderId, { detail: null });
    await renderRemindersList(ctx, updated.user_id);
  } catch (error) {
    console.error({ scope: 'reminders', event: 'manage_clear_detail_error', reminderId, error });
    await ctx.reply('❌ Failed to clear details.', { reply_markup: remindersMenuKeyboard });
  }
});

bot.callbackQuery(/^r:t:(.+)$/, async (ctx) => {
  await safeAnswerCallback(ctx);
  const reminderId = ctx.match?.[1];
  if (!reminderId) return;
  try {
    const updated = await toggleReminderEnabled(reminderId);
    await renderRemindersList(ctx, updated.user_id);
  } catch (error) {
    console.error({ scope: 'reminders', event: 'manage_toggle_error', reminderId, error });
    await ctx.reply('❌ Failed to toggle reminder.', { reply_markup: remindersMenuKeyboard });
  }
});

bot.callbackQuery(/^r:time:(.+)$/, async (ctx) => {
  await safeAnswerCallback(ctx);
  const reminderId = ctx.match?.[1];
  if (!reminderId) return;
  const keyboard = buildEditDelayKeyboard(reminderId);
  await ctx.editMessageText('⏱ Choose a new delay.', { reply_markup: keyboard }).catch(async () => {
    await ctx.reply('⏱ Choose a new delay.', { reply_markup: keyboard });
  });
});

bot.callbackQuery(/^r:ed:([^:]+):(\d+)$/, async (ctx) => {
  await safeAnswerCallback(ctx);
  const reminderId = ctx.match?.[1];
  const delayMinutes = Number(ctx.match?.[2] ?? 'NaN');
  if (!reminderId || Number.isNaN(delayMinutes)) return;

  try {
    const nextRunUtc = new Date(Date.now() + delayMinutes * 60 * 1000);
    const updated = await updateReminder(reminderId, { nextRunAtUtc: nextRunUtc, enabled: true });
    await renderRemindersList(ctx, updated.user_id);
  } catch (error) {
    console.error({ scope: 'reminders', event: 'manage_edit_time_error', reminderId, error });
    await ctx.reply('❌ Failed to change reminder time.', { reply_markup: remindersMenuKeyboard });
  }
});

bot.callbackQuery(/^r:d:(.+)$/, async (ctx) => {
  await safeAnswerCallback(ctx);
  const reminderId = ctx.match?.[1];
  if (!reminderId) return;
  try {
    const reminder = await getReminderById(reminderId);
    await deleteReminder(reminderId);
    await ctx.editMessageText('🗑 Reminder deleted.', { reply_markup: deletedReminderKeyboard }).catch(async () => {
      await ctx.reply('🗑 Reminder deleted.', { reply_markup: deletedReminderKeyboard });
    });
    console.log({ scope: 'reminders', event: 'deleted', reminderId, reminderUserId: reminder?.user_id });
  } catch (error) {
    console.error({ scope: 'reminders', event: 'manage_delete_error', reminderId, error });
    await ctx.reply('❌ Failed to delete reminder.', { reply_markup: remindersMenuKeyboard });
  }
});

bot.callbackQuery(/^r:m:(.+)$/, async (ctx) => {
  await safeAnswerCallback(ctx);
  const reminderId = ctx.match?.[1];
  if (!reminderId) return;
  try {
    const reminder = await getReminderById(reminderId);
    if (!reminder) {
      await ctx.reply('Reminder not found.');
      return;
    }
    const keyboard = buildManageKeyboard(reminder);
    const lines = [
      'Reminder',
      `Title: ${reminder.title}`,
      `Details: ${reminder.detail ?? '—'}`,
      `Enabled: ${reminder.enabled ? 'Yes' : 'No'}`
    ];
    await ctx.editMessageText(lines.join('\n'), { reply_markup: keyboard }).catch(async () => {
      await ctx.reply(lines.join('\n'), { reply_markup: keyboard });
    });
  } catch (error) {
    console.error({ scope: 'reminders', event: 'manage_error', reminderId, error });
    await ctx.reply('❌ Failed to load reminder.', { reply_markup: remindersMenuKeyboard });
  }
});

bot.callbackQuery('r:new', async (ctx) => {
  await safeAnswerCallback(ctx);
  if (!ctx.from) return;
  const telegramId = String(ctx.from.id);
  reminderStates.set(telegramId, { stage: 'create_title' });
  const prompt = '✏️ Please enter a reminder title.\nExample: medicine, call, practice, etc.';
  await ctx.editMessageText(prompt, { reply_markup: newReminderStartKeyboard }).catch(async () => {
    await ctx.reply(prompt, { reply_markup: newReminderStartKeyboard });
  });
});

// ===== Daily report skeleton =====

bot.callbackQuery('dr:continue', async (ctx) => {
  await safeAnswerCallback(ctx);
  const hasSchema = await checkDailyReportSchema();
  if (!hasSchema) {
    await ctx.reply('Daily Report schema not installed yet.', { reply_markup: dailyReportKeyboard });
    return;
  }
  await ctx.reply('Daily Report entry flow will be implemented to match the Excel exactly in the next stage.', {
    reply_markup: dailyReportKeyboard
  });
});

bot.callbackQuery('dr:status', async (ctx) => {
  await safeAnswerCallback(ctx);
  const hasSchema = await checkDailyReportSchema();
  if (!hasSchema) {
    await ctx.reply('Daily Report schema not installed yet.', { reply_markup: dailyReportKeyboard });
    return;
  }
  await ctx.reply('No report data yet.', { reply_markup: dailyReportKeyboard });
});

bot.callbackQuery('dr:menu', async (ctx) => {
  await safeAnswerCallback(ctx);
  await ctx.reply('Daily Report — choose an option:', { reply_markup: dailyReportKeyboard });
});

// ===== Reward center =====

bot.callbackQuery('rw:menu', async (ctx) => {
  await safeAnswerCallback(ctx);
  if (!ctx.from) return;
  const telegramId = String(ctx.from.id);
  const user = await ensureUser({ telegramId, username: ctx.from.username ?? null });
  await renderRewardCenter(ctx, user.id);
});

bot.callbackQuery('rw:buy', async (ctx) => {
  await safeAnswerCallback(ctx);
  await renderRewardsForPurchase(ctx);
});

bot.callbackQuery(/^rw:buy:([a-f0-9-]+)$/, async (ctx) => {
  await safeAnswerCallback(ctx);
  const rewardId = ctx.match?.[1];
  if (!rewardId) return;
  const reward = await getRewardById(rewardId);
  if (!reward) {
    await ctx.reply('Reward not found.', { reply_markup: rewardCenterKeyboard });
    return;
  }

  const keyboard = new InlineKeyboard()
    .text('✅ Confirm', `rw:cfm:${reward.id}`)
    .row()
    .text('⬅️ Cancel', 'rw:menu');

  const text = `Buy "${reward.title}" for ${reward.cost_xp} XP?`;
  await ctx.editMessageText(text, { reply_markup: keyboard }).catch(async () => {
    await ctx.reply(text, { reply_markup: keyboard });
  });
});

bot.callbackQuery(/^rw:cfm:([a-f0-9-]+)$/, async (ctx) => {
  await safeAnswerCallback(ctx);
  if (!ctx.from) return;
  const rewardId = ctx.match?.[1];
  const telegramId = String(ctx.from.id);
  const user = await ensureUser({ telegramId, username: ctx.from.username ?? null });
  const reward = rewardId ? await getRewardById(rewardId) : null;
  if (!reward) {
    await ctx.reply('Reward not found.', { reply_markup: rewardCenterKeyboard });
    return;
  }
  try {
    await purchaseReward({ userId: user.id, reward });
    const balance = await getXpBalance(user.id);
    const text = `✅ Purchased "${reward.title}" for ${reward.cost_xp} XP.\nNew balance: ${balance} XP.`;
    await ctx.editMessageText(text, { reply_markup: rewardCenterKeyboard }).catch(async () => {
      await ctx.reply(text, { reply_markup: rewardCenterKeyboard });
    });
  } catch (error) {
    console.error({ scope: 'rewards', event: 'purchase_error', rewardId, userId: user.id, error });
    await ctx.reply('❌ Failed to complete purchase.', { reply_markup: rewardCenterKeyboard });
  }
});

bot.callbackQuery('rw:edit', async (ctx) => {
  await safeAnswerCallback(ctx);
  const text = 'Store editing will be implemented in the next stage.';
  await ctx.editMessageText(text, { reply_markup: rewardCenterKeyboard }).catch(async () => {
    await ctx.reply(text, { reply_markup: rewardCenterKeyboard });
  });
});

// ===== Reports =====

bot.callbackQuery('rep:sleep', async (ctx) => {
  await safeAnswerCallback(ctx);
  await ctx.reply('Sleep report: No data yet.', { reply_markup: reportsMenuKeyboard });
});

bot.callbackQuery('rep:study', async (ctx) => {
  await safeAnswerCallback(ctx);
  await ctx.reply('Study report: Coming soon.', { reply_markup: reportsMenuKeyboard });
});

bot.callbackQuery('rep:tasks', async (ctx) => {
  await safeAnswerCallback(ctx);
  await ctx.reply('Non-Study tasks: No data yet.', { reply_markup: reportsMenuKeyboard });
});

bot.callbackQuery('rep:chart', async (ctx) => {
  await safeAnswerCallback(ctx);
  await ctx.reply('Study chart: Coming soon.', { reply_markup: reportsMenuKeyboard });
});

bot.callbackQuery('rep:xp', async (ctx) => {
  await safeAnswerCallback(ctx);
  if (!ctx.from) return;
  const telegramId = String(ctx.from.id);
  const user = await ensureUser({ telegramId, username: ctx.from.username ?? null });
  await renderXpSummary(ctx, user.id);
});

bot.callbackQuery('rep:menu', async (ctx) => {
  await safeAnswerCallback(ctx);
  await renderReportsMenu(ctx);
});

// ===== Text handling for reminders creation/edit =====

bot.on('message:text', async (ctx: Context) => {
  if (!ctx.from || !ctx.message || typeof ctx.message.text !== 'string') return;

  const telegramId = String(ctx.from.id);
  const text = ctx.message.text.trim();

  // Reminder flow
  const reminderState = reminderStates.get(telegramId);
  if (reminderState) {
    if (reminderState.stage === 'create_title') {
      if (!text) {
        await ctx.reply('❗ Title is empty. Please try again.');
        return;
      }
      reminderStates.set(telegramId, { stage: 'create_detail', title: text, detail: null });
      await ctx.reply('📝 If you want, add details for this reminder.\nIf not, tap “⏭ No Details”.', {
        reply_markup: skipDetailKeyboard
      });
      return;
    }

    if (reminderState.stage === 'create_detail') {
      reminderStates.set(telegramId, { ...reminderState, detail: text, stage: 'create_delay' });
      await ctx.reply('⏰ When should I remind you?', { reply_markup: buildCreateDelayKeyboard() });
      return;
    }

    if (reminderState.stage === 'edit_title' && reminderState.reminderId) {
      try {
        const updated = await updateReminder(reminderState.reminderId, { title: text });
        clearReminderState(telegramId);
        await renderRemindersList(ctx, updated.user_id);
        console.log({ scope: 'reminders', event: 'title_updated', reminderId: updated.id });
      } catch (error) {
        console.error({ scope: 'reminders', event: 'manage_edit_title_error', reminderId: reminderState.reminderId, error });
        await ctx.reply('❌ Failed to update title.', { reply_markup: remindersMenuKeyboard });
      }
      return;
    }

    if (reminderState.stage === 'edit_detail' && reminderState.reminderId) {
      try {
        const updated = await updateReminder(reminderState.reminderId, { detail: text });
        clearReminderState(telegramId);
        await renderRemindersList(ctx, updated.user_id);
        console.log({ scope: 'reminders', event: 'detail_updated', reminderId: updated.id });
      } catch (error) {
        console.error({ scope: 'reminders', event: 'manage_edit_detail_error', reminderId: reminderState.reminderId, error });
        await ctx.reply('❌ Failed to update details.', { reply_markup: remindersMenuKeyboard });
      }
      return;
    }
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
