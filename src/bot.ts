import { Bot, InlineKeyboard, GrammyError } from 'grammy';
import type { BotError, Context } from 'grammy';
import { config } from './config';
import { seedDefaultRewardsIfEmpty, listRewards, getRewardById, purchaseReward } from './services/rewards';
import { getXpBalance, getXpSummary } from './services/xpLedger';
import { formatLocalTime } from './utils/time';
import type { ReportItemRow, ReportDayRow } from './types/supabase';
import { ensureDefaultItems, ensureDefaultTemplate, upsertItem } from './services/reportTemplates';
import { getOrCreateReportDay, listCompletionStatus, saveValue } from './services/dailyReport';
import { setUserOnboarded } from './services/userSettings';
import { consumeCallbackToken } from './services/callbackTokens';
import { getRecentTelemetryEvents, isTelemetryEnabled, logTelemetryEvent } from './services/telemetry';
import { getErrorReportByCode, logErrorReport } from './services/errorReports';
import { makeActionButton } from './ui/inlineButtons';
import { renderScreen, ensureUserAndSettings } from './ui/renderScreen';
import { aiEnabledForUser, sendMainMenu } from './ui/mainMenu';

export const bot = new Bot(config.telegram.botToken);

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

const generateTraceId = (): string => `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const getTraceId = (ctx: Context): string => {
  const existing = (ctx as unknown as { traceId?: string }).traceId;
  if (existing) return existing;
  const fresh = generateTraceId();
  (ctx as unknown as { traceId?: string }).traceId = fresh;
  return fresh;
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
        await ctx.api.sendMessage(ctx.from.id, 'Session expired. Please /start the bot again to refresh the menu.');
      }
      await renderDashboard(ctx);
      return;
    }
    throw error;
  }
};

const telemetryEnabledForUser = (userSettingsJson?: Record<string, unknown>) => isTelemetryEnabled(userSettingsJson);

const logForUser = async (params: {
  userId: string;
  ctx: Context;
  eventName: string;
  screen?: string | null;
  payload?: Record<string, unknown> | null;
  enabled: boolean;
}) =>
  logTelemetryEvent({
    userId: params.userId,
    traceId: getTraceId(params.ctx),
    eventName: params.eventName,
    screen: params.screen,
    payload: params.payload,
    enabled: params.enabled
  });

const sendErrorNotice = async (ctx: Context, errorCode: string) => {
  const btn = await makeActionButton(ctx, { label: 'Send report', action: 'error.send_report', data: { errorCode } });
  const kb = new InlineKeyboard().text(btn.text, btn.callback_data);
  await renderScreen(ctx, {
    titleKey: 'Error',
    bodyLines: [`An error occurred. Tracking code: ${errorCode}`],
    inlineKeyboard: kb
  });
};

const handleBotError = async (ctx: Context, error: unknown, traceId: string): Promise<void> => {
  try {
    const { user } = await ensureUserAndSettings(ctx);
    const enabled = telemetryEnabledForUser(user.settings_json as Record<string, unknown>);
    const errorCode = `ERR-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
    const recentEvents = await getRecentTelemetryEvents(user.id, 20);
    await logErrorReport({ userId: user.id, traceId, errorCode, error, recentEvents });
    await sendErrorNotice(ctx, errorCode);
    await logTelemetryEvent({
      userId: user.id,
      traceId,
      eventName: 'error_reported',
      payload: { error_code: errorCode },
      enabled
    });
  } catch (err) {
    console.error({ scope: 'bot', event: 'error_handler_failed', err, originalError: error, traceId });
    try {
      await ctx.reply('An unexpected error occurred and could not be reported.');
    } catch {
      // ignore
    }
  }
};

bot.use(async (ctx, next) => {
  const traceId = getTraceId(ctx);
  try {
    await next();
  } catch (error) {
    await handleBotError(ctx, error, traceId);
  }
});

const buildRewardCenterKeyboard = async (ctx: Context): Promise<InlineKeyboard> => {
  const buyBtn = await makeActionButton(ctx, { label: '🛒 Buy', action: 'rewards.buy' });
  const editBtn = await makeActionButton(ctx, { label: '🛠 Edit Store', action: 'rewards.edit' });
  const backBtn = await makeActionButton(ctx, { label: '⬅️ Back', action: 'nav.dashboard' });
  return new InlineKeyboard()
    .text(buyBtn.text, buyBtn.callback_data)
    .row()
    .text(editBtn.text, editBtn.callback_data)
    .row()
    .text(backBtn.text, backBtn.callback_data);
};

const buildDailyReportKeyboard = async (ctx: Context, reportDayId: string | null): Promise<InlineKeyboard> => {
  const statusBtn = await makeActionButton(ctx, { label: '📋 Completion Status', action: 'dr.status', data: { reportDayId } });
  const nextBtn = await makeActionButton(ctx, { label: '✏️ Fill Next Item', action: 'dr.next', data: { reportDayId } });
  const backBtn = await makeActionButton(ctx, { label: '⬅️ Back', action: 'dr.back' });
  return new InlineKeyboard()
    .text(statusBtn.text, statusBtn.callback_data)
    .row()
    .text(nextBtn.text, nextBtn.callback_data)
    .row()
    .text(backBtn.text, backBtn.callback_data);
};

const buildReportsMenuKeyboard = async (ctx: Context): Promise<InlineKeyboard> => {
  const xpBtn = await makeActionButton(ctx, { label: '⭐ XP Summary', action: 'reports.xp' });
  const sleepBtn = await makeActionButton(ctx, { label: '😴 Sleep', action: 'reports.sleep' });
  const studyBtn = await makeActionButton(ctx, { label: '📚 Study', action: 'reports.study' });
  const tasksBtn = await makeActionButton(ctx, { label: '🧩 Non-Study Tasks', action: 'reports.tasks' });
  const chartBtn = await makeActionButton(ctx, { label: '📈 Study Chart', action: 'reports.chart' });
  const backBtn = await makeActionButton(ctx, { label: '⬅️ Back', action: 'nav.dashboard' });
  return new InlineKeyboard()
    .text(xpBtn.text, xpBtn.callback_data)
    .row()
    .text(sleepBtn.text, sleepBtn.callback_data)
    .row()
    .text(studyBtn.text, studyBtn.callback_data)
    .row()
    .text(tasksBtn.text, tasksBtn.callback_data)
    .row()
    .text(chartBtn.text, chartBtn.callback_data)
    .row()
    .text(backBtn.text, backBtn.callback_data);
};

const buildDashboardLines = (isNew: boolean, timezone?: string | null): string[] => {
  const local = formatLocalTime(timezone ?? config.defaultTimezone);
  const lines = [chooseGreeting(), `⏱ Current time: ${local.date} | ${local.time}`];
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
  return lines;
};

const renderDashboard = async (ctx: Context): Promise<void> => {
  try {
    const { user, settings } = await ensureUserAndSettings(ctx);
    const isNew = !settings.onboarded;
    if (isNew) {
      try {
        await setUserOnboarded(user.id);
      } catch {
        // ignore onboarding update errors to keep UX running
      }
      await sendMainMenu(ctx, aiEnabledForUser(user.settings_json as Record<string, unknown>));
    }
    const { reportDay, items } = await ensureReportContext(ctx);
    const statuses = await listCompletionStatus(reportDay.id, items);
    const completed = statuses.filter((s) => s.filled).length;
    const total = statuses.length;
    const xpBalance = await getXpBalance(user.id);
    const streak = (user.settings_json as { streak?: number } | undefined)?.streak ?? 0;

    const bodyLines = [
      ...buildDashboardLines(isNew, user.timezone),
      '',
      `XP Balance: ${xpBalance}`,
      `Today: ${completed}/${total} items`,
      `Current streak: ${streak} days`
    ];

    const dailyReportBtn = await makeActionButton(ctx, { label: '🧾 Daily Report', action: 'nav.daily_report' });
    const reportcarBtn = await makeActionButton(ctx, { label: '📘 Reportcar', action: 'nav.reportcar' });
    const tasksBtn = await makeActionButton(ctx, { label: '✅ Tasks / Routines', action: 'nav.tasks' });
    const remindersBtn = await makeActionButton(ctx, { label: '⏰ Reminders', action: 'nav.reminders' });
    const rewardsBtn = await makeActionButton(ctx, { label: '🎁 Reward Center', action: 'nav.rewards' });
    const reportsBtn = await makeActionButton(ctx, { label: '📊 Reports', action: 'nav.reports' });
    const settingsBtn = await makeActionButton(ctx, { label: '⚙️ Settings', action: 'nav.settings' });

    const kb = new InlineKeyboard()
      .text(dailyReportBtn.text, dailyReportBtn.callback_data)
      .row()
      .text(reportcarBtn.text, reportcarBtn.callback_data)
      .row()
      .text(tasksBtn.text, tasksBtn.callback_data)
      .row()
      .text(remindersBtn.text, remindersBtn.callback_data)
      .row()
      .text(rewardsBtn.text, rewardsBtn.callback_data)
      .row()
      .text(reportsBtn.text, reportsBtn.callback_data)
      .row()
      .text(settingsBtn.text, settingsBtn.callback_data);

    await renderScreen(ctx, { titleKey: 'Dashboard', bodyLines, inlineKeyboard: kb });
  } catch (error) {
    console.error({ scope: 'home', event: 'render_error', error });
    await renderScreen(ctx, {
      titleKey: 'Dashboard',
      bodyLines: ['Unable to load dashboard right now.'],
      inlineKeyboard: new InlineKeyboard().text('Reload', 'home:back')
    });
  }
};

const renderRewardCenter = async (ctx: Context): Promise<void> => {
  try {
    const { user } = await ensureUserAndSettings(ctx);
    await seedDefaultRewardsIfEmpty(user.id);
    const balance = await getXpBalance(user.id);
    const bodyLines = [`XP Balance: ${balance}`, '', 'Choose an option:'];
    const kb = await buildRewardCenterKeyboard(ctx);
    await renderScreen(ctx, { titleKey: '🎁 Reward Center', bodyLines, inlineKeyboard: kb });
  } catch (error) {
    console.error({ scope: 'rewards', event: 'render_error', error });
    const kb = await buildRewardCenterKeyboard(ctx);
    await renderScreen(ctx, { titleKey: '🎁 Reward Center', bodyLines: ['Reward Center is temporarily unavailable. Please try again later.'], inlineKeyboard: kb });
  }
  const backBtn = await makeActionButton(ctx, { label: '⬅️ Back', action: 'nav.rewards' });
  kb.text(backBtn.text, backBtn.callback_data);
  await renderScreen(ctx, { titleKey: '🎁 Reward Center', bodyLines: ['Choose a reward to buy:'], inlineKeyboard: kb });
};

const renderRewardBuyList = async (ctx: Context): Promise<void> => {
  const { user } = await ensureUserAndSettings(ctx);
  const rewards = await listRewards(user.id);
  if (!rewards.length) {
    const kb = await buildRewardCenterKeyboard(ctx);
    await renderScreen(ctx, { titleKey: '🎁 Reward Center', bodyLines: ['No rewards available yet.'], inlineKeyboard: kb });
    return;
  }
  const kb = new InlineKeyboard();
  for (const r of rewards) {
    const btn = await makeActionButton(ctx, { label: `${r.title} (${r.xp_cost} XP)`, action: 'rewards.confirm', data: { rewardId: r.id } });
    kb.text(btn.text, btn.callback_data).row();
  }
  const backBtn = await makeActionButton(ctx, { label: '⬅️ Back', action: 'nav.rewards' });
  kb.text(backBtn.text, backBtn.callback_data);
  await renderScreen(ctx, { titleKey: '🎁 Reward Center', bodyLines: ['Choose a reward to buy:'], inlineKeyboard: kb });
};

const renderReportsMenu = async (ctx: Context): Promise<void> => {
  const kb = await buildReportsMenuKeyboard(ctx);
  await renderScreen(ctx, { titleKey: 'Reports', bodyLines: ['Choose a category:'], inlineKeyboard: kb });
};

const renderXpSummary = async (ctx: Context): Promise<void> => {
  const { user } = await ensureUserAndSettings(ctx);
  const summary = await getXpSummary(user.id);
  const lines = [`Earned: ${summary.earned}`, `Spent: ${summary.spent}`, `Net: ${summary.net}`];
  const kb = await buildReportsMenuKeyboard(ctx);
  await renderScreen(ctx, { titleKey: 'XP Summary', bodyLines: lines, inlineKeyboard: kb });
};

const renderReportcar = async (ctx: Context): Promise<void> => {
  await renderScreen(ctx, { titleKey: 'Reportcar', bodyLines: ['Reportcar will be available soon.'], inlineKeyboard: new InlineKeyboard().text('⬅️ Back', 'home:back') });
};

const renderTasks = async (ctx: Context): Promise<void> => {
  await renderScreen(ctx, { titleKey: 'Tasks / Routines', bodyLines: ['Tasks and routines will be available soon.'], inlineKeyboard: new InlineKeyboard().text('⬅️ Back', 'home:back') });
};

const renderTodo = async (ctx: Context): Promise<void> => {
  await renderScreen(ctx, { titleKey: 'To-Do List', bodyLines: ['To-Do List will be available soon.'], inlineKeyboard: new InlineKeyboard().text('⬅️ Back', 'home:back') });
};

const renderPlanning = async (ctx: Context): Promise<void> => {
  await renderScreen(ctx, { titleKey: 'Planning', bodyLines: ['Planning will be available soon.'], inlineKeyboard: new InlineKeyboard().text('⬅️ Back', 'home:back') });
};

const renderMyDay = async (ctx: Context): Promise<void> => {
  await renderScreen(ctx, { titleKey: 'My Day', bodyLines: ['My Day will be available soon.'], inlineKeyboard: new InlineKeyboard().text('⬅️ Back', 'home:back') });
};

const renderFreeText = async (ctx: Context): Promise<void> => {
  await renderScreen(ctx, { titleKey: 'Free Text', bodyLines: ['Free Text capture will be available soon.'], inlineKeyboard: new InlineKeyboard().text('⬅️ Back', 'home:back') });
};

const renderReminders = async (ctx: Context): Promise<void> => {
  await renderScreen(ctx, { titleKey: 'Reminders', bodyLines: ['Reminders will be available soon.'], inlineKeyboard: new InlineKeyboard().text('⬅️ Back', 'home:back') });
};

const renderCalendarEvents = async (ctx: Context): Promise<void> => {
  await renderScreen(ctx, { titleKey: 'Calendar & Events', bodyLines: ['Calendar & Events will be available soon.'], inlineKeyboard: new InlineKeyboard().text('⬅️ Back', 'home:back') });
};

const renderAI = async (ctx: Context): Promise<void> => {
  await renderScreen(ctx, { titleKey: 'AI', bodyLines: ['AI features will be available soon.'], inlineKeyboard: new InlineKeyboard().text('⬅️ Back', 'home:back') });
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
  for (const s of statuses) {
    const btn = await makeActionButton(ctx, { label: `${s.filled ? '✅' : '⬜️'} ${s.item.label}`, action: 'dr.item', data: { itemId: s.item.id } });
    kb.text(btn.text, btn.callback_data).row();
  }
  const backBtn = await makeActionButton(ctx, { label: '⬅️ Back', action: 'dr.back' });
  kb.text(backBtn.text, backBtn.callback_data);
  await renderScreen(ctx, { titleKey: 'Daily Report', bodyLines: lines, inlineKeyboard: kb });
};

const renderNextItem = async (ctx: Context): Promise<void> => {
  const { reportDay, items } = await ensureReportContext(ctx);
  const statuses = await listCompletionStatus(reportDay.id, items);
  const next = statuses.find((s) => !s.filled);
  if (!next) {
    const kb = await buildDailyReportKeyboard(ctx, reportDay.id);
    await renderScreen(ctx, { titleKey: 'Daily Report', bodyLines: ['All items are completed for today!'], inlineKeyboard: kb });
    return;
  }
  await promptForItem(ctx, reportDay.id, next.item);
};

const renderDailyReportRoot = async (ctx: Context): Promise<void> => {
  const { reportDay, items } = await ensureReportContext(ctx);
  const statuses = await listCompletionStatus(reportDay.id, items);
  const completed = statuses.filter((s) => s.filled).length;
  const total = statuses.length;
  const templateName = (await ensureDefaultTemplate(reportDay.user_id)).title ?? 'Default Template';
  const bodyLines = [
    `Date: ${reportDay.local_date}`,
    `Template: ${templateName}`,
    `Completion: ${completed}/${total}`,
    ''
  ];

  const statusBtn = await makeActionButton(ctx, { label: '📋 Today Status', action: 'dr.status' });
  const nextBtn = await makeActionButton(ctx, { label: '✏️ Fill Next', action: 'dr.next' });
  const pickBtn = await makeActionButton(ctx, { label: '🧩 Fill Specific Item', action: 'dr.pick_item' });
  const templatesBtn = await makeActionButton(ctx, { label: '🗂 Templates', action: 'dr.templates' });
  const historyBtn = await makeActionButton(ctx, { label: '🕘 History', action: 'dr.history' });
  const lockBtn = await makeActionButton(ctx, { label: '✅ Submit / Lock', action: 'dr.lock' });
  const backBtn = await makeActionButton(ctx, { label: '⬅️ Back', action: 'dr.back' });

  const kb = new InlineKeyboard()
    .text(statusBtn.text, statusBtn.callback_data)
    .row()
    .text(nextBtn.text, nextBtn.callback_data)
    .row()
    .text(pickBtn.text, pickBtn.callback_data)
    .row()
    .text(templatesBtn.text, templatesBtn.callback_data)
    .row()
    .text(historyBtn.text, historyBtn.callback_data)
    .row()
    .text(lockBtn.text, lockBtn.callback_data)
    .row()
    .text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, { titleKey: 'Daily Report', bodyLines, inlineKeyboard: kb });
};

const promptForItem = async (ctx: Context, reportDayId: string, item: ReportItemRow) => {
  const telegramId = String(ctx.from?.id ?? '');
  userStates.set(telegramId, { awaitingValue: { reportDayId, itemId: item.id } });
  const skipBtn = await makeActionButton(ctx, { label: '⏭ Skip', action: 'dr.skip', data: { reportDayId, itemId: item.id } });
  const cancelBtn = await makeActionButton(ctx, { label: '⬅️ Cancel', action: 'dr.menu' });
  const kb = new InlineKeyboard().text(skipBtn.text, skipBtn.callback_data).row().text(cancelBtn.text, cancelBtn.callback_data);
  await renderScreen(ctx, { titleKey: 'Daily Report', bodyLines: [`Set value for: ${item.label}`, 'Send the value as text.'], inlineKeyboard: kb });
};

const handleSaveValue = async (ctx: Context, text: string): Promise<void> => {
  if (!ctx.from) return;
  const state = userStates.get(String(ctx.from.id));
  if (!state?.awaitingValue) return;
  const { reportDayId, itemId } = state.awaitingValue;
  const { reportDay, items } = await ensureReportContext(ctx);
  if (reportDay.id !== reportDayId) {
    userStates.delete(String(ctx.from.id));
    const kb = await buildDailyReportKeyboard(ctx, reportDay.id);
    await renderScreen(ctx, { titleKey: 'Daily Report', bodyLines: ['Session expired for that item. Please pick it again.'], inlineKeyboard: kb });
    return;
  }
  const item = items.find((i) => i.id === itemId);
  if (!item) {
    userStates.delete(String(ctx.from.id));
    const kb = await buildDailyReportKeyboard(ctx, reportDay.id);
    await renderScreen(ctx, { titleKey: 'Daily Report', bodyLines: ['Item not found.'], inlineKeyboard: kb });
    return;
  }

  const numericValue = Number(text);
  const valueJson =
    item.item_type === 'number' && !Number.isNaN(numericValue)
      ? { value: numericValue, minutes: numericValue }
      : { value: text };

  await saveValue({ reportDayId, item, valueJson, userId: reportDay.user_id });
  const userSettings = (await ensureUserAndSettings(ctx)).user.settings_json as Record<string, unknown>;
  await logForUser({
    userId: reportDay.user_id,
    ctx,
    eventName: 'db_write',
    payload: { action: 'save_value', item_id: item.id },
    enabled: telemetryEnabledForUser(userSettings)
  });
  userStates.delete(String(ctx.from.id));
  const kb = await buildDailyReportKeyboard(ctx, reportDayId);
  await renderScreen(ctx, { titleKey: 'Daily Report', bodyLines: ['Saved.'], inlineKeyboard: kb });
  await renderDailyStatus(ctx);
};

// ===== Handlers =====

bot.command('start', async (ctx: Context) => {
  const { user } = await ensureUserAndSettings(ctx);
  await sendMainMenu(ctx, aiEnabledForUser(user.settings_json as Record<string, unknown>));
  await renderDashboard(ctx);
});

bot.command('debug_inline', async (ctx: Context) => {
  const keyboard = new InlineKeyboard().text('Test button', 'dbg:test');
  await ctx.reply('Inline debug screen', { reply_markup: keyboard });
});

bot.callbackQuery('dbg:test', async (ctx) => {
  await safeAnswerCallback(ctx, { text: 'Inline is working!' });
});

bot.command('debug_inline', async (ctx: Context) => {
  const keyboard = new InlineKeyboard().text('Test button', 'dbg:test');
  await ctx.reply('Inline debug screen', { reply_markup: keyboard });
});

bot.command('home', async (ctx: Context) => {
  await renderDashboard(ctx);
});

bot.command('debug_inline', async (ctx: Context) => {
  const keyboard = new InlineKeyboard().text('Test button', 'dbg:test');
  await ctx.reply('Inline debug screen', { reply_markup: keyboard });
});

bot.hears('🏠 Dashboard', renderDashboard);
bot.hears('🧾 Daily Report', async (ctx: Context) => {
  await renderDailyReportRoot(ctx);
});
bot.hears('📘 Reportcar', renderReportcar);
bot.hears('✅ Tasks / Routines', renderTasks);
bot.hears('📋 To-Do List', renderTodo);
bot.hears('🗓 Planning', renderPlanning);
bot.hears('🧭 My Day', renderMyDay);
bot.hears('📝 Free Text', renderFreeText);
bot.hears('⏰ Reminders', renderReminders);
bot.hears('🎁 Reward Center', async (ctx: Context) => {
  await renderRewardCenter(ctx);
});
bot.hears('📊 Reports', async (ctx: Context) => {
  await renderReportsMenu(ctx);
});
bot.hears('📅 Calendar & Events', renderCalendarEvents);
bot.hears('⚙️ Settings', async (ctx: Context) => {
  await renderScreen(ctx, { titleKey: 'Settings', bodyLines: ['Choose an option:'], inlineKeyboard: settingsMenuKeyboard });
});
bot.hears('🤖 AI', renderAI);

// Generic token-based callbacks
bot.callbackQuery(/^[A-Za-z0-9_-]{8,12}$/, async (ctx) => {
  await safeAnswerCallback(ctx);
  try {
    const traceId = getTraceId(ctx);
    const { user } = await ensureUserAndSettings(ctx);
    const enabled = telemetryEnabledForUser(user.settings_json as Record<string, unknown>);
    await logTelemetryEvent({
      userId: user.id,
      traceId,
      eventName: 'callback_token_pressed',
      payload: { data: ctx.callbackQuery.data },
      enabled
    });
    const token = ctx.callbackQuery.data;
    const payload = await consumeCallbackToken(token);
    await logTelemetryEvent({
      userId: user.id,
      traceId,
      eventName: 'callback_token_consumed',
      payload: { token, valid: Boolean(payload) },
      enabled
    });
    const action = typeof payload === 'object' && payload ? (payload as { action?: string }).action : null;

    if (!action) {
      await ctx.answerCallbackQuery({ text: 'Expired or invalid action. Please refresh.', show_alert: true });
      return;
    }

    switch (action) {
      case 'noop':
        break;
      case 'home.back':
        await renderDashboard(ctx);
        break;
      case 'nav.dashboard':
        await renderDashboard(ctx);
        break;
      case 'nav.daily_report':
        await renderDailyReportRoot(ctx);
        break;
      case 'nav.reportcar':
        await renderReportcar(ctx);
        break;
      case 'nav.tasks':
        await renderTasks(ctx);
        break;
      case 'nav.reminders':
        await renderReminders(ctx);
        break;
      case 'nav.rewards':
        await renderRewardCenter(ctx);
        break;
      case 'rewards.buy':
        await renderRewardBuyList(ctx);
        break;
      case 'nav.reports':
        await renderReportsMenu(ctx);
        break;
      case 'nav.settings':
        await renderScreen(ctx, { titleKey: 'Settings', bodyLines: ['Choose an option:'], inlineKeyboard: settingsMenuKeyboard });
        break;
      case 'reports.xp':
        await renderXpSummary(ctx);
        break;
      case 'reports.sleep':
      case 'reports.study':
      case 'reports.tasks':
      case 'reports.chart':
        await renderScreen(ctx, {
          titleKey: 'Reports',
          bodyLines: [`${action.split('.')[1]} report: Coming soon.`],
          inlineKeyboard: await buildReportsMenuKeyboard(ctx)
        });
        break;
      case 'dr.status':
        await renderDailyStatus(ctx);
        break;
      case 'dr.next':
        await renderNextItem(ctx);
        break;
      case 'dr.pick_item':
        await renderDailyStatus(ctx);
        break;
      case 'dr.item': {
        const itemId = (payload as { data?: { itemId?: string } }).data?.itemId;
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
        } catch (err) {
          console.error({ scope: 'daily_report', event: 'item_callback_error', error: err });
          const kb = await buildDailyReportKeyboard(ctx, null);
          await renderScreen(ctx, {
            titleKey: 'Daily Report',
            bodyLines: ['Unable to open that item right now.'],
            inlineKeyboard: kb
          });
        }
        break;
      }
      case 'dr.templates':
        const templatesBack = await makeActionButton(ctx, { label: '⬅️ Back', action: 'dr.back' });
        await renderScreen(ctx, {
          titleKey: 'Daily Report',
          bodyLines: ['Templates coming soon.'],
          inlineKeyboard: new InlineKeyboard().text(templatesBack.text, templatesBack.callback_data)
        });
        break;
      case 'dr.history':
        const historyBack = await makeActionButton(ctx, { label: '⬅️ Back', action: 'dr.back' });
        await renderScreen(ctx, {
          titleKey: 'Daily Report',
          bodyLines: ['History coming soon.'],
          inlineKeyboard: new InlineKeyboard().text(historyBack.text, historyBack.callback_data)
        });
        break;
      case 'dr.lock':
        const lockBack = await makeActionButton(ctx, { label: '⬅️ Back', action: 'dr.back' });
        await renderScreen(ctx, {
          titleKey: 'Daily Report',
          bodyLines: ['Submit/Lock coming soon.'],
          inlineKeyboard: new InlineKeyboard().text(lockBack.text, lockBack.callback_data)
        });
        break;
      case 'dr.skip': {
        const reportDayId = (payload as { data?: { reportDayId?: string } }).data?.reportDayId;
        const itemId = (payload as { data?: { itemId?: string } }).data?.itemId;
        if (!reportDayId || !itemId) {
          await renderDailyStatus(ctx);
          return;
        }
        const { reportDay, items } = await ensureReportContext(ctx);
        if (reportDay.id !== reportDayId) {
          await renderDailyStatus(ctx);
          return;
        }
        const item = items.find((i) => i.id === itemId);
        if (!item) {
          const kb = await buildDailyReportKeyboard(ctx, reportDay.id);
          await renderScreen(ctx, { titleKey: 'Daily Report', bodyLines: ['Item not found.'], inlineKeyboard: kb });
          return;
        }
        await saveValue({ reportDayId, item, valueJson: { skipped: true }, userId: reportDay.user_id });
        await renderDailyStatus(ctx);
        break;
      }
      case 'dr.menu':
        await renderDailyStatus(ctx);
        break;
      case 'dr.back':
        await renderDashboard(ctx);
        break;
      case 'rewards.buy':
        await renderRewardCenter(ctx);
        break;
      case 'rewards.confirm': {
        const rewardId = (payload as { data?: { rewardId?: string } }).data?.rewardId;
        if (!rewardId) return;
        const { user } = await ensureUserAndSettings(ctx);
        const enabled = telemetryEnabledForUser(user.settings_json as Record<string, unknown>);
        const reward = await getRewardById(rewardId);
        if (!reward) {
          const kb = await buildRewardCenterKeyboard(ctx);
          await renderScreen(ctx, { titleKey: '🎁 Reward Center', bodyLines: ['Reward not found.'], inlineKeyboard: kb });
          return;
        }
        await purchaseReward({ userId: user.id, reward });
        const balance = await getXpBalance(user.id);
        await logForUser({
          userId: user.id,
          ctx,
          eventName: 'db_write',
          payload: { action: 'purchase_reward', reward_id: reward.id, cost: reward.xp_cost },
          enabled
        });
        const kb = await buildRewardCenterKeyboard(ctx);
        await renderScreen(ctx, {
          titleKey: '🎁 Reward Center',
          bodyLines: [`Purchased "${reward.title}" for ${reward.xp_cost} XP.`, `New balance: ${balance} XP.`],
          inlineKeyboard: kb
        });
        break;
      }
      case 'rewards.edit': {
        const kb = await buildRewardCenterKeyboard(ctx);
        await renderScreen(ctx, {
          titleKey: '🎁 Reward Center',
          bodyLines: ['Store editing will be implemented in the next stage.'],
          inlineKeyboard: kb
        });
        break;
      }
      case 'error.send_report': {
        const errorCode = (payload as { errorCode?: string; data?: { errorCode?: string } }).errorCode ?? (payload as { data?: { errorCode?: string } }).data?.errorCode;
        if (!errorCode) {
          await ctx.answerCallbackQuery({ text: 'Report not found or expired.', show_alert: true });
          return;
        }
        const report = await getErrorReportByCode(errorCode);
        if (!report) {
          await ctx.answerCallbackQuery({ text: 'Report not found or expired.', show_alert: true });
          return;
        }
        const targetId = config.telegram.adminId ? Number(config.telegram.adminId) : ctx.from?.id;
        if (targetId) {
          const events =
            Array.isArray(report.recent_events) && report.recent_events.length > 0
              ? report.recent_events
                  .slice(0, 5)
                  .map((ev: any) => `• ${ev.event_name ?? 'event'}${ev.screen ? ` @ ${ev.screen}` : ''}`)
                  .join('\n')
              : 'No events captured.';
          const message = [
            '*Error report*',
            `Code: ${report.error_code}`,
            `Trace: ${report.trace_id}`,
            `Created: ${report.created_at}`,
            `User: ${report.user_id}`,
            '',
            'Recent events:',
            events
          ].join('\n');
          await ctx.api.sendMessage(targetId, message, { parse_mode: 'Markdown' });
        }
        await ctx.answerCallbackQuery({ text: 'Error report sent. Thank you.', show_alert: true });
        await logTelemetryEvent({
          userId: report.user_id,
          traceId,
          eventName: 'error_report_sent',
          payload: { error_code: errorCode, target: config.telegram.adminId ?? ctx.from?.id },
          enabled
        });
        break;
      }
      default:
        await ctx.answerCallbackQuery({ text: 'Expired or invalid action. Please refresh.', show_alert: true });
    }
  } catch (error) {
    console.error({ scope: 'callback_tokens', event: 'consume_failure', error });
    await ctx.answerCallbackQuery({ text: 'Unexpected error. Please try again.', show_alert: true });
  }
});

bot.callbackQuery(/^err:send:(.+)$/, async (ctx) => {
  await safeAnswerCallback(ctx);
  const code = ctx.match?.[1];
  if (!code) return;
  const traceId = getTraceId(ctx);
  try {
    const report = await getErrorReportByCode(code);
    if (!report) {
      await ctx.answerCallbackQuery({ text: 'Report not found.', show_alert: true });
      return;
    }
    const targetId = config.telegram.adminId ? Number(config.telegram.adminId) : ctx.from?.id;
    const message = ['Error report', `Code: ${report.error_code}`, `Trace: ${report.trace_id}`, '', 'Details:', '```', JSON.stringify(report.error_json, null, 2), '```'].join('\n');
    if (targetId) {
      await ctx.api.sendMessage(targetId, message, { parse_mode: 'Markdown' });
    }
    await logTelemetryEvent({
      userId: report.user_id,
      traceId,
      eventName: 'error_report_sent',
      payload: { error_code: code, target: targetId },
      enabled: true
    });
  } catch (error) {
    console.error({ scope: 'error_report', event: 'send_failed', error, code });
    await ctx.answerCallbackQuery({ text: 'Failed to send report.', show_alert: true });
  }
});

// Home/back
bot.callbackQuery('home:back', async (ctx) => {
  await safeAnswerCallback(ctx);
  await renderDashboard(ctx);
});

// Reports
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
  await renderScreen(ctx, { titleKey: 'Settings', bodyLines: ['Choose your study logging mode:'], inlineKeyboard: kb });
});

bot.callbackQuery(/^set:study:(.+)$/, async (ctx) => {
  await safeAnswerCallback(ctx);
  const mode = ctx.match?.[1];
  await renderScreen(ctx, { titleKey: 'Settings', bodyLines: [`Study mode set to ${mode}.`], inlineKeyboard: settingsMenuKeyboard });
});

bot.callbackQuery('set:routines', async (ctx) => {
  await safeAnswerCallback(ctx);
  userStates.set(String(ctx.from?.id ?? ''), { settingsRoutine: { step: 'label' } });
  await renderScreen(ctx, { titleKey: 'Settings', bodyLines: ['Send routine name to add (yes/no item).'], inlineKeyboard: settingsMenuKeyboard });
});

bot.callbackQuery('set:xp', async (ctx) => {
  await safeAnswerCallback(ctx);
  await renderScreen(ctx, { titleKey: 'Settings', bodyLines: ['XP & Streak rules will be configurable soon.'], inlineKeyboard: settingsMenuKeyboard });
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
    const kb = await buildDailyReportKeyboard(ctx, null);
    await renderScreen(ctx, {
      titleKey: 'Daily Report',
      bodyLines: ['Unable to open that item right now.'],
      inlineKeyboard: kb
    });
  }
});

bot.callbackQuery(/^dr:skip:([a-f0-9-]+):([a-f0-9-]+)$/, async (ctx) => {
  await safeAnswerCallback(ctx);
  const reportDayId = ctx.match?.[1];
  const itemId = ctx.match?.[2];
  const { reportDay, items } = await ensureReportContext(ctx);
  if (reportDay.id !== reportDayId) {
    await renderDailyStatus(ctx);
    return;
  }
  const item = items.find((i) => i.id === itemId);
  if (!item) {
    const kb = await buildDailyReportKeyboard(ctx, reportDay.id);
    await renderScreen(ctx, { titleKey: 'Daily Report', bodyLines: ['Item not found.'], inlineKeyboard: kb });
    return;
  }
  await saveValue({ reportDayId, item, valueJson: { skipped: true }, userId: reportDay.user_id });
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
    await renderScreen(ctx, { titleKey: 'Settings', bodyLines: ['Enter XP value for this routine (integer).'], inlineKeyboard: settingsMenuKeyboard });
    return;
  }

  if (state?.settingsRoutine?.step === 'xp') {
    const xp = Number(text);
    if (Number.isNaN(xp)) {
      await renderScreen(ctx, { titleKey: 'Settings', bodyLines: ['Please enter a number for XP value.'], inlineKeyboard: settingsMenuKeyboard });
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
    await renderScreen(ctx, { titleKey: 'Settings', bodyLines: ['Routine added.'], inlineKeyboard: settingsMenuKeyboard });
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
