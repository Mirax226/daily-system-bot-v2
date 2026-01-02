import { Bot, InlineKeyboard, GrammyError } from 'grammy';
import type { BotError, Context } from 'grammy';
import { config } from './config';
import { ensureUser } from './services/users';
import { getOrCreateUserSettings, setUserOnboarded } from './services/userSettings';
import {
  seedDefaultRewardsIfEmpty,
  listRewards,
  getRewardById,
  purchaseReward,
  listRewardsForEdit,
  createReward,
  updateReward,
  deleteReward
} from './services/rewards';
import { getXpBalance, getXpSummary } from './services/xpLedger';
import {
  ensureDefaultItems,
  ensureDefaultTemplate,
  listItems,
  listUserTemplates,
  setActiveTemplate,
  deleteTemplate as deleteReportTemplate,
  duplicateTemplate,
  getTemplateById
} from './services/reportTemplates';
import {
  getOrCreateReportDay,
  listCompletionStatus,
  saveValue,
  listRecentReportDays,
  getReportDayById,
  lockReportDay,
  unlockReportDay,
  autoLockIfCompleted,
  getReportDayByDate
} from './services/dailyReport';
import { consumeCallbackToken } from './services/callbackTokens';
import { getRecentTelemetryEvents, isTelemetryEnabled, logTelemetryEvent } from './services/telemetry';
import { getErrorReportByCode, logErrorReport } from './services/errorReports';
import { makeActionButton } from './ui/inlineButtons';
import { renderScreen, ensureUserAndSettings as renderEnsureUserAndSettings } from './ui/renderScreen';
import { aiEnabledForUser, sendMainMenu } from './ui/mainMenu';
import { formatLocalTime } from './utils/time';
import { t } from './i18n';
import type { ReportItemRow, ReportDayRow, RewardRow } from './types/supabase';

export const bot = new Bot<Context>(config.telegram.botToken);

type ReminderlessState = {
  awaitingValue?: { reportDayId: string; itemId: string };
  settingsRoutine?: { step: 'label' | 'xp'; label?: string };
  numericDraft?: { reportDayId: string; itemId: string; value: number };
  timeDraft?: { reportDayId: string; itemId: string; hour12: number; minuteTens: number; minuteOnes: number; ampm: 'AM' | 'PM' };
  rewardEdit?: {
    mode: 'create' | 'edit';
    rewardId?: string;
    step: 'title' | 'description' | 'xp' | 'confirm_delete';
    draft: { title?: string; description?: string | null; xpCost?: number };
  };
};

const userStates = new Map<string, ReminderlessState>();
const reportContextCache = new Map<string, { reportDay: ReportDayRow; items: ReportItemRow[] }>();
const clearReportContextCache = (reportDayId?: string): void => {
  if (!reportDayId) {
    reportContextCache.clear();
    return;
  }
  for (const [key, value] of reportContextCache.entries()) {
    if (value.reportDay.id === reportDayId || key === reportDayId) {
      reportContextCache.delete(key);
    }
  }
};

const greetings = ['👋 Hey there!', '🙌 Welcome!', '🚀 Ready to plan your day?', '🌟 Let’s make today productive!', '💪 Keep going!'];
const chooseGreeting = (): string => greetings[Math.floor(Math.random() * greetings.length)];

const isTooOldCallbackError = (error: unknown): error is GrammyError =>
  error instanceof GrammyError && error.error_code === 400 && error.description.toLowerCase().includes('query is too old');

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

const ensureUserAndSettings = async (ctx: Context) => {
  if (renderEnsureUserAndSettings) {
    return renderEnsureUserAndSettings(ctx);
  }
  if (!ctx.from) throw new Error('User not found in context');
  const telegramId = String(ctx.from.id);
  const username = ctx.from.username ?? null;
  const user = await ensureUser({ telegramId, username });
  const settings = await getOrCreateUserSettings(user.id);
  return { user, settings };
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
  const btn = await makeActionButton(ctx, { label: t('buttons.send_report'), action: 'error.send_report', data: { errorCode } });
  const kb = new InlineKeyboard().text(btn.text, btn.callback_data);
  await renderScreen(ctx, {
    titleKey: 'Error',
    bodyLines: [t('errors.with_code', { code: errorCode })],
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
      await ctx.reply(t('errors.unexpected'));
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

const buildDashboardLines = (isNew: boolean, timezone?: string | null): string[] => {
  const local = formatLocalTime(timezone ?? config.defaultTimezone);
  const lines = [chooseGreeting(), t('screens.dashboard.time', { date: local.date, time: local.time })];
  if (isNew) {
    const welcomeNew = t('screens.dashboard.welcome_new');
    lines.push('', ...(Array.isArray(welcomeNew) ? welcomeNew : [welcomeNew]));
  } else {
    lines.push('', t('screens.dashboard.welcome_back'));
  }
  return lines;
};

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

const buildDailyReportKeyboard = async (ctx: Context, reportDayId: string | null): Promise<InlineKeyboard> => {
  const statusBtn = await makeActionButton(ctx, { label: t('buttons.dr_today_status'), action: 'dr.status', data: { reportDayId } });
  const nextBtn = await makeActionButton(ctx, { label: t('buttons.dr_fill_next'), action: 'dr.next', data: { reportDayId } });
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'dr.back' });
  return new InlineKeyboard()
    .text(statusBtn.text, statusBtn.callback_data)
    .row()
    .text(nextBtn.text, nextBtn.callback_data)
    .row()
    .text(backBtn.text, backBtn.callback_data);
};

const ensureReportContext = async (
  ctx: Context,
  opts?: { reportDayId?: string; localDate?: string; createIfMissing?: boolean }
): Promise<{ userId: string; reportDay: ReportDayRow; items: ReportItemRow[] }> => {
  const { user, settings } = await ensureUserAndSettings(ctx);

  if (opts?.reportDayId) {
    const cachedById = reportContextCache.get(opts.reportDayId);
    if (cachedById) return { userId: user.id, ...cachedById };
    const reportDay = await getReportDayById(opts.reportDayId);
    if (!reportDay || reportDay.user_id !== user.id) {
      throw new Error('Report day not found');
    }
    const template = (await getTemplateById(reportDay.template_id)) ?? (await ensureDefaultTemplate(user.id));
    const items = await listItems(template.id);
    const context = { reportDay, items };
    reportContextCache.set(reportDay.id, context);
    return { userId: user.id, ...context };
  }

  const local = formatLocalTime(user.timezone ?? config.defaultTimezone);
  const targetDate = opts?.localDate ?? local.date;
  const activeTemplateId = (settings.settings_json as { active_template_id?: string } | null)?.active_template_id;
  const defaultTemplate = await ensureDefaultTemplate(user.id);

  let template = activeTemplateId ? await getTemplateById(activeTemplateId) : null;
  if (!template || template.user_id !== user.id) {
    template = defaultTemplate;
  }
  const cacheKey = `${user.id}:${targetDate}:${template.id}`;
  const cached = reportContextCache.get(cacheKey);
  if (cached) return { userId: user.id, ...cached };

  const items = template.id === defaultTemplate.id ? await ensureDefaultItems(user.id) : await listItems(template.id);
  let reportDay: ReportDayRow | null;
  if (opts?.createIfMissing === false) {
    reportDay = await getReportDayByDate({ userId: user.id, templateId: template.id, localDate: targetDate });
    if (!reportDay) throw new Error('Report day not found');
  } else {
    reportDay = await getOrCreateReportDay({ userId: user.id, templateId: template.id, localDate: targetDate });
  }

  const context = { reportDay, items };
  reportContextCache.set(cacheKey, context);
  reportContextCache.set(reportDay.id, context);
  return { userId: user.id, ...context };
};

const shiftLocalDate = (date: string, deltaDays: number): string => {
  const [y, m, d] = date.split('-').map((part) => Number(part));
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
};

const loadYesterdayStatus = async (
  ctx: Context
): Promise<{ hasOpen: boolean; reportDay: ReportDayRow | null; items: ReportItemRow[]; statuses: Awaited<ReturnType<typeof listCompletionStatus>> | null }> => {
  const { user } = await ensureUserAndSettings(ctx);
  const local = formatLocalTime(user.timezone ?? config.defaultTimezone);
  const yesterdayDate = shiftLocalDate(local.date, -1);
  const template = await ensureDefaultTemplate(user.id);
  const reportDay = await getReportDayByDate({ userId: user.id, templateId: template.id, localDate: yesterdayDate });
  if (!reportDay) return { hasOpen: false, reportDay: null, items: [], statuses: null };
  const items = await ensureDefaultItems(user.id);
  const statuses = await listCompletionStatus(reportDay.id, items);
  const openCount = statuses.filter((s) => !s.filled && !s.skipped).length;
  if (openCount === 0) {
    if (!reportDay.locked) {
      await autoLockIfCompleted({ reportDay, items });
      clearReportContextCache(reportDay.id);
    }
    return { hasOpen: false, reportDay, items, statuses };
  }
  if (reportDay.locked) {
    return { hasOpen: false, reportDay, items, statuses };
  }
  return { hasOpen: true, reportDay, items, statuses };
};

const renderDashboard = async (ctx: Context): Promise<void> => {
  try {
    const { user, settings } = await ensureUserAndSettings(ctx);
    const isNew = !settings.onboarded;
    await loadYesterdayStatus(ctx);
    if (isNew) {
      try {
        await setUserOnboarded(user.id);
      } catch {
        // ignore onboarding update errors
      }
    }
    if (isNew || ctx.message) {
      await sendMainMenu(ctx, aiEnabledForUser(user.settings_json as Record<string, unknown>));
    }
    const reportContextPromise = ensureReportContext(ctx);
    const xpBalancePromise = getXpBalance(user.id);

    const { reportDay, items } = await reportContextPromise;
    const statuses = await listCompletionStatus(reportDay.id, items);
    const completed = statuses.filter((s) => s.filled).length;
    const total = statuses.length;
    const xpBalance = await xpBalancePromise;
    const streak = (user.settings_json as { streak?: number } | undefined)?.streak ?? 0;

    const bodyLines = [
      ...buildDashboardLines(isNew, user.timezone),
      '',
      t('screens.dashboard.xp_balance', { xp: xpBalance }),
      t('screens.dashboard.today_items', { completed, total }),
      t('screens.dashboard.streak', { streak })
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
    const reloadBtn = await makeActionButton(ctx, { label: 'Reload', action: 'nav.dashboard' });
    await renderScreen(ctx, {
      titleKey: 'Dashboard',
      bodyLines: ['Unable to load dashboard right now.'],
      inlineKeyboard: new InlineKeyboard().text(reloadBtn.text, reloadBtn.callback_data)
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
    await renderScreen(ctx, {
      titleKey: '🎁 Reward Center',
      bodyLines: ['Reward Center is temporarily unavailable. Please try again later.'],
      inlineKeyboard: kb
    });
  }
};

const clearRewardEditState = (telegramId: string): void => {
  const state = userStates.get(telegramId);
  if (!state?.rewardEdit) return;
  const nextState = { ...state };
  delete nextState.rewardEdit;
  userStates.set(telegramId, nextState);
};

const getRewardForUser = async (rewardId: string, userId: string): Promise<RewardRow | null> => {
  const reward = await getRewardById(rewardId);
  if (!reward) return null;
  if (reward.user_id !== userId) return null;
  return reward;
};

const renderRewardStoreEditorRoot = async (ctx: Context): Promise<void> => {
  const { user } = await ensureUserAndSettings(ctx);
  const telegramId = String(ctx.from?.id ?? '');
  clearRewardEditState(telegramId);

  const rewards = await listRewardsForEdit(user.id);
  const bodyLines: string[] = ['Edit Store', ''];

  if (!rewards.length) {
    bodyLines.push('No rewards defined yet.', '', 'Use this screen to manage your rewards.');
  } else {
    bodyLines.push('Rewards:');
    rewards.forEach((r) => {
      const status = r.is_active ? 'active' : 'inactive';
      bodyLines.push(`• ${r.title} — ${r.xp_cost} XP (${status})`);
    });
  }

  const kb = new InlineKeyboard();
  const addBtn = await makeActionButton(ctx, { label: '➕ Add reward', action: 'rewards.add' });
  kb.text(addBtn.text, addBtn.callback_data).row();

  for (const reward of rewards) {
    const editBtn = await makeActionButton(ctx, { label: `✏ ${reward.title}`, action: 'rewards.edit_open', data: { rewardId: reward.id } });
    kb.text(editBtn.text, editBtn.callback_data).row();
  }

  const backBtn = await makeActionButton(ctx, { label: '⬅️ Back', action: 'nav.rewards' });
  kb.text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, { titleKey: '🎁 Reward Center', bodyLines, inlineKeyboard: kb });
};

const renderRewardEditMenu = async (ctx: Context, reward: RewardRow): Promise<void> => {
  const lines = [`Editing: "${reward.title}" (${reward.xp_cost} XP)`, `Status: ${reward.is_active ? 'Active' : 'Inactive'}`];
  const titleBtn = await makeActionButton(ctx, { label: '✏ Title', action: 'rewards.edit_title', data: { rewardId: reward.id } });
  const descBtn = await makeActionButton(ctx, { label: '📝 Description', action: 'rewards.edit_description', data: { rewardId: reward.id } });
  const xpBtn = await makeActionButton(ctx, { label: '💰 XP Cost', action: 'rewards.edit_xp', data: { rewardId: reward.id } });
  const toggleBtn = await makeActionButton(ctx, {
    label: reward.is_active ? '🧊 Deactivate' : '🔥 Activate',
    action: 'rewards.toggle_active',
    data: { rewardId: reward.id }
  });
  const deleteBtn = await makeActionButton(ctx, { label: '🗑 Delete', action: 'rewards.delete', data: { rewardId: reward.id } });
  const backBtn = await makeActionButton(ctx, { label: '⬅️ Back', action: 'rewards.edit_root' });

  const kb = new InlineKeyboard()
    .text(titleBtn.text, titleBtn.callback_data)
    .row()
    .text(descBtn.text, descBtn.callback_data)
    .row()
    .text(xpBtn.text, xpBtn.callback_data)
    .row()
    .text(toggleBtn.text, toggleBtn.callback_data)
    .row()
    .text(deleteBtn.text, deleteBtn.callback_data)
    .row()
    .text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, { titleKey: 'Edit Store', bodyLines: lines, inlineKeyboard: kb });
};

const renderCreateRewardTitlePrompt = async (ctx: Context, errorLine?: string): Promise<void> => {
  const cancelBtn = await makeActionButton(ctx, { label: '⬅️ Cancel', action: 'rewards.edit_root' });
  const lines = errorLine ? [errorLine, '', 'Send reward title as text.'] : ['Send reward title as text.'];
  await renderScreen(ctx, {
    titleKey: 'Add Reward',
    bodyLines: lines,
    inlineKeyboard: new InlineKeyboard().text(cancelBtn.text, cancelBtn.callback_data)
  });
};

const renderCreateRewardDescriptionPrompt = async (
  ctx: Context,
  draft: { title?: string },
  errorLine?: string
): Promise<void> => {
  const cancelBtn = await makeActionButton(ctx, { label: '⬅️ Cancel', action: 'rewards.edit_root' });
  const lines = errorLine
    ? [errorLine, '', 'Send reward description as text (or "-" to skip).']
    : [`Title: ${draft.title ?? ''}`, 'Send reward description as text (or "-" to skip).'];
  await renderScreen(ctx, {
    titleKey: 'Add Reward',
    bodyLines: lines,
    inlineKeyboard: new InlineKeyboard().text(cancelBtn.text, cancelBtn.callback_data)
  });
};

const renderCreateRewardXpPrompt = async (
  ctx: Context,
  draft: { title?: string; description?: string | null },
  errorLine?: string
): Promise<void> => {
  const cancelBtn = await makeActionButton(ctx, { label: '⬅️ Cancel', action: 'rewards.edit_root' });
  const summary: string[] = [];
  if (draft.title) summary.push(`Title: ${draft.title}`);
  if (draft.description !== undefined) summary.push(`Description: ${draft.description ?? '(none)'}`);
  const lines = [...summary, errorLine ? errorLine : 'Send XP cost as a positive integer.'];
  await renderScreen(ctx, {
    titleKey: 'Add Reward',
    bodyLines: lines,
    inlineKeyboard: new InlineKeyboard().text(cancelBtn.text, cancelBtn.callback_data)
  });
};

const renderEditRewardTitlePrompt = async (ctx: Context, rewardId: string, errorLine?: string): Promise<void> => {
  const cancelBtn = await makeActionButton(ctx, { label: '⬅️ Cancel', action: 'rewards.edit_open', data: { rewardId } });
  const lines = errorLine ? [errorLine, '', 'Send new title as text.'] : ['Send new title as text.'];
  await renderScreen(ctx, {
    titleKey: 'Edit Reward',
    bodyLines: lines,
    inlineKeyboard: new InlineKeyboard().text(cancelBtn.text, cancelBtn.callback_data)
  });
};

const renderEditRewardDescriptionPrompt = async (ctx: Context, rewardId: string, errorLine?: string): Promise<void> => {
  const cancelBtn = await makeActionButton(ctx, { label: '⬅️ Cancel', action: 'rewards.edit_open', data: { rewardId } });
  const lines = errorLine
    ? [errorLine, '', 'Send new description as text (or "-" to clear).']
    : ['Send new description as text (or "-" to clear).'];
  await renderScreen(ctx, {
    titleKey: 'Edit Reward',
    bodyLines: lines,
    inlineKeyboard: new InlineKeyboard().text(cancelBtn.text, cancelBtn.callback_data)
  });
};

const renderEditRewardXpPrompt = async (ctx: Context, rewardId: string, errorLine?: string): Promise<void> => {
  const cancelBtn = await makeActionButton(ctx, { label: '⬅️ Cancel', action: 'rewards.edit_open', data: { rewardId } });
  const lines = errorLine ? [errorLine, '', 'Send XP cost as a positive integer.'] : ['Send XP cost as a positive integer.'];
  await renderScreen(ctx, {
    titleKey: 'Edit Reward',
    bodyLines: lines,
    inlineKeyboard: new InlineKeyboard().text(cancelBtn.text, cancelBtn.callback_data)
  });
};

const handleRewardEditText = async (ctx: Context, rewardState: NonNullable<ReminderlessState['rewardEdit']>): Promise<void> => {
  const telegramId = String(ctx.from?.id ?? '');
  const messageText = ctx.message?.text ?? '';
  const trimmed = messageText.trim();
  const existing = userStates.get(telegramId) ?? {};

  if (rewardState.mode === 'create') {
    if (rewardState.step === 'title') {
      if (!trimmed) {
        await renderCreateRewardTitlePrompt(ctx, 'Title cannot be empty.');
        return;
      }
      userStates.set(telegramId, {
        ...existing,
        rewardEdit: { ...rewardState, step: 'description', draft: { ...rewardState.draft, title: trimmed } }
      });
      await renderCreateRewardDescriptionPrompt(ctx, { title: trimmed });
      return;
    }

    if (rewardState.step === 'description') {
      const description = trimmed === '-' ? null : trimmed;
      const nextDraft = { ...rewardState.draft, description };
      const title = rewardState.draft.title;
      if (!title) {
        userStates.set(telegramId, { ...existing, rewardEdit: { mode: 'create', step: 'title', draft: {} } });
        await renderCreateRewardTitlePrompt(ctx, 'Title is required before setting description.');
        return;
      }
      userStates.set(telegramId, {
        ...existing,
        rewardEdit: { ...rewardState, step: 'xp', draft: { ...nextDraft, title } }
      });
      await renderCreateRewardXpPrompt(ctx, { title, description });
      return;
    }

    if (rewardState.step === 'xp') {
      const xp = Number.parseInt(trimmed, 10);
      const title = rewardState.draft.title;
      if (!title) {
        userStates.set(telegramId, { ...existing, rewardEdit: { mode: 'create', step: 'title', draft: {} } });
        await renderCreateRewardTitlePrompt(ctx, 'Title is required before setting XP cost.');
        return;
      }
      if (!Number.isInteger(xp) || xp <= 0) {
        await renderCreateRewardXpPrompt(ctx, rewardState.draft, 'Please enter a positive integer.');
        return;
      }
      const { user } = await ensureUserAndSettings(ctx);
      await createReward({ userId: user.id, title, description: rewardState.draft.description ?? null, xpCost: xp });
      clearRewardEditState(telegramId);
      await renderRewardStoreEditorRoot(ctx);
      return;
    }
  }

  if (rewardState.mode === 'edit') {
    const rewardId = rewardState.rewardId;
    if (!rewardId) {
      clearRewardEditState(telegramId);
      await renderRewardStoreEditorRoot(ctx);
      return;
    }
    const { user } = await ensureUserAndSettings(ctx);
    const reward = await getRewardForUser(rewardId, user.id);
    if (!reward) {
      clearRewardEditState(telegramId);
      await renderRewardStoreEditorRoot(ctx);
      return;
    }

    if (rewardState.step === 'title') {
      if (!trimmed) {
        await renderEditRewardTitlePrompt(ctx, rewardId, 'Title cannot be empty.');
        return;
      }
      const updated = await updateReward({ rewardId, patch: { title: trimmed } });
      clearRewardEditState(telegramId);
      await renderRewardEditMenu(ctx, updated);
      return;
    }

    if (rewardState.step === 'description') {
      const description = trimmed === '-' ? null : trimmed;
      const updated = await updateReward({ rewardId, patch: { description } });
      clearRewardEditState(telegramId);
      await renderRewardEditMenu(ctx, updated);
      return;
    }

    if (rewardState.step === 'xp') {
      const xp = Number.parseInt(trimmed, 10);
      if (!Number.isInteger(xp) || xp <= 0) {
        await renderEditRewardXpPrompt(ctx, rewardId, 'Please enter a positive integer.');
        return;
      }
      const updated = await updateReward({ rewardId, patch: { xpCost: xp } });
      clearRewardEditState(telegramId);
      await renderRewardEditMenu(ctx, updated);
      return;
    }

    if (rewardState.step === 'confirm_delete') {
      clearRewardEditState(telegramId);
      await renderRewardStoreEditorRoot(ctx);
      return;
    }
  }
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
  for (const reward of rewards) {
    const btn = await makeActionButton(ctx, { label: `${reward.title} (${reward.xp_cost} XP)`, action: 'rewards.confirm', data: { rewardId: reward.id } });
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
  const back = await makeActionButton(ctx, { label: '⬅️ Back', action: 'nav.dashboard' });
  const kb = new InlineKeyboard().text(back.text, back.callback_data);
  await renderScreen(ctx, { titleKey: 'Reportcar', bodyLines: ['Reportcar will be available soon.'], inlineKeyboard: kb });
};

const renderTasks = async (ctx: Context): Promise<void> => {
  const back = await makeActionButton(ctx, { label: '⬅️ Back', action: 'nav.dashboard' });
  const kb = new InlineKeyboard().text(back.text, back.callback_data);
  await renderScreen(ctx, { titleKey: 'Tasks / Routines', bodyLines: ['Tasks and routines will be available soon.'], inlineKeyboard: kb });
};

const renderTodo = async (ctx: Context): Promise<void> => {
  const back = await makeActionButton(ctx, { label: '⬅️ Back', action: 'nav.dashboard' });
  const kb = new InlineKeyboard().text(back.text, back.callback_data);
  await renderScreen(ctx, { titleKey: 'To-Do List', bodyLines: ['To-Do List will be available soon.'], inlineKeyboard: kb });
};

const renderPlanning = async (ctx: Context): Promise<void> => {
  const back = await makeActionButton(ctx, { label: '⬅️ Back', action: 'nav.dashboard' });
  const kb = new InlineKeyboard().text(back.text, back.callback_data);
  await renderScreen(ctx, { titleKey: 'Planning', bodyLines: ['Planning will be available soon.'], inlineKeyboard: kb });
};

const renderMyDay = async (ctx: Context): Promise<void> => {
  const back = await makeActionButton(ctx, { label: '⬅️ Back', action: 'nav.dashboard' });
  const kb = new InlineKeyboard().text(back.text, back.callback_data);
  await renderScreen(ctx, { titleKey: 'My Day', bodyLines: ['My Day will be available soon.'], inlineKeyboard: kb });
};

const renderFreeText = async (ctx: Context): Promise<void> => {
  const back = await makeActionButton(ctx, { label: '⬅️ Back', action: 'nav.dashboard' });
  const kb = new InlineKeyboard().text(back.text, back.callback_data);
  await renderScreen(ctx, { titleKey: 'Free Text', bodyLines: ['Free Text capture will be available soon.'], inlineKeyboard: kb });
};

const renderReminders = async (ctx: Context): Promise<void> => {
  const back = await makeActionButton(ctx, { label: '⬅️ Back', action: 'nav.dashboard' });
  const kb = new InlineKeyboard().text(back.text, back.callback_data);
  await renderScreen(ctx, { titleKey: 'Reminders', bodyLines: ['Reminders will be available soon.'], inlineKeyboard: kb });
};

const renderCalendarEvents = async (ctx: Context): Promise<void> => {
  const back = await makeActionButton(ctx, { label: '⬅️ Back', action: 'nav.dashboard' });
  const kb = new InlineKeyboard().text(back.text, back.callback_data);
  await renderScreen(ctx, { titleKey: 'Calendar & Events', bodyLines: ['Calendar & Events will be available soon.'], inlineKeyboard: kb });
};

const renderAI = async (ctx: Context): Promise<void> => {
  const back = await makeActionButton(ctx, { label: '⬅️ Back', action: 'nav.dashboard' });
  const kb = new InlineKeyboard().text(back.text, back.callback_data);
  await renderScreen(ctx, { titleKey: 'AI', bodyLines: ['AI features will be available soon.'], inlineKeyboard: kb });
};

const parseTimeHhmm = (input: string): { hhmm: string; minutes: number } | null => {
  const trimmed = input.trim();
  const parts = trimmed.split(':');
  if (parts.length !== 2) return null;
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23) return null;
  if (minutes < 0 || minutes > 59) return null;
  const hh = hours.toString().padStart(2, '0');
  const mm = minutes.toString().padStart(2, '0');
  const total = hours * 60 + minutes;
  return { hhmm: `${hh}:${mm}`, minutes: total };
};

const parseDurationMinutes = (input: string): number | null => {
  const trimmed = input.trim();
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  if (n <= 0) return null;
  return n;
};

const timeDraftToDisplay = (draft: { hour12: number; minuteTens: number; minuteOnes: number; ampm: 'AM' | 'PM' }): { hhmm24: string; label: string } => {
  const hour12 = Math.min(12, Math.max(1, draft.hour12));
  const mt = Math.min(5, Math.max(0, draft.minuteTens));
  const mo = Math.min(9, Math.max(0, draft.minuteOnes));
  const minutes = mt * 10 + mo;

  let hour24: number;
  if (draft.ampm === 'AM') {
    hour24 = hour12 % 12;
  } else {
    hour24 = (hour12 % 12) + 12;
  }

  const HH = hour24.toString().padStart(2, '0');
  const MM = minutes.toString().padStart(2, '0');

  const hhmm24 = `${HH}:${MM}`;
  const hh12 = hour12.toString().padStart(2, '0');
  const label = `${hh12}:${MM} ${draft.ampm}`;
  return { hhmm24, label };
};

const renderTimePicker = async (
  ctx: Context,
  reportDayId: string,
  item: ReportItemRow,
  draft: { hour12: number; minuteTens: number; minuteOnes: number; ampm: 'AM' | 'PM' }
): Promise<void> => {
  const { label: timeLabel } = timeDraftToDisplay(draft);

  const lines = [
    t('screens.daily_report.time_title', { label: item.label }),
    t('screens.daily_report.time_current', { value: timeLabel }),
    t('screens.daily_report.time_hint')
  ];

  const kb = new InlineKeyboard();

  const hourRows = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12]
  ];
  for (const row of hourRows) {
    for (const h of row) {
      const btn = await makeActionButton(ctx, {
        label: h.toString(),
        action: 'dr.time_set_hour',
        data: { reportDayId, itemId: item.id, hour12: h }
      });
      kb.text(btn.text, btn.callback_data);
    }
    kb.row();
  }

  for (let mt = 0; mt <= 5; mt++) {
    const btn = await makeActionButton(ctx, {
      label: `${mt}0`,
      action: 'dr.time_set_mtens',
      data: { reportDayId, itemId: item.id, minuteTens: mt }
    });
    kb.text(btn.text, btn.callback_data);
  }
  kb.row();

  for (let mo = 0; mo <= 9; mo++) {
    const btn = await makeActionButton(ctx, {
      label: mo.toString(),
      action: 'dr.time_set_mones',
      data: { reportDayId, itemId: item.id, minuteOnes: mo }
    });
    kb.text(btn.text, btn.callback_data);
  }
  kb.row();

  const amBtn = await makeActionButton(ctx, { label: 'AM', action: 'dr.time_set_ampm', data: { reportDayId, itemId: item.id, ampm: 'AM' as const } });
  const pmBtn = await makeActionButton(ctx, { label: 'PM', action: 'dr.time_set_ampm', data: { reportDayId, itemId: item.id, ampm: 'PM' as const } });
  kb.text(amBtn.text, amBtn.callback_data).text(pmBtn.text, pmBtn.callback_data);
  kb.row();

  const saveBtn = await makeActionButton(ctx, { label: t('screens.daily_report.time_save'), action: 'dr.time_save', data: { reportDayId, itemId: item.id } });
  const skipBtn = await makeActionButton(ctx, { label: t('screens.daily_report.numeric_skip'), action: 'dr.skip', data: { reportDayId, itemId: item.id } });
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'dr.back' });

  kb.text(saveBtn.text, saveBtn.callback_data).row();
  kb.text(skipBtn.text, skipBtn.callback_data).text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, {
    titleKey: 'Daily Report',
    bodyLines: lines,
    inlineKeyboard: kb
  });
};

const renderNumericInput = async (ctx: Context, reportDayId: string, item: ReportItemRow, value: number): Promise<void> => {
  const lines = [
    t('screens.daily_report.numeric_title', { label: item.label }),
    t('screens.daily_report.numeric_current', { value }),
    t('screens.daily_report.numeric_hint')
  ];

  const kb = new InlineKeyboard();

  const deltasRow1 = [-15, -5, 5, 15];
  for (const delta of deltasRow1) {
    const btn = await makeActionButton(ctx, {
      label: delta > 0 ? `+${delta}` : `${delta}`,
      action: 'dr.num_delta',
      data: { reportDayId, itemId: item.id, delta }
    });
    kb.text(btn.text, btn.callback_data);
  }
  kb.row();

  const deltasRow2 = [30, 60];
  for (const delta of deltasRow2) {
    const btn = await makeActionButton(ctx, {
      label: `+${delta}`,
      action: 'dr.num_delta',
      data: { reportDayId, itemId: item.id, delta }
    });
    kb.text(btn.text, btn.callback_data);
  }
  kb.row();

  const saveBtn = await makeActionButton(ctx, {
    label: t('screens.daily_report.numeric_save'),
    action: 'dr.num_save',
    data: { reportDayId, itemId: item.id }
  });
  const skipBtn = await makeActionButton(ctx, { label: t('screens.daily_report.numeric_skip'), action: 'dr.skip', data: { reportDayId, itemId: item.id } });
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'dr.back' });

  kb.text(saveBtn.text, saveBtn.callback_data).row();
  kb.text(skipBtn.text, skipBtn.callback_data).text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, {
    titleKey: 'Daily Report',
    bodyLines: lines,
    inlineKeyboard: kb
  });
};

const promptForItem = async (ctx: Context, reportDay: ReportDayRow, item: ReportItemRow) => {
  const telegramId = String(ctx.from?.id ?? '');
  const existing = userStates.get(telegramId) ?? {};

  if (reportDay.locked) {
    await renderLockedDayInfo(ctx, reportDay);
    return;
  }

  if (item.item_type === 'time_hhmm') {
    const initialDraft = { reportDayId: reportDay.id, itemId: item.id, hour12: 10, minuteTens: 0, minuteOnes: 0, ampm: 'PM' as const };
    userStates.set(telegramId, {
      ...existing,
      awaitingValue: { reportDayId: reportDay.id, itemId: item.id },
      timeDraft: initialDraft
    });
    await renderTimePicker(ctx, reportDay.id, item, initialDraft);
    return;
  }

  if (item.item_type === 'number' || item.item_type === 'duration_minutes') {
    const draftValue = 0;
    userStates.set(telegramId, {
      ...existing,
      awaitingValue: { reportDayId: reportDay.id, itemId: item.id },
      numericDraft: { reportDayId: reportDay.id, itemId: item.id, value: draftValue }
    });
    await renderNumericInput(ctx, reportDay.id, item, draftValue);
    return;
  }

  userStates.set(telegramId, { ...existing, awaitingValue: { reportDayId: reportDay.id, itemId: item.id } });
  const skipBtn = await makeActionButton(ctx, { label: '⏭ Skip', action: 'dr.skip', data: { reportDayId: reportDay.id, itemId: item.id } });
  const cancelBtn = await makeActionButton(ctx, { label: '⬅️ Cancel', action: 'dr.menu' });
  const kb = new InlineKeyboard().text(skipBtn.text, skipBtn.callback_data).row().text(cancelBtn.text, cancelBtn.callback_data);
  await renderScreen(ctx, { titleKey: 'Daily Report', bodyLines: [`Set value for: ${item.label}`, 'Send the value as text.'], inlineKeyboard: kb });
};

const renderNextItem = async (ctx: Context): Promise<void> => {
  const { reportDay, items } = await ensureReportContext(ctx);
  if (reportDay.locked) {
    await renderLockedDayInfo(ctx, reportDay);
    return;
  }
  const statuses = await listCompletionStatus(reportDay.id, items);
  const next = statuses.find((s) => !s.filled && !s.skipped);
  if (!next) {
    const kb = await buildDailyReportKeyboard(ctx, reportDay.id);
    await renderScreen(ctx, { titleKey: t('screens.daily_report.title'), bodyLines: [t('screens.daily_report.all_done')], inlineKeyboard: kb });
    return;
  }
  await promptForItem(ctx, reportDay, next.item);
};

const renderDailyReportRoot = async (ctx: Context): Promise<void> => {
  const { reportDay, items } = await ensureReportContext(ctx);
  const statuses = await listCompletionStatus(reportDay.id, items);
  const completed = statuses.filter((s) => s.filled).length;
  const total = statuses.length;
  const template = (await getTemplateById(reportDay.template_id)) ?? (await ensureDefaultTemplate(reportDay.user_id));
  const templateName = template.title ?? 'Default Template';
  const yesterdayStatus = await loadYesterdayStatus(ctx);

  const bodyLines = [
    t('screens.daily_report.root_header', { date: reportDay.local_date }),
    t('screens.daily_report.template_line', { template: templateName }),
    t('screens.daily_report.completion_line', { completed, total }),
    ''
  ];
  if (reportDay.locked) {
    bodyLines.push(t('screens.daily_report.today_locked_flag'), '');
  }

  const statusBtn = await makeActionButton(ctx, { label: t('buttons.dr_today_status'), action: 'dr.status' });
  const templatesBtn = await makeActionButton(ctx, { label: t('buttons.dr_templates'), action: 'dr.templates' });
  const historyBtn = await makeActionButton(ctx, { label: t('buttons.dr_history'), action: 'dr.history' });
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'dr.back' });
  const kb = new InlineKeyboard();

  kb.text(statusBtn.text, statusBtn.callback_data).row();

  if (!reportDay.locked) {
    const nextBtn = await makeActionButton(ctx, { label: t('buttons.dr_fill_next'), action: 'dr.next' });
    const pickBtn = await makeActionButton(ctx, { label: t('buttons.dr_fill_specific'), action: 'dr.pick_item' });
    kb.text(nextBtn.text, nextBtn.callback_data).row();
    kb.text(pickBtn.text, pickBtn.callback_data).row();
  }

  kb.text(templatesBtn.text, templatesBtn.callback_data).row();
  kb.text(historyBtn.text, historyBtn.callback_data).row();

  if (yesterdayStatus.hasOpen) {
    const catchupBtn = await makeActionButton(ctx, { label: t('buttons.dr_yesterday_catchup'), action: 'dr.yesterday_menu' });
    kb.text(catchupBtn.text, catchupBtn.callback_data).row();
  }

  if (!reportDay.locked) {
    const lockBtn = await makeActionButton(ctx, { label: t('buttons.dr_lock'), action: 'dr.lock' });
    kb.text(lockBtn.text, lockBtn.callback_data).row();
  } else {
    const unlockBtn = await makeActionButton(ctx, { label: t('buttons.dr_unlock'), action: 'dr.unlock' });
    kb.text(unlockBtn.text, unlockBtn.callback_data).row();
  }

  kb.text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, { titleKey: t('screens.daily_report.title'), bodyLines, inlineKeyboard: kb });
};

const renderTemplatesScreen = async (ctx: Context): Promise<void> => {
  const { user, settings } = await ensureUserAndSettings(ctx);
  await ensureDefaultTemplate(user.id);
  const templates = await listUserTemplates(user.id);
  const activeTemplateId = (settings.settings_json as { active_template_id?: string } | null)?.active_template_id ?? templates[0]?.id ?? null;

  const lines: string[] = [t('screens.daily_report.templates_title'), ''];
  if (!templates.length) {
    lines.push('No templates found.');
  } else {
    templates.forEach((tpl) => {
      const prefix = tpl.id === activeTemplateId ? '⭐' : '•';
      lines.push(`${prefix} ${tpl.title} (${tpl.itemCount} items)`);
    });
  }

  const kb = new InlineKeyboard();
  for (const tpl of templates) {
    const setActiveBtn = await makeActionButton(ctx, { label: 'Set Active', action: 'dr.template_set_active', data: { templateId: tpl.id } });
    const detailsBtn = await makeActionButton(ctx, { label: 'Details', action: 'dr.template_details', data: { templateId: tpl.id } });
    kb.text(setActiveBtn.text, setActiveBtn.callback_data).text(detailsBtn.text, detailsBtn.callback_data).row();
  }

  const newBtn = await makeActionButton(ctx, { label: '➕ New Template', action: 'dr.template_new' });
  const backBtn = await makeActionButton(ctx, { label: '⬅️ Back', action: 'dr.menu' });
  kb.text(newBtn.text, newBtn.callback_data).row().text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, {
    titleKey: t('screens.daily_report.title'),
    bodyLines: lines,
    inlineKeyboard: kb
  });
};

const renderTemplateDetails = async (ctx: Context, templateId: string): Promise<void> => {
  const { user } = await ensureUserAndSettings(ctx);
  const template = await getTemplateById(templateId);
  if (!template || template.user_id !== user.id) {
    await renderTemplatesScreen(ctx);
    return;
  }
  const items = await listItems(template.id);
  const lines = [template.title, `${items.length} items`];
  const preview = items.slice(0, 5);
  if (preview.length) {
    lines.push('', ...preview.map((i) => `• ${i.label}`));
  }

  const duplicateBtn = await makeActionButton(ctx, { label: '✏️ Duplicate', action: 'dr.template_duplicate', data: { templateId } });
  const deleteBtn = await makeActionButton(ctx, { label: '🗑 Delete', action: 'dr.template_delete_confirm', data: { templateId } });
  const backBtn = await makeActionButton(ctx, { label: '⬅️ Back', action: 'dr.templates' });

  const kb = new InlineKeyboard().text(duplicateBtn.text, duplicateBtn.callback_data).row().text(deleteBtn.text, deleteBtn.callback_data).row().text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, {
    titleKey: t('screens.daily_report.title'),
    bodyLines: lines,
    inlineKeyboard: kb
  });
};

const renderHistory = async (ctx: Context, range: '7d' | '30d' = '7d'): Promise<void> => {
  const { user } = await ensureUserAndSettings(ctx);
  const days = await listRecentReportDays({ userId: user.id, range });

  const lines: string[] = [t('screens.daily_report.history_title'), t('screens.daily_report.history_range', { range: range === '7d' ? '7 days' : '30 days' }), ''];
  if (!days.length) {
    lines.push('No reports found in this range.');
  } else {
    days.forEach((entry) => {
      let icon = '⚠️';
      if (entry.total > 0 && entry.completed === entry.total) icon = '✅';
      else if (entry.completed === 0) icon = '⬜️';
      lines.push(`${icon} ${entry.day.local_date} — ${entry.completed}/${entry.total}`);
    });
  }

  const kb = new InlineKeyboard();
  const last7 = await makeActionButton(ctx, { label: 'Last 7 days', action: 'dr.history', data: { range: '7d' as const } });
  const last30 = await makeActionButton(ctx, { label: 'Last 30 days', action: 'dr.history', data: { range: '30d' as const } });
  kb.text(last7.text, last7.callback_data).text(last30.text, last30.callback_data).row();

  for (const entry of days) {
    const labelIcon = entry.total > 0 && entry.completed === entry.total ? '✅' : entry.completed === 0 ? '⬜️' : '⚠️';
    const btn = await makeActionButton(ctx, {
      label: `${labelIcon} ${entry.day.local_date} — ${entry.completed}/${entry.total}`,
      action: 'dr.history_day',
      data: { reportDayId: entry.day.id, range }
    });
    kb.text(btn.text, btn.callback_data).row();
  }

  const backBtn = await makeActionButton(ctx, { label: '⬅️ Back', action: 'dr.menu' });
  kb.text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, {
    titleKey: t('screens.daily_report.title'),
    bodyLines: lines,
    inlineKeyboard: kb
  });
};

const renderHistoryDay = async (ctx: Context, reportDayId: string, range: '7d' | '30d' = '7d'): Promise<void> => {
  const { user } = await ensureUserAndSettings(ctx);
  const reportDay = await getReportDayById(reportDayId);
  if (!reportDay || reportDay.user_id !== user.id) {
    await renderHistory(ctx, range);
    return;
  }
  const items = await listItems(reportDay.template_id);
  const statuses = await listCompletionStatus(reportDay.id, items);
  const completed = statuses.filter((s) => s.filled).length;
  const lines: string[] = [reportDay.local_date, `Completion: ${completed}/${statuses.length}`, ''];
  statuses.forEach((status) => {
    const icon = status.filled ? '✅' : status.skipped ? '⏭' : '⬜️';
    lines.push(`${icon} ${status.item.label}`);
  });

  const exportBtn = await makeActionButton(ctx, { label: '📤 Export (coming soon)', action: 'noop' });
  const backHistoryBtn = await makeActionButton(ctx, { label: '⬅️ Back to history', action: 'dr.history', data: { range } });
  const backBtn = await makeActionButton(ctx, { label: '⬅️ Back', action: 'dr.menu' });

  const kb = new InlineKeyboard()
    .text(exportBtn.text, exportBtn.callback_data)
    .row()
    .text(backHistoryBtn.text, backHistoryBtn.callback_data)
    .row()
    .text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, {
    titleKey: t('screens.daily_report.title'),
    bodyLines: lines,
    inlineKeyboard: kb
  });
};

const renderYesterdayMenu = async (ctx: Context): Promise<void> => {
  const status = await loadYesterdayStatus(ctx);
  if (!status.reportDay || !status.statuses || !status.hasOpen || status.reportDay.locked) {
    await renderDailyReportRoot(ctx);
    return;
  }
  const completed = status.statuses.filter((s) => s.filled).length;
  const skipped = status.statuses.filter((s) => s.skipped).length;
  const open = status.statuses.filter((s) => !s.filled && !s.skipped).length;

  const lines = [
    t('screens.daily_report.yesterday_title', { date: status.reportDay.local_date }),
    `Completed: ${completed}`,
    `Skipped: ${skipped}`,
    `Open: ${open}`,
    '',
    'You can fill remaining items or skip them all to close yesterday.'
  ];

  const fillBtn = await makeActionButton(ctx, { label: 'Fill remaining items', action: 'dr.yesterday_next' });
  const skipBtn = await makeActionButton(ctx, { label: 'Skip remaining & close yesterday', action: 'dr.yesterday_skip_all' });
  const backBtn = await makeActionButton(ctx, { label: '⬅️ Back', action: 'dr.back' });

  const kb = new InlineKeyboard().text(fillBtn.text, fillBtn.callback_data).row().text(skipBtn.text, skipBtn.callback_data).row().text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, {
    titleKey: t('screens.daily_report.title'),
    bodyLines: lines,
    inlineKeyboard: kb
  });
};

const renderDailyStatusWithFilter = async (ctx: Context, filter: 'all' | 'not_filled' | 'filled' = 'all'): Promise<void> => {
  const { reportDay, items } = await ensureReportContext(ctx);
  const statuses = await listCompletionStatus(reportDay.id, items);

  let filtered = statuses;
  if (filter === 'not_filled') filtered = statuses.filter((s) => !s.filled);
  if (filter === 'filled') filtered = statuses.filter((s) => s.filled);

  const lines: string[] = [];
  lines.push(t('screens.daily_report.root_header', { date: reportDay.local_date }), t('screens.daily_report.status_header'));

  if (filtered.length === 0) {
    lines.push(t('screens.daily_report.all_done'));
  } else {
    filtered.forEach((s, idx) => {
      const icon = s.filled ? '✅' : s.skipped ? '⏭' : '⬜️';
      lines.push(`${icon} ${idx + 1}) ${s.item.label}`);
    });
  }

  const kb = new InlineKeyboard();

  const allBtn = await makeActionButton(ctx, { label: t('screens.daily_report.filter_all'), action: 'dr.status', data: { filter: 'all' } });
  const notFilledBtn = await makeActionButton(ctx, { label: t('screens.daily_report.filter_not_filled'), action: 'dr.status', data: { filter: 'not_filled' } });
  const filledBtn = await makeActionButton(ctx, { label: t('screens.daily_report.filter_filled'), action: 'dr.status', data: { filter: 'filled' } });

  kb.text(allBtn.text, allBtn.callback_data).text(notFilledBtn.text, notFilledBtn.callback_data).text(filledBtn.text, filledBtn.callback_data).row();

  for (const status of filtered) {
    const itemBtn = await makeActionButton(ctx, {
      label: `${status.filled ? '✅' : status.skipped ? '⏭' : '⬜️'} ${status.item.label}`,
      action: 'dr.item',
      data: { itemId: status.item.id }
    });
    kb.text(itemBtn.text, itemBtn.callback_data).row();
  }

  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'dr.back' });
  kb.text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, {
    titleKey: t('screens.daily_report.title'),
    bodyLines: lines,
    inlineKeyboard: kb
  });
};

const renderLockedDayInfo = async (ctx: Context, reportDay: ReportDayRow): Promise<void> => {
  const telegramId = String(ctx.from?.id ?? '');
  if (telegramId) {
    userStates.delete(telegramId);
  }
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'dr.back' });
  const kb = new InlineKeyboard().text(backBtn.text, backBtn.callback_data);
  await renderScreen(ctx, {
    titleKey: t('screens.daily_report.title'),
    bodyLines: [t('screens.daily_report.locked_info')],
    inlineKeyboard: kb
  });
};

const handleSaveValue = async (ctx: Context, text: string): Promise<void> => {
  if (!ctx.from) return;
  const userId = String(ctx.from.id);
  const state = userStates.get(userId);
  if (!state?.awaitingValue) return;

  const { reportDayId, itemId } = state.awaitingValue;
  let context;
  try {
    context = await ensureReportContext(ctx, { reportDayId });
  } catch {
    userStates.delete(userId);
    await renderDailyReportRoot(ctx);
    return;
  }
  const { reportDay, items } = context;
  if (reportDay.locked) {
    await renderLockedDayInfo(ctx, reportDay);
    return;
  }

  if (reportDay.id !== reportDayId) {
    userStates.delete(userId);
    await renderScreen(ctx, {
      titleKey: t('screens.daily_report.title'),
      bodyLines: [t('screens.daily_report.session_expired')],
      inlineKeyboard: await buildDailyReportKeyboard(ctx, reportDay.id)
    });
    return;
  }

  const item = items.find((i) => i.id === itemId);
  if (!item) {
    userStates.delete(userId);
    await renderScreen(ctx, {
      titleKey: t('screens.daily_report.title'),
      bodyLines: [t('screens.daily_report.item_not_found')],
      inlineKeyboard: await buildDailyReportKeyboard(ctx, reportDay.id)
    });
    return;
  }

  let valueJson: Record<string, unknown> | null = null;

  switch (item.item_type) {
    case 'time_hhmm': {
      const parsed = parseTimeHhmm(text);
      if (!parsed) {
        await renderScreen(ctx, {
          titleKey: t('screens.daily_report.title'),
          bodyLines: [t('screens.daily_report.invalid_time')],
          inlineKeyboard: await buildDailyReportKeyboard(ctx, reportDay.id)
        });
        return;
      }
      valueJson = { value: parsed.hhmm, minutes: parsed.minutes };
      break;
    }

    case 'duration_minutes': {
      const mins = parseDurationMinutes(text);
      if (mins === null) {
        await renderScreen(ctx, {
          titleKey: t('screens.daily_report.title'),
          bodyLines: [t('screens.daily_report.invalid_duration')],
          inlineKeyboard: await buildDailyReportKeyboard(ctx, reportDay.id)
        });
        return;
      }
      valueJson = { value: mins, minutes: mins };
      break;
    }

    case 'number': {
      const n = Number(text.trim());
      if (!Number.isFinite(n)) {
        await renderScreen(ctx, {
          titleKey: t('screens.daily_report.title'),
          bodyLines: [t('screens.daily_report.invalid_number')],
          inlineKeyboard: await buildDailyReportKeyboard(ctx, reportDay.id)
        });
        return;
      }
      valueJson = { value: n, minutes: n };
      break;
    }

    default:
      valueJson = { value: text };
  }

  try {
    await saveValue({ reportDayId, item, valueJson, userId: reportDay.user_id });
  } catch (error) {
    console.error({
      scope: 'daily_report',
      event: 'save_value_failed',
      error,
      reportDayId,
      itemId: item.id,
      valueJson
    });

    await renderScreen(ctx, {
      titleKey: t('screens.daily_report.title'),
      bodyLines: [t('screens.daily_report.save_failed')],
      inlineKeyboard: await buildDailyReportKeyboard(ctx, reportDay.id)
    });

    return;
  }

  const userSettings = (await ensureUserAndSettings(ctx)).user.settings_json as Record<string, unknown>;
  await logForUser({
    userId: reportDay.user_id,
    ctx,
    eventName: 'db_write',
    payload: { action: 'save_value', item_id: item.id },
    enabled: telemetryEnabledForUser(userSettings)
  });

  userStates.delete(userId);
  await renderScreen(ctx, {
    titleKey: t('screens.daily_report.title'),
    bodyLines: [t('screens.daily_report.saved')],
    inlineKeyboard: await buildDailyReportKeyboard(ctx, reportDayId)
  });
  await renderDailyStatusWithFilter(ctx, 'all');
};

const renderSettingsRoot = async (ctx: Context): Promise<void> => {
  const speedBtn = await makeActionButton(ctx, { label: '⚡ Speed / Ping Test', action: 'settings.speed_test' });
  const backBtn = await makeActionButton(ctx, { label: '⬅️ Back', action: 'nav.dashboard' });
  const kb = new InlineKeyboard().text(speedBtn.text, speedBtn.callback_data).row().text(backBtn.text, backBtn.callback_data);
  await renderScreen(ctx, { titleKey: 'Settings', bodyLines: ['Choose an option:'], inlineKeyboard: kb });
};

// ===== Handlers =====

bot.command('start', async (ctx: Context) => {
  await renderDashboard(ctx);
});

bot.command('home', async (ctx: Context) => {
  await renderDashboard(ctx);
});

bot.command('debug_inline', async (ctx: Context) => {
  const keyboard = new InlineKeyboard().text('Test button', 'dbg:test');
  await ctx.reply('Inline debug screen', { reply_markup: keyboard });
});

bot.command('test_screen', async (ctx: Context) => {
  const kb = new InlineKeyboard().text('Test via renderScreen', 'dbg:rs');
  await renderScreen(ctx, {
    titleKey: 'Test',
    bodyLines: ['This is a test rendered via renderScreen.'],
    inlineKeyboard: kb
  });
});

bot.callbackQuery('dbg:test', async (ctx) => {
  await safeAnswerCallback(ctx, { text: 'Inline is working!' });
});

bot.callbackQuery('dbg:rs', async (ctx) => {
  await safeAnswerCallback(ctx, { text: 'renderScreen inline works', show_alert: false });
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
bot.hears('🎁 Reward Center', renderRewardCenter);
bot.hears('📊 Reports', renderReportsMenu);
bot.hears('📅 Calendar & Events', renderCalendarEvents);
bot.hears('⚙️ Settings', async (ctx: Context) => {
  await renderSettingsRoot(ctx);
});
bot.hears('🤖 AI', renderAI);
bot.on('message:text', async (ctx: Context) => {
  const telegramId = String(ctx.from?.id ?? '');
  const state = userStates.get(telegramId);
  const messageText = ctx.message?.text;
  if (state?.rewardEdit) {
    await handleRewardEditText(ctx, state.rewardEdit);
    return;
  }
  if (state?.awaitingValue) {
    if (!messageText) return;
    await handleSaveValue(ctx, messageText);
  }
});
bot.callbackQuery(/^[A-Za-z0-9_-]{8,12}$/, async (ctx) => {
  await safeAnswerCallback(ctx);

  const traceId = getTraceId(ctx);
  try {
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

      // ===== Navigation =====
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
      case 'nav.reports':
        await renderReportsMenu(ctx);
        break;
      case 'nav.settings':
        await renderSettingsRoot(ctx);
        break;

      // ===== Reports =====
      case 'reports.xp':
        await renderXpSummary(ctx);
        break;
      case 'reports.sleep':
      case 'reports.study':
      case 'reports.tasks':
      case 'reports.chart': {
        const kind = action.split('.')[1];
        await renderScreen(ctx, {
          titleKey: 'Reports',
          bodyLines: [`${kind} report: Coming soon.`],
          inlineKeyboard: await buildReportsMenuKeyboard(ctx)
        });
        break;
      }

      // ===== Rewards: Buy flow =====
      case 'rewards.buy':
        await renderRewardBuyList(ctx);
        break;

      // ===== Rewards: Edit Store root =====
      case 'rewards.edit':
      case 'rewards.edit_root':
        await renderRewardStoreEditorRoot(ctx);
        break;

      case 'rewards.add': {
        const telegramId = String(ctx.from?.id ?? '');
        userStates.set(telegramId, {
          ...(userStates.get(telegramId) || {}),
          rewardEdit: { mode: 'create', step: 'title', draft: {} }
        });
        await renderCreateRewardTitlePrompt(ctx);
        break;
      }

      case 'rewards.edit_open': {
        const rewardId = (payload as { data?: { rewardId?: string } }).data?.rewardId;
        if (!rewardId) {
          await renderRewardStoreEditorRoot(ctx);
          return;
        }
        const reward = await getRewardForUser(rewardId, user.id);
        if (!reward) {
          await renderRewardStoreEditorRoot(ctx);
          return;
        }
        await renderRewardEditMenu(ctx, reward);
        break;
      }

      case 'rewards.edit_title': {
        const rewardId = (payload as { data?: { rewardId?: string } }).data?.rewardId;
        if (!rewardId) {
          await renderRewardStoreEditorRoot(ctx);
          return;
        }
        const reward = await getRewardForUser(rewardId, user.id);
        if (!reward) {
          await renderRewardStoreEditorRoot(ctx);
          return;
        }
        const telegramId = String(ctx.from?.id ?? '');
        userStates.set(telegramId, {
          ...(userStates.get(telegramId) || {}),
          rewardEdit: { mode: 'edit', rewardId, step: 'title', draft: {} }
        });
        await renderEditRewardTitlePrompt(ctx, rewardId);
        break;
      }

      case 'rewards.edit_description': {
        const rewardId = (payload as { data?: { rewardId?: string } }).data?.rewardId;
        if (!rewardId) {
          await renderRewardStoreEditorRoot(ctx);
          return;
        }
        const reward = await getRewardForUser(rewardId, user.id);
        if (!reward) {
          await renderRewardStoreEditorRoot(ctx);
          return;
        }
        const telegramId = String(ctx.from?.id ?? '');
        userStates.set(telegramId, {
          ...(userStates.get(telegramId) || {}),
          rewardEdit: { mode: 'edit', rewardId, step: 'description', draft: {} }
        });
        await renderEditRewardDescriptionPrompt(ctx, rewardId);
        break;
      }

      case 'rewards.edit_xp': {
        const rewardId = (payload as { data?: { rewardId?: string } }).data?.rewardId;
        if (!rewardId) {
          await renderRewardStoreEditorRoot(ctx);
          return;
        }
        const reward = await getRewardForUser(rewardId, user.id);
        if (!reward) {
          await renderRewardStoreEditorRoot(ctx);
          return;
        }
        const telegramId = String(ctx.from?.id ?? '');
        userStates.set(telegramId, {
          ...(userStates.get(telegramId) || {}),
          rewardEdit: { mode: 'edit', rewardId, step: 'xp', draft: {} }
        });
        await renderEditRewardXpPrompt(ctx, rewardId);
        break;
      }

      case 'rewards.toggle_active': {
        const rewardId = (payload as { data?: { rewardId?: string } }).data?.rewardId;
        if (!rewardId) {
          await renderRewardStoreEditorRoot(ctx);
          return;
        }
        const reward = await getRewardForUser(rewardId, user.id);
        if (!reward) {
          await renderRewardStoreEditorRoot(ctx);
          return;
        }
        const updated = await updateReward({ rewardId, patch: { isActive: !reward.is_active } });
        await renderRewardEditMenu(ctx, updated);
        break;
      }

      case 'rewards.delete': {
        const rewardId = (payload as { data?: { rewardId?: string } }).data?.rewardId;
        if (!rewardId) {
          await renderRewardStoreEditorRoot(ctx);
          return;
        }
        const reward = await getRewardForUser(rewardId, user.id);
        if (!reward) {
          await renderRewardStoreEditorRoot(ctx);
          return;
        }
        const telegramId = String(ctx.from?.id ?? '');
        userStates.set(telegramId, {
          ...(userStates.get(telegramId) || {}),
          rewardEdit: { mode: 'edit', rewardId, step: 'confirm_delete', draft: {} }
        });
        const confirmBtn = await makeActionButton(ctx, { label: '✅ Yes, delete', action: 'rewards.delete_confirm', data: { rewardId } });
        const cancelBtn = await makeActionButton(ctx, { label: '⬅️ Cancel', action: 'rewards.edit_open', data: { rewardId } });
        const kb = new InlineKeyboard().text(confirmBtn.text, confirmBtn.callback_data).row().text(cancelBtn.text, cancelBtn.callback_data);
        await renderScreen(ctx, {
          titleKey: 'Delete Reward',
          bodyLines: [`Are you sure you want to delete "${reward.title}"?`],
          inlineKeyboard: kb
        });
        break;
      }

      case 'rewards.delete_confirm': {
        const rewardId = (payload as { data?: { rewardId?: string } }).data?.rewardId;
        if (!rewardId) {
          await renderRewardStoreEditorRoot(ctx);
          return;
        }
        const reward = await getRewardForUser(rewardId, user.id);
        if (!reward) {
          await renderRewardStoreEditorRoot(ctx);
          return;
        }
        await deleteReward(rewardId);
        const telegramId = String(ctx.from?.id ?? '');
        const state = userStates.get(telegramId);
        if (state) {
          delete state.rewardEdit;
          userStates.set(telegramId, state);
        }
        await renderRewardStoreEditorRoot(ctx);
        break;
      }

      case 'rewards.confirm': {
        const rewardId = (payload as { data?: { rewardId?: string } }).data?.rewardId;
        if (!rewardId) {
          await renderRewardBuyList(ctx);
          return;
        }

        const reward = await getRewardById(rewardId);
        if (!reward) {
          const kb = await buildRewardCenterKeyboard(ctx);
          await renderScreen(ctx, {
            titleKey: '🎁 Reward Center',
            bodyLines: ['Reward not found.'],
            inlineKeyboard: kb
          });
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

      // ===== Daily Report: status & navigation =====
      case 'dr.status': {
        const filter = (payload as { data?: { filter?: 'all' | 'not_filled' | 'filled' } }).data?.filter ?? 'all';
        await renderDailyStatusWithFilter(ctx, filter);
        break;
      }
      case 'dr.next':
        await renderNextItem(ctx);
        break;
      case 'dr.pick_item':
        await renderDailyStatusWithFilter(ctx, 'all');
        break;

      case 'dr.item': {
        const itemId = (payload as { data?: { itemId?: string } }).data?.itemId;
        if (!itemId) {
          await ctx.answerCallbackQuery({ text: 'Item not found', show_alert: true });
          return;
        }
        const { reportDay, items } = await ensureReportContext(ctx);
        if (reportDay.locked) {
          await renderLockedDayInfo(ctx, reportDay);
          return;
        }
        const item = items.find((i) => i.id === itemId);
        if (!item) {
          await ctx.answerCallbackQuery({ text: 'Item not found', show_alert: true });
          return;
        }
        await promptForItem(ctx, reportDay, item);
        break;
      }

      // ===== Time picker callbacks =====
      case 'dr.time_set_hour': {
        const data = (payload as { data?: { reportDayId?: string; itemId?: string; hour12?: number } }).data;
        const reportDayId = data?.reportDayId;
        const itemId = data?.itemId;
        const hour12 = data?.hour12;
        if (!reportDayId || !itemId || !hour12) return;
        const { reportDay } = await ensureReportContext(ctx, { reportDayId });
        if (reportDay.id === reportDayId && reportDay.locked) {
          await renderLockedDayInfo(ctx, reportDay);
          return;
        }
        const telegramId = String(ctx.from?.id ?? '');
        const state = userStates.get(telegramId);
        const draft = state?.timeDraft;
        if (!draft || draft.reportDayId !== reportDayId || draft.itemId !== itemId) {
          await renderDailyReportRoot(ctx);
          return;
        }
        const nextDraft = { ...draft, hour12 };
        userStates.set(telegramId, { ...state, timeDraft: nextDraft });
        const { items } = await ensureReportContext(ctx, { reportDayId });
        const item = items.find((i) => i.id === itemId);
        if (!item) {
          await renderDailyReportRoot(ctx);
          return;
        }
        await renderTimePicker(ctx, reportDayId, item, nextDraft);
        break;
      }

      case 'dr.time_set_mtens': {
        const data = (payload as { data?: { reportDayId?: string; itemId?: string; minuteTens?: number } }).data;
        const reportDayId = data?.reportDayId;
        const itemId = data?.itemId;
        const minuteTens = data?.minuteTens;
        if (!reportDayId || !itemId || minuteTens === undefined) return;
        const { reportDay } = await ensureReportContext(ctx, { reportDayId });
        if (reportDay.id === reportDayId && reportDay.locked) {
          await renderLockedDayInfo(ctx, reportDay);
          return;
        }
        const telegramId = String(ctx.from?.id ?? '');
        const state = userStates.get(telegramId);
        const draft = state?.timeDraft;
        if (!draft || draft.reportDayId !== reportDayId || draft.itemId !== itemId) {
          await renderDailyReportRoot(ctx);
          return;
        }
        const nextDraft = { ...draft, minuteTens };
        userStates.set(telegramId, { ...state, timeDraft: nextDraft });
        const { items } = await ensureReportContext(ctx, { reportDayId });
        const item = items.find((i) => i.id === itemId);
        if (!item) {
          await renderDailyReportRoot(ctx);
          return;
        }
        await renderTimePicker(ctx, reportDayId, item, nextDraft);
        break;
      }

      case 'dr.time_set_mones': {
        const data = (payload as { data?: { reportDayId?: string; itemId?: string; minuteOnes?: number } }).data;
        const reportDayId = data?.reportDayId;
        const itemId = data?.itemId;
        const minuteOnes = data?.minuteOnes;
        if (!reportDayId || !itemId || minuteOnes === undefined) return;
        const { reportDay } = await ensureReportContext(ctx, { reportDayId });
        if (reportDay.id === reportDayId && reportDay.locked) {
          await renderLockedDayInfo(ctx, reportDay);
          return;
        }
        const telegramId = String(ctx.from?.id ?? '');
        const state = userStates.get(telegramId);
        const draft = state?.timeDraft;
        if (!draft || draft.reportDayId !== reportDayId || draft.itemId !== itemId) {
          await renderDailyReportRoot(ctx);
          return;
        }
        const nextDraft = { ...draft, minuteOnes };
        userStates.set(telegramId, { ...state, timeDraft: nextDraft });
        const { items } = await ensureReportContext(ctx, { reportDayId });
        const item = items.find((i) => i.id === itemId);
        if (!item) {
          await renderDailyReportRoot(ctx);
          return;
        }
        await renderTimePicker(ctx, reportDayId, item, nextDraft);
        break;
      }

      case 'dr.time_set_ampm': {
        const data = (payload as { data?: { reportDayId?: string; itemId?: string; ampm?: 'AM' | 'PM' } }).data;
        const reportDayId = data?.reportDayId;
        const itemId = data?.itemId;
        const ampm = data?.ampm;
        if (!reportDayId || !itemId || !ampm) return;
        const { reportDay } = await ensureReportContext(ctx, { reportDayId });
        if (reportDay.id === reportDayId && reportDay.locked) {
          await renderLockedDayInfo(ctx, reportDay);
          return;
        }
        const telegramId = String(ctx.from?.id ?? '');
        const state = userStates.get(telegramId);
        const draft = state?.timeDraft;
        if (!draft || draft.reportDayId !== reportDayId || draft.itemId !== itemId) {
          await renderDailyReportRoot(ctx);
          return;
        }
        const nextDraft = { ...draft, ampm };
        userStates.set(telegramId, { ...state, timeDraft: nextDraft });
        const { items } = await ensureReportContext(ctx, { reportDayId });
        const item = items.find((i) => i.id === itemId);
        if (!item) {
          await renderDailyReportRoot(ctx);
          return;
        }
        await renderTimePicker(ctx, reportDayId, item, nextDraft);
        break;
      }

      case 'dr.time_save': {
        const data = (payload as { data?: { reportDayId?: string; itemId?: string } }).data;
        const reportDayId = data?.reportDayId;
        const itemId = data?.itemId;
        if (!reportDayId || !itemId) return;
        const { reportDay } = await ensureReportContext(ctx, { reportDayId });
        if (reportDay.id === reportDayId && reportDay.locked) {
          await renderLockedDayInfo(ctx, reportDay);
          return;
        }
        const telegramId = String(ctx.from?.id ?? '');
        const state = userStates.get(telegramId);
        const draft = state?.timeDraft;
        if (!draft || draft.reportDayId !== reportDayId || draft.itemId !== itemId) {
          await renderDailyReportRoot(ctx);
          return;
        }
        const { hhmm24 } = timeDraftToDisplay(draft);
        await handleSaveValue(ctx, hhmm24);
        const updated = userStates.get(telegramId);
        if (updated) {
          delete updated.timeDraft;
          userStates.set(telegramId, updated);
        }
        break;
      }

      // ===== Numeric picker callbacks =====
      case 'dr.num_delta': {
        const data = (payload as { data?: { reportDayId?: string; itemId?: string; delta?: number } }).data;
        const reportDayId = data?.reportDayId;
        const itemId = data?.itemId;
        const delta = data?.delta ?? 0;
        if (!reportDayId || !itemId) {
          await renderDailyStatusWithFilter(ctx, 'all');
          return;
        }
        const { reportDay } = await ensureReportContext(ctx, { reportDayId });
        if (reportDay.id === reportDayId && reportDay.locked) {
          await renderLockedDayInfo(ctx, reportDay);
          return;
        }
        const telegramId = String(ctx.from?.id ?? '');
        const state = userStates.get(telegramId);
        if (!state?.numericDraft || state.numericDraft.reportDayId !== reportDayId || state.numericDraft.itemId !== itemId) {
          await renderDailyStatusWithFilter(ctx, 'all');
          return;
        }
        const current = state.numericDraft.value ?? 0;
        const next = Math.max(0, current + delta);

        userStates.set(telegramId, {
          ...state,
          numericDraft: { reportDayId, itemId, value: next }
        });

        const { items } = await ensureReportContext(ctx, { reportDayId });
        const item = items.find((i) => i.id === itemId);
        if (!item) {
          await renderDailyStatusWithFilter(ctx, 'all');
          return;
        }

        await renderNumericInput(ctx, reportDayId, item, next);
        break;
      }

      case 'dr.num_save': {
        const data = (payload as { data?: { reportDayId?: string; itemId?: string } }).data;
        const reportDayId = data?.reportDayId;
        const itemId = data?.itemId;
        if (!reportDayId || !itemId) {
          await renderDailyStatusWithFilter(ctx, 'all');
          return;
        }
        const { reportDay } = await ensureReportContext(ctx, { reportDayId });
        if (reportDay.id === reportDayId && reportDay.locked) {
          await renderLockedDayInfo(ctx, reportDay);
          return;
        }
        const telegramId = String(ctx.from?.id ?? '');
        const state = userStates.get(telegramId);
        const draft = state?.numericDraft;
        if (!draft || draft.reportDayId !== reportDayId || draft.itemId !== itemId) {
          await renderDailyStatusWithFilter(ctx, 'all');
          return;
        }

        await handleSaveValue(ctx, String(draft.value));

        const updated = userStates.get(telegramId);
        if (updated) {
          delete updated.numericDraft;
          userStates.set(telegramId, updated);
        }
        break;
      }

      case 'dr.templates':
        await renderTemplatesScreen(ctx);
        break;

      case 'dr.template_set_active': {
        const templateId = (payload as { data?: { templateId?: string } }).data?.templateId;
        if (!templateId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        const { user } = await ensureUserAndSettings(ctx);
        const template = await getTemplateById(templateId);
        if (!template || template.user_id !== user.id) {
          await renderTemplatesScreen(ctx);
          return;
        }
        await setActiveTemplate(user.id, templateId);
        clearReportContextCache();
        await renderTemplatesScreen(ctx);
        break;
      }

      case 'dr.template_details': {
        const templateId = (payload as { data?: { templateId?: string } }).data?.templateId;
        if (!templateId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        await renderTemplateDetails(ctx, templateId);
        break;
      }

      case 'dr.template_duplicate': {
        const templateId = (payload as { data?: { templateId?: string } }).data?.templateId;
        if (!templateId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        const { user } = await ensureUserAndSettings(ctx);
        await duplicateTemplate({ userId: user.id, templateId });
        await renderTemplatesScreen(ctx);
        break;
      }

      case 'dr.template_delete_confirm': {
        const templateId = (payload as { data?: { templateId?: string } }).data?.templateId;
        if (!templateId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        const { user } = await ensureUserAndSettings(ctx);
        const template = await getTemplateById(templateId);
        if (!template || template.user_id !== user.id) {
          await renderTemplatesScreen(ctx);
          return;
        }
        const confirmBtn = await makeActionButton(ctx, { label: '✅ Yes, delete', action: 'dr.template_delete', data: { templateId } });
        const cancelBtn = await makeActionButton(ctx, { label: '⬅️ Cancel', action: 'dr.template_details', data: { templateId } });
        const kb = new InlineKeyboard().text(confirmBtn.text, confirmBtn.callback_data).row().text(cancelBtn.text, cancelBtn.callback_data);
        await renderScreen(ctx, {
          titleKey: t('screens.daily_report.title'),
          bodyLines: [t('screens.daily_report.template_delete_confirm', { title: template.title })],
          inlineKeyboard: kb
        });
        break;
      }

      case 'dr.template_delete': {
        const templateId = (payload as { data?: { templateId?: string } }).data?.templateId;
        if (!templateId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        const { user, settings } = await ensureUserAndSettings(ctx);
        const templates = await listUserTemplates(user.id);
        const activeTemplateId = (settings.settings_json as { active_template_id?: string } | null)?.active_template_id ?? templates[0]?.id ?? null;

        if (templates.length <= 1 || templateId === activeTemplateId) {
          const backBtn = await makeActionButton(ctx, { label: '⬅️ Back', action: 'dr.template_details', data: { templateId } });
          await renderScreen(ctx, {
            titleKey: t('screens.daily_report.title'),
            bodyLines: ['Cannot delete the active template or the only remaining template.'],
            inlineKeyboard: new InlineKeyboard().text(backBtn.text, backBtn.callback_data)
          });
          return;
        }

        await deleteReportTemplate({ userId: user.id, templateId });
        await renderTemplatesScreen(ctx);
        break;
      }

      case 'dr.template_new': {
        const backBtn = await makeActionButton(ctx, { label: '⬅️ Back', action: 'dr.templates' });
        await renderScreen(ctx, {
          titleKey: t('screens.daily_report.title'),
          bodyLines: ['Template builder is coming soon.'],
          inlineKeyboard: new InlineKeyboard().text(backBtn.text, backBtn.callback_data)
        });
        break;
      }

      case 'dr.history': {
        const range = (payload as { data?: { range?: '7d' | '30d' } }).data?.range ?? '7d';
        await renderHistory(ctx, range);
        break;
      }

      case 'dr.history_day': {
        const reportDayId = (payload as { data?: { reportDayId?: string; range?: '7d' | '30d' } }).data?.reportDayId;
        const range = (payload as { data?: { range?: '7d' | '30d' } }).data?.range ?? '7d';
        if (!reportDayId) {
          await renderHistory(ctx, range);
          return;
        }
        await renderHistoryDay(ctx, reportDayId, range);
        break;
      }

      case 'dr.yesterday_menu': {
        await renderYesterdayMenu(ctx);
        break;
      }

      case 'dr.yesterday_next': {
        const status = await loadYesterdayStatus(ctx);
        if (!status.reportDay || !status.statuses || !status.hasOpen || status.reportDay.locked) {
          await renderDailyReportRoot(ctx);
          return;
        }
        const next = status.statuses.find((s) => !s.filled && !s.skipped);
        if (!next) {
          await autoLockIfCompleted({ reportDay: status.reportDay, items: status.items });
          clearReportContextCache(status.reportDay.id);
          await renderDailyReportRoot(ctx);
          return;
        }
        await promptForItem(ctx, status.reportDay, next.item);
        break;
      }

      case 'dr.yesterday_skip_all': {
        const status = await loadYesterdayStatus(ctx);
        if (!status.reportDay || !status.statuses || status.reportDay.locked || !status.hasOpen) {
          await renderDailyReportRoot(ctx);
          return;
        }
        for (const s of status.statuses) {
          if (!s.filled && !s.skipped) {
            await saveValue({ reportDayId: status.reportDay.id, item: s.item, valueJson: { skipped: true }, userId: status.reportDay.user_id });
          }
        }
        await autoLockIfCompleted({ reportDay: status.reportDay, items: status.items });
        clearReportContextCache(status.reportDay.id);
        try {
          await ctx.answerCallbackQuery({ text: t('screens.daily_report.yesterday_closed'), show_alert: true });
        } catch {
          // ignore
        }
        await renderDailyReportRoot(ctx);
        break;
      }

      case 'dr.lock': {
        const { reportDay } = await ensureReportContext(ctx);
        if (reportDay.locked) {
          const kb = await buildDailyReportKeyboard(ctx, reportDay.id);
          await renderScreen(ctx, {
            titleKey: t('screens.daily_report.title'),
            bodyLines: [t('screens.daily_report.already_locked')],
            inlineKeyboard: kb
          });
          return;
        }
        const confirmBtn = await makeActionButton(ctx, { label: '✅ Confirm & Lock', action: 'dr.lock_confirm', data: { reportDayId: reportDay.id } });
        const backBtn = await makeActionButton(ctx, { label: '⬅️ Back', action: 'dr.menu' });
        const kb = new InlineKeyboard().text(confirmBtn.text, confirmBtn.callback_data).row().text(backBtn.text, backBtn.callback_data);
        await renderScreen(ctx, {
          titleKey: t('screens.daily_report.title'),
          bodyLines: [t('screens.daily_report.lock_confirm_title'), t('screens.daily_report.lock_confirm_body')],
          inlineKeyboard: kb
        });
        break;
      }

      case 'dr.lock_confirm': {
        const reportDayId = (payload as { data?: { reportDayId?: string } }).data?.reportDayId;
        if (!reportDayId) {
          await renderDailyReportRoot(ctx);
          return;
        }
        const { user } = await ensureUserAndSettings(ctx);
        const reportDay = await getReportDayById(reportDayId);
        if (!reportDay || reportDay.user_id !== user.id) {
          await renderDailyReportRoot(ctx);
          return;
        }
        if (reportDay.locked) {
          await renderLockedDayInfo(ctx, reportDay);
          return;
        }
        const lockedDay = await lockReportDay({ reportDayId, userId: user.id });
        clearReportContextCache(reportDayId);
        const kb = await buildDailyReportKeyboard(ctx, lockedDay.id);
        await renderScreen(ctx, {
          titleKey: t('screens.daily_report.title'),
          bodyLines: [t('screens.daily_report.lock_success')],
          inlineKeyboard: kb
        });
        break;
      }

      case 'dr.unlock': {
        const { user } = await ensureUserAndSettings(ctx);
        const { reportDay } = await ensureReportContext(ctx);
        if (!reportDay.locked) {
          await renderDailyReportRoot(ctx);
          return;
        }
        await unlockReportDay({ reportDayId: reportDay.id, userId: user.id });
        clearReportContextCache(reportDay.id);
        try {
          await ctx.answerCallbackQuery({ text: t('screens.daily_report.unlocked_info'), show_alert: false });
        } catch {
          // ignore
        }
        await renderDailyReportRoot(ctx);
        break;
      }

      case 'dr.skip': {
        const reportDayId = (payload as { data?: { reportDayId?: string } }).data?.reportDayId;
        const itemId = (payload as { data?: { itemId?: string } }).data?.itemId;
        if (!reportDayId || !itemId) {
          await renderDailyStatusWithFilter(ctx, 'all');
          return;
        }
        const { reportDay, items } = await ensureReportContext(ctx, { reportDayId });
        if (reportDay.id === reportDayId && reportDay.locked) {
          await renderLockedDayInfo(ctx, reportDay);
          return;
        }
        if (reportDay.id !== reportDayId) {
          await renderDailyStatusWithFilter(ctx, 'all');
          return;
        }
        const item = items.find((i) => i.id === itemId);
        if (!item) {
          const kb = await buildDailyReportKeyboard(ctx, reportDay.id);
          await renderScreen(ctx, {
            titleKey: t('screens.daily_report.title'),
            bodyLines: [t('screens.daily_report.item_not_found')],
            inlineKeyboard: kb
          });
          return;
        }
        await saveValue({ reportDayId, item, valueJson: { skipped: true }, userId: reportDay.user_id });
        await renderDailyStatusWithFilter(ctx, 'all');
        break;
      }

      case 'dr.menu':
        await renderDailyReportRoot(ctx);
        break;

      case 'dr.back':
        await renderDashboard(ctx);
        break;

      // ===== Settings: Speed / Ping Test =====
      case 'settings.speed_test': {
        const startHandler = Date.now();
        const { user } = await ensureUserAndSettings(ctx);

        const supabaseStart = Date.now();
        await getOrCreateUserSettings(user.id);
        const supabaseMs = Date.now() - supabaseStart;

        const chatId = ctx.chat?.id;
        let telegramMs = 0;
        if (chatId) {
          const telegramStart = Date.now();
          await ctx.api.sendChatAction(chatId, 'typing');
          telegramMs = Date.now() - telegramStart;
        }

        const handlerMs = Date.now() - startHandler;

        const lines = [
          'Speed / Ping Test',
          '',
          `Supabase (user settings query): ~${supabaseMs} ms`,
          `Telegram API (sendChatAction): ~${telegramMs} ms`,
          `End-to-end handler: ~${handlerMs} ms`,
          '',
          'These values are approximate and averaged over a single attempt.'
        ];

        const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'nav.settings' });
        const kb = new InlineKeyboard().text(backBtn.text, backBtn.callback_data);

        await renderScreen(ctx, {
          titleKey: 'Speed / Ping Test',
          bodyLines: lines,
          inlineKeyboard: kb
        });
        break;
      }

      // ===== Error reports =====
      case 'error.send_report': {
        const errorCode =
          (payload as { errorCode?: string; data?: { errorCode?: string } }).errorCode ??
          (payload as { data?: { errorCode?: string } }).data?.errorCode;
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

bot.catch((err: BotError<Context>) => {
  const { ctx, error } = err;
  console.error('Bot error:', { updateId: ctx.update?.update_id, error });
});
