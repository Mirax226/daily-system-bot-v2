import { Bot, InlineKeyboard, Keyboard, GrammyError } from 'grammy';
import type { BotError, Context } from 'grammy';
import { config } from './config';
import { ensureUser } from './services/users';
import { seedDefaultRewardsIfEmpty, listRewards, getRewardById, purchaseReward } from './services/rewards';
import { getXpBalance, getXpSummary } from './services/xpLedger';
import { formatLocalTime } from './utils/time';
import type { ReportItemRow, ReportDayRow } from './types/supabase';
import { ensureDefaultItems, ensureDefaultTemplate, upsertItem } from './services/reportTemplates';
import { getOrCreateReportDay, listCompletionStatus, saveValue } from './services/dailyReport';
import { getOrCreateUserSettings, setUserOnboarded } from './services/userSettings';

export const bot = new Bot(config.telegram.botToken);

const mainMenuKeyboard = new Keyboard()
  .text('📊 Reports')
  .text('🎁 Reward Center')
  .row()
  .text('🧾 Daily Report')
  .text('⚙️ Settings')
  .resized();

const reportsMenuKeyboard = new InlineKeyboard()
  .text('⭐ XP Summary', 'rep:xp')
  .row()
  .text('😴 Sleep', 'rep:sleep')
  .row()
  .text('📚 Study', 'rep:study')
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

const dailyReportKeyboard = (reportDayId: string | null): InlineKeyboard => {
  const kb = new InlineKeyboard().text('📋 Completion Status', `dr:status:${reportDayId ?? 'na'}`).row();
  kb.text('✏️ Fill Next Item', `dr:next:${reportDayId ?? 'na'}`).row().text('⬅️ Back to Home', 'home:back');
  return kb;
};

const settingsMenuKeyboard = new InlineKeyboard()
  .text('📄 Daily Report Form', 'set:form')
  .row()
  .text('📅 Routines', 'set:routines')
  .row()
  .text('🧮 XP & Streak Rules', 'set:xp')
  .row()
  .text('⬅️ Back to Home', 'home:back');

type ReminderlessState = {
  awaitingValue?: { reportDayId: string; itemId: string };
  settingsRoutine?: { step: 'label' | 'xp'; label?: string };
};

const userStates = new Map<string, ReminderlessState>();

const greetings = ['👋 Hey there!', '🙌 Welcome!', '🚀 Ready to plan your day?', '🌟 Let’s make today productive!', '💪 Keep going!'];
const chooseGreeting = (): string => greetings[Math.floor(Math.random() * greetings.length)];

const isTooOldCallbackError = (error: unknown): error is GrammyError =>
  error instanceof GrammyError &&
  error.error_code === 400 &&
  error.description.toLowerCase().includes('query is too old');

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
        await ctx.api.sendMessage(ctx.from.id, 'Session expired. Please /start the bot again to refresh the menu.');
      }
      await sendHome(ctx);
      return;
    }
    throw error;
  }
};

const ensureUserAndSettings = async (ctx: Context) => {
  if (!ctx.from) throw new Error('User not found in context');
  const telegramId = String(ctx.from.id);
  const username = ctx.from.username ?? null;
  const user = await ensureUser({ telegramId, username });
  const settings = await getOrCreateUserSettings(user.id);
  return { user, settings };
};

const buildHomeText = (isNew: boolean, timezone?: string | null): string => {
  const local = formatLocalTime(timezone ?? config.defaultTimezone);
  const lines = [chooseGreeting(), `⏱ Current time: ${local.date} | ${local.time} (${local.timezone})`];
  if (isNew) {
    lines.push(
      '',
      'Welcome to your productivity hub!',
      'You can:',
      '• Configure your daily report form.',
      '• Earn and spend XP in the Reward Center.',
      '• Review reports and charts.',
      '• Manage reminders (coming back soon).'
    );
  } else {
    lines.push('', 'Welcome back! Use the menu below to continue.');
  }
  return lines.join('\n');
};

export const sendHome = async (ctx: Context): Promise<void> => {
  try {
    const { user, settings } = await ensureUserAndSettings(ctx);
    const isNew = !settings.onboarded;
    if (isNew) {
      try {
        await setUserOnboarded(user.id);
      } catch {
        // ignore onboarding update errors to keep UX running
      }
    }
    const text = buildHomeText(isNew, user.timezone);
    await ctx.reply(text, { reply_markup: mainMenuKeyboard });
  } catch (error) {
    console.error({ scope: 'home', event: 'render_error', error });
    await ctx.reply('Unable to load home right now.');
  }
};

const renderRewardCenter = async (ctx: Context): Promise<void> => {
  try {
    const { user } = await ensureUserAndSettings(ctx);
    await seedDefaultRewardsIfEmpty(user.id);
    const balance = await getXpBalance(user.id);
    const text = ['🎁 Reward Center', `XP Balance: ${balance}`, '', 'Choose an option:'].join('\n');
    await ctx.reply(text, { reply_markup: rewardCenterKeyboard });
  } catch (error) {
    console.error({ scope: 'rewards', event: 'render_error', error });
    await ctx.reply('Reward Center is temporarily unavailable. Please try again later.');
  }
};

const renderReportsMenu = async (ctx: Context): Promise<void> => {
  const text = 'Reports — choose a category:';
  await ctx.reply(text, { reply_markup: reportsMenuKeyboard });
};

const renderXpSummary = async (ctx: Context): Promise<void> => {
  const { user } = await ensureUserAndSettings(ctx);
  const summary = await getXpSummary(user.id);
  const lines = ['XP Summary', `Earned: ${summary.earned}`, `Spent: ${summary.spent}`, `Net: ${summary.net}`];
  await ctx.reply(lines.join('\n'), { reply_markup: reportsMenuKeyboard });
};

const ensureReportContext = async (ctx: Context): Promise<{ userId: string; reportDay: ReportDayRow; items: ReportItemRow[] }> => {
  const { user } = await ensureUserAndSettings(ctx);
  const template = await ensureDefaultTemplate(user.id);
  const items = await ensureDefaultItems(user.id);
  const local = formatLocalTime(user.timezone ?? config.defaultTimezone);
  const reportDay = await getOrCreateReportDay({ userId: user.id, templateId: template.id, localDate: local.date });
  return { userId: user.id, reportDay, items };
};

const renderDailyStatus = async (ctx: Context): Promise<void> => {
  const { reportDay, items } = await ensureReportContext(ctx);
  const statuses = await listCompletionStatus(reportDay.id, items);
  const lines = [`Daily Report (${reportDay.local_date})`, 'Completion Status:'];
  statuses.forEach((s, idx) => lines.push(`${s.filled ? '✅' : '⬜️'} ${idx + 1}) ${s.item.label}`));

  const kb = new InlineKeyboard();
  statuses.forEach((s) => {
    kb.text(`${s.filled ? '✅' : '⬜️'} ${s.item.label}`, `dr:item:${s.item.id}`).row();
  });
  kb.text('⬅️ Back to Home', 'home:back');
  await ctx.reply(lines.join('\n'), { reply_markup: kb });
};

const renderNextItem = async (ctx: Context): Promise<void> => {
  const { reportDay, items } = await ensureReportContext(ctx);
  const statuses = await listCompletionStatus(reportDay.id, items);
  const next = statuses.find((s) => !s.filled);
  if (!next) {
    await ctx.reply('All items are completed for today!', { reply_markup: dailyReportKeyboard(reportDay.id) });
    return;
  }
  await promptForItem(ctx, reportDay.id, next.item);
};

const promptForItem = async (ctx: Context, reportDayId: string, item: ReportItemRow) => {
  const telegramId = String(ctx.from?.id ?? '');
  userStates.set(telegramId, { awaitingValue: { reportDayId, itemId: item.id } });
  const kb = new InlineKeyboard()
    .text('⏭ Skip', `dr:skip:${reportDayId}:${item.id}`)
    .row()
    .text('⬅️ Cancel', 'dr:menu');
  await ctx.reply(`Set value for: ${item.label}\nSend the value as text.`, { reply_markup: kb });
};

const handleSaveValue = async (ctx: Context, text: string): Promise<void> => {
  if (!ctx.from) return;
  const state = userStates.get(String(ctx.from.id));
  if (!state?.awaitingValue) return;
  const { reportDayId, itemId } = state.awaitingValue;
  const { reportDay, items } = await ensureReportContext(ctx);
  if (reportDay.id !== reportDayId) {
    userStates.delete(String(ctx.from.id));
    await ctx.reply('Session expired for that item. Please pick it again.');
    return;
  }
  const item = items.find((i) => i.id === itemId);
  if (!item) {
    userStates.delete(String(ctx.from.id));
    await ctx.reply('Item not found.');
    return;
  }

  const numericValue = Number(text);
  const valueJson =
    item.item_type === 'number' && !Number.isNaN(numericValue)
      ? { value: numericValue, minutes: numericValue }
      : { value: text };

  await saveValue({ reportDayId, item, valueJson, userId: reportDay.user_id });
  userStates.delete(String(ctx.from.id));
  await ctx.reply('Saved.', { reply_markup: dailyReportKeyboard(reportDayId) });
  await renderDailyStatus(ctx);
};

// ===== Handlers =====

bot.command('start', async (ctx: Context) => {
  await sendHome(ctx);
});

bot.command('home', async (ctx: Context) => {
  await sendHome(ctx);
});

bot.hears('📊 Reports', async (ctx: Context) => {
  await renderReportsMenu(ctx);
});

bot.hears('🎁 Reward Center', async (ctx: Context) => {
  await renderRewardCenter(ctx);
});

bot.hears('🧾 Daily Report', async (ctx: Context) => {
  await renderDailyStatus(ctx);
});

bot.hears('⚙️ Settings', async (ctx: Context) => {
  await ctx.reply('Settings — choose an option:', { reply_markup: settingsMenuKeyboard });
});

// Home/back
bot.callbackQuery('home:back', async (ctx) => {
  await safeAnswerCallback(ctx);
  await sendHome(ctx);
});

// Reports
bot.callbackQuery('rep:xp', async (ctx) => {
  await safeAnswerCallback(ctx);
  await renderXpSummary(ctx);
});

bot.callbackQuery(/rep:(sleep|study|tasks|chart)/, async (ctx) => {
  await safeAnswerCallback(ctx);
  const target = ctx.match?.[1] ?? '';
  await ctx.reply(`${target} report: Coming soon.`, { reply_markup: reportsMenuKeyboard });
});

// Reward center
bot.callbackQuery('rw:menu', async (ctx) => {
  await safeAnswerCallback(ctx);
  await renderRewardCenter(ctx);
});

bot.callbackQuery('rw:buy', async (ctx) => {
  await safeAnswerCallback(ctx);
  const { user } = await ensureUserAndSettings(ctx);
  const rewards = await listRewards(user.id);
  if (!rewards.length) {
    await ctx.reply('No rewards available yet.', { reply_markup: rewardCenterKeyboard });
    return;
  }
  const kb = new InlineKeyboard();
  rewards.forEach((r) => kb.text(`${r.title} (${r.xp_cost} XP)`, `rw:cfm:${r.id}`).row());
  kb.text('⬅️ Back', 'rw:menu');
  await ctx.reply('Choose a reward to buy:', { reply_markup: kb });
});

bot.callbackQuery(/^rw:cfm:([a-f0-9-]+)$/, async (ctx) => {
  await safeAnswerCallback(ctx);
  if (!ctx.from) return;
  const rewardId = ctx.match?.[1];
  const { user } = await ensureUserAndSettings(ctx);
  const reward = rewardId ? await getRewardById(rewardId) : null;
  if (!reward) {
    await ctx.reply('Reward not found.', { reply_markup: rewardCenterKeyboard });
    return;
  }
  await purchaseReward({ userId: user.id, reward });
  const balance = await getXpBalance(user.id);
  await ctx.reply(`Purchased "${reward.title}" for ${reward.xp_cost} XP.\nNew balance: ${balance} XP.`, { reply_markup: rewardCenterKeyboard });
});

bot.callbackQuery('rw:edit', async (ctx) => {
  await safeAnswerCallback(ctx);
  await ctx.reply('Store editing will be implemented in the next stage.', { reply_markup: rewardCenterKeyboard });
});

// Settings
bot.callbackQuery('set:form', async (ctx) => {
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard()
    .text('Pomodoro Mode', 'set:study:pomodoro')
    .row()
    .text('Hourly Mode', 'set:study:hourly')
    .row()
    .text('Duration Mode', 'set:study:duration')
    .row()
    .text('⬅️ Back', 'home:back');
  await ctx.reply('Choose your study logging mode:', { reply_markup: kb });
});

bot.callbackQuery(/^set:study:(.+)$/, async (ctx) => {
  await safeAnswerCallback(ctx);
  const mode = ctx.match?.[1];
  await ctx.reply(`Study mode set to ${mode}.`, { reply_markup: settingsMenuKeyboard });
});

bot.callbackQuery('set:routines', async (ctx) => {
  await safeAnswerCallback(ctx);
  userStates.set(String(ctx.from?.id ?? ''), { settingsRoutine: { step: 'label' } });
  await ctx.reply('Send routine name to add (yes/no item).');
});

bot.callbackQuery('set:xp', async (ctx) => {
  await safeAnswerCallback(ctx);
  await ctx.reply('XP & Streak rules will be configurable soon.', { reply_markup: settingsMenuKeyboard });
});

// Daily report
bot.callbackQuery(/^dr:status:(.+)$/, async (ctx) => {
  await safeAnswerCallback(ctx);
  await renderDailyStatus(ctx);
});

bot.callbackQuery(/^dr:next:(.+)$/, async (ctx) => {
  await safeAnswerCallback(ctx);
  await renderNextItem(ctx);
});

bot.callbackQuery(/^dr:item:([a-f0-9-]+)$/, async (ctx) => {
  await safeAnswerCallback(ctx);
  const itemId = ctx.match?.[1];
  if (!itemId) {
    await ctx.answerCallbackQuery({ text: 'Item not found', show_alert: true });
    return;
  }
  try {
    const { reportDay, items } = await ensureReportContext(ctx);
    const item = items.find((i) => i.id === itemId);
    if (!item) {
      await ctx.answerCallbackQuery({ text: 'Item not found', show_alert: true });
      return;
    }
    await promptForItem(ctx, reportDay.id, item);
  } catch (error) {
    console.error({ scope: 'daily_report', event: 'item_callback_error', error });
    await ctx.reply('Unable to open that item right now.');
  }
});

bot.callbackQuery(/^dr:skip:([a-f0-9-]+):([a-f0-9-]+)$/, async (ctx) => {
  await safeAnswerCallback(ctx);
  const reportDayId = ctx.match?.[1];
  const itemId = ctx.match?.[2];
  const { reportDay, items } = await ensureReportContext(ctx);
  if (reportDay.id !== reportDayId) {
    await ctx.reply('Report session is outdated. Opening current day instead.');
    await renderDailyStatus(ctx);
    return;
  }
  const item = items.find((i) => i.id === itemId);
  if (!item) {
    await ctx.reply('Item not found.');
    return;
  }
  await saveValue({ reportDayId, item, valueJson: { skipped: true }, userId: reportDay.user_id });
  await ctx.reply('Skipped.', { reply_markup: dailyReportKeyboard(reportDayId) });
  await renderDailyStatus(ctx);
});

bot.callbackQuery('dr:menu', async (ctx) => {
  await safeAnswerCallback(ctx);
  await renderDailyStatus(ctx);
});

// Text input handler
bot.on('message:text', async (ctx: Context) => {
  if (!ctx.from || !ctx.message || typeof ctx.message.text !== 'string') return;
  const text = ctx.message.text.trim();
  const state = userStates.get(String(ctx.from.id));

  if (state?.awaitingValue) {
    await handleSaveValue(ctx, text);
    return;
  }

  if (state?.settingsRoutine?.step === 'label') {
    userStates.set(String(ctx.from.id), { settingsRoutine: { step: 'xp', label: text } });
    await ctx.reply('Enter XP value for this routine (integer).');
    return;
  }

  if (state?.settingsRoutine?.step === 'xp') {
    const xp = Number(text);
    if (Number.isNaN(xp)) {
      await ctx.reply('Please enter a number for XP value.');
      return;
    }
    const label = state.settingsRoutine.label ?? 'Routine';
    const { user } = await ensureUserAndSettings(ctx);
    const template = await ensureDefaultTemplate(user.id);
    await ensureDefaultItems(user.id);
    await upsertItem({
      templateId: template.id,
      label,
      itemKey: `routine_${Date.now()}`,
      itemType: 'boolean',
      category: 'routine',
      xpMode: 'fixed',
      xpValue: xp,
      optionsJson: {},
      sortOrder: Date.now() % 100000
    });
    userStates.delete(String(ctx.from.id));
    await ctx.reply('Routine added.', { reply_markup: settingsMenuKeyboard });
    return;
  }
});

// Global error handler
bot.catch((err: BotError<Context>) => {
  const { ctx, error } = err;
  console.error('Bot error:', {
    updateId: ctx.update?.update_id,
    error
  });
});
