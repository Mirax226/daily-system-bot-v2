/* eslint-disable no-console */
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

/**
 * Per-user in-memory state (ephemeral).
 * IMPORTANT: Render free-tier can restart; state should be considered best-effort.
 */
type ReminderlessState = {
  awaitingValue?: { reportDayId: string; itemId: string };

  settingsRoutine?: { step: 'label' | 'xp'; label?: string };

  numericDraft?: { reportDayId: string; itemId: string; value: number };

  timeDraft?: {
    reportDayId: string;
    itemId: string;
    hour12: number;
    minuteTens: number;
    minuteOnes: number;
    ampm: 'AM' | 'PM';
  };

  rewardEdit?: {
    mode: 'create' | 'edit';
    rewardId?: string;
    step: 'title' | 'description' | 'xp' | 'confirm_delete';
    draft: { title?: string; description?: string | null; xpCost?: number };
  };
};

const userStates = new Map<string, ReminderlessState>();

// Cache report context per (user,date) to reduce repeated DB fetches within same session.
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
        await ctx.api.sendMessage(ctx.from.id, t('errors.session_expired_start_over'));
      }

      await renderDashboard(ctx);
      return;
    }
    throw error;
  }
};

const ensureUserAndSettings = async (ctx: Context) => {
  if (renderEnsureUserAndSettings) return renderEnsureUserAndSettings(ctx);
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
  const buyBtn = await makeActionButton(ctx, { label: t('buttons.rewards_buy'), action: 'rewards.buy' });
  const editBtn = await makeActionButton(ctx, { label: t('buttons.rewards_edit_store'), action: 'rewards.edit_root' });
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'nav.dashboard' });

  return new InlineKeyboard()
    .text(buyBtn.text, buyBtn.callback_data)
    .row()
    .text(editBtn.text, editBtn.callback_data)
    .row()
    .text(backBtn.text, backBtn.callback_data);
};

const buildReportsMenuKeyboard = async (ctx: Context): Promise<InlineKeyboard> => {
  const xpBtn = await makeActionButton(ctx, { label: t('buttons.reports_xp'), action: 'reports.xp' });
  const sleepBtn = await makeActionButton(ctx, { label: t('buttons.reports_sleep'), action: 'reports.sleep' });
  const studyBtn = await makeActionButton(ctx, { label: t('buttons.reports_study'), action: 'reports.study' });
  const tasksBtn = await makeActionButton(ctx, { label: t('buttons.reports_tasks'), action: 'reports.tasks' });
  const chartBtn = await makeActionButton(ctx, { label: t('buttons.reports_chart'), action: 'reports.chart' });
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'nav.dashboard' });

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

const buildDailyReportKeyboard = async (ctx: Context, reportDay: ReportDayRow): Promise<InlineKeyboard> => {
  const statusBtn = await makeActionButton(ctx, { label: t('buttons.dr_today_status'), action: 'dr.status', data: { reportDayId: reportDay.id, filter: 'all' } });
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'dr.back' });

  // When locked: keep only Status + Back, plus Unlock.
  if (reportDay.locked) {
    const unlockBtn = await makeActionButton(ctx, { label: t('buttons.dr_unlock'), action: 'dr.unlock', data: { reportDayId: reportDay.id } });
    return new InlineKeyboard().text(statusBtn.text, statusBtn.callback_data).row().text(unlockBtn.text, unlockBtn.callback_data).row().text(backBtn.text, backBtn.callback_data);
  }

  const nextBtn = await makeActionButton(ctx, { label: t('buttons.dr_fill_next'), action: 'dr.next', data: { reportDayId: reportDay.id } });
  const pickBtn = await makeActionButton(ctx, { label: t('buttons.dr_fill_specific'), action: 'dr.pick_item', data: { reportDayId: reportDay.id } });
  const templatesBtn = await makeActionButton(ctx, { label: t('buttons.dr_templates'), action: 'dr.templates', data: { reportDayId: reportDay.id } });
  const historyBtn = await makeActionButton(ctx, { label: t('buttons.dr_history'), action: 'dr.history', data: { reportDayId: reportDay.id } });
  const lockBtn = await makeActionButton(ctx, { label: t('buttons.dr_lock'), action: 'dr.lock', data: { reportDayId: reportDay.id } });

  return new InlineKeyboard()
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

const isLockedMessageLines = (reportDay: ReportDayRow): string[] => {
  // Only one localized line should be shown; translations handle language.
  return [t('screens.daily_report.day_locked')];
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
        // ignore
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

    const dailyReportBtn = await makeActionButton(ctx, { label: t('buttons.nav_daily_report'), action: 'nav.daily_report' });
    const reportcarBtn = await makeActionButton(ctx, { label: t('buttons.nav_reportcar'), action: 'nav.reportcar' });
    const tasksBtn = await makeActionButton(ctx, { label: t('buttons.nav_tasks'), action: 'nav.tasks' });
    const remindersBtn = await makeActionButton(ctx, { label: t('buttons.nav_reminders'), action: 'nav.reminders' });
    const rewardsBtn = await makeActionButton(ctx, { label: t('buttons.nav_rewards'), action: 'nav.rewards' });
    const reportsBtn = await makeActionButton(ctx, { label: t('buttons.nav_reports'), action: 'nav.reports' });
    const settingsBtn = await makeActionButton(ctx, { label: t('buttons.nav_settings'), action: 'nav.settings' });

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

    await renderScreen(ctx, { titleKey: t('screens.dashboard.title'), bodyLines, inlineKeyboard: kb });
  } catch (error) {
    console.error({ scope: 'home', event: 'render_error', error });
    const reloadBtn = await makeActionButton(ctx, { label: t('buttons.reload'), action: 'nav.dashboard' });
    await renderScreen(ctx, {
      titleKey: t('screens.dashboard.title'),
      bodyLines: [t('errors.dashboard_unavailable')],
      inlineKeyboard: new InlineKeyboard().text(reloadBtn.text, reloadBtn.callback_data)
    });
  }
};

const renderRewardCenter = async (ctx: Context): Promise<void> => {
  try {
    const { user } = await ensureUserAndSettings(ctx);
    await seedDefaultRewardsIfEmpty(user.id);
    const balance = await getXpBalance(user.id);

    const bodyLines = [t('screens.rewards.balance', { xp: balance }), '', t('screens.rewards.choose_option')];
    const kb = await buildRewardCenterKeyboard(ctx);

    await renderScreen(ctx, { titleKey: t('screens.rewards.title'), bodyLines, inlineKeyboard: kb });
  } catch (error) {
    console.error({ scope: 'rewards', event: 'render_error', error });
    const kb = await buildRewardCenterKeyboard(ctx);
    await renderScreen(ctx, {
      titleKey: t('screens.rewards.title'),
      bodyLines: [t('errors.rewards_unavailable')],
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
      const status = r.is_active ? t('common.active') : t('common.inactive');
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

  await renderScreen(ctx, { titleKey: t('screens.rewards.edit_store_title'), bodyLines, inlineKeyboard: kb });
};

const renderRewardEditMenu = async (ctx: Context, reward: RewardRow): Promise<void> => {
  const lines = [
    t('screens.rewards.editing', { title: reward.title, xp: reward.xp_cost }),
    t('screens.rewards.status_line', { status: reward.is_active ? t('common.active') : t('common.inactive') })
  ];

  const titleBtn = await makeActionButton(ctx, { label: t('buttons.rewards_edit_title'), action: 'rewards.edit_title', data: { rewardId: reward.id } });
  const descBtn = await makeActionButton(ctx, { label: t('buttons.rewards_edit_description'), action: 'rewards.edit_description', data: { rewardId: reward.id } });
  const xpBtn = await makeActionButton(ctx, { label: t('buttons.rewards_edit_xp'), action: 'rewards.edit_xp', data: { rewardId: reward.id } });
  const toggleBtn = await makeActionButton(ctx, {
    label: reward.is_active ? t('buttons.rewards_deactivate') : t('buttons.rewards_activate'),
    action: 'rewards.toggle_active',
    data: { rewardId: reward.id }
  });
  const deleteBtn = await makeActionButton(ctx, { label: t('buttons.rewards_delete'), action: 'rewards.delete', data: { rewardId: reward.id } });
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'rewards.edit_root' });

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
  await renderScreen(ctx, { titleKey: t('screens.reports.title'), bodyLines: [t('screens.reports.choose_category')], inlineKeyboard: kb });
};

const renderXpSummary = async (ctx: Context): Promise<void> => {
  const { user } = await ensureUserAndSettings(ctx);
  const summary = await getXpSummary(user.id);

  const lines = [
    t('screens.reports.xp_earned', { xp: summary.earned }),
    t('screens.reports.xp_spent', { xp: summary.spent }),
    t('screens.reports.xp_net', { xp: summary.net })
  ];

  const kb = await buildReportsMenuKeyboard(ctx);
  await renderScreen(ctx, { titleKey: t('screens.reports.xp_title'), bodyLines: lines, inlineKeyboard: kb });
};

const renderReportcar = async (ctx: Context): Promise<void> => {
  const back = await makeActionButton(ctx, { label: t('buttons.back'), action: 'nav.dashboard' });
  await renderScreen(ctx, { titleKey: t('screens.reportcar.title'), bodyLines: [t('screens.reportcar.coming_soon')], inlineKeyboard: new InlineKeyboard().text(back.text, back.callback_data) });
};

const renderTasks = async (ctx: Context): Promise<void> => {
  const back = await makeActionButton(ctx, { label: t('buttons.back'), action: 'nav.dashboard' });
  await renderScreen(ctx, { titleKey: t('screens.tasks.title'), bodyLines: [t('screens.tasks.coming_soon')], inlineKeyboard: new InlineKeyboard().text(back.text, back.callback_data) });
};

const renderTodo = async (ctx: Context): Promise<void> => {
  const back = await makeActionButton(ctx, { label: t('buttons.back'), action: 'nav.dashboard' });
  await renderScreen(ctx, { titleKey: t('screens.todo.title'), bodyLines: [t('screens.todo.coming_soon')], inlineKeyboard: new InlineKeyboard().text(back.text, back.callback_data) });
};

const renderPlanning = async (ctx: Context): Promise<void> => {
  const back = await makeActionButton(ctx, { label: t('buttons.back'), action: 'nav.dashboard' });
  await renderScreen(ctx, { titleKey: t('screens.planning.title'), bodyLines: [t('screens.planning.coming_soon')], inlineKeyboard: new InlineKeyboard().text(back.text, back.callback_data) });
};

const renderMyDay = async (ctx: Context): Promise<void> => {
  const back = await makeActionButton(ctx, { label: t('buttons.back'), action: 'nav.dashboard' });
  await renderScreen(ctx, { titleKey: t('screens.my_day.title'), bodyLines: [t('screens.my_day.coming_soon')], inlineKeyboard: new InlineKeyboard().text(back.text, back.callback_data) });
};

const renderFreeText = async (ctx: Context): Promise<void> => {
  const back = await makeActionButton(ctx, { label: t('buttons.back'), action: 'nav.dashboard' });
  await renderScreen(ctx, { titleKey: t('screens.free_text.title'), bodyLines: [t('screens.free_text.coming_soon')], inlineKeyboard: new InlineKeyboard().text(back.text, back.callback_data) });
};

const renderReminders = async (ctx: Context): Promise<void> => {
  const back = await makeActionButton(ctx, { label: t('buttons.back'), action: 'nav.dashboard' });
  await renderScreen(ctx, { titleKey: t('screens.reminders.title'), bodyLines: [t('screens.reminders.coming_soon')], inlineKeyboard: new InlineKeyboard().text(back.text, back.callback_data) });
};

const renderCalendarEvents = async (ctx: Context): Promise<void> => {
  const back = await makeActionButton(ctx, { label: t('buttons.back'), action: 'nav.dashboard' });
  await renderScreen(ctx, { titleKey: t('screens.calendar.title'), bodyLines: [t('screens.calendar.coming_soon')], inlineKeyboard: new InlineKeyboard().text(back.text, back.callback_data) });
};

const renderAI = async (ctx: Context): Promise<void> => {
  const back = await makeActionButton(ctx, { label: t('buttons.back'), action: 'nav.dashboard' });
  await renderScreen(ctx, { titleKey: t('screens.ai.title'), bodyLines: [t('screens.ai.coming_soon')], inlineKeyboard: new InlineKeyboard().text(back.text, back.callback_data) });
};

/**
 * Parsers & pickers
 */
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

const timeDraftToDisplay = (draft: {
  hour12: number;
  minuteTens: number;
  minuteOnes: number;
  ampm: 'AM' | 'PM';
}): { hhmm24: string; label: string } => {
  const hour12 = Math.min(12, Math.max(1, draft.hour12));
  const mt = Math.min(5, Math.max(0, draft.minuteTens));
  const mo = Math.min(9, Math.max(0, draft.minuteOnes));
  const minutes = mt * 10 + mo;

  const hour24 = draft.ampm === 'AM' ? hour12 % 12 : (hour12 % 12) + 12;

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
      const btn = await makeActionButton(ctx, { label: h.toString(), action: 'dr.time_set_hour', data: { reportDayId, itemId: item.id, hour12: h } });
      kb.text(btn.text, btn.callback_data);
    }
    kb.row();
  }

  for (let mt = 0; mt <= 5; mt++) {
    const btn = await makeActionButton(ctx, { label: `${mt}0`, action: 'dr.time_set_mtens', data: { reportDayId, itemId: item.id, minuteTens: mt } });
    kb.text(btn.text, btn.callback_data);
  }
  kb.row();

  for (let mo = 0; mo <= 9; mo++) {
    const btn = await makeActionButton(ctx, { label: mo.toString(), action: 'dr.time_set_mones', data: { reportDayId, itemId: item.id, minuteOnes: mo } });
    kb.text(btn.text, btn.callback_data);
  }
  kb.row();

  const amBtn = await makeActionButton(ctx, { label: 'AM', action: 'dr.time_set_ampm', data: { reportDayId, itemId: item.id, ampm: 'AM' } });
  const pmBtn = await makeActionButton(ctx, { label: 'PM', action: 'dr.time_set_ampm', data: { reportDayId, itemId: item.id, ampm: 'PM' } });
  kb.text(amBtn.text, amBtn.callback_data).text(pmBtn.text, pmBtn.callback_data);
  kb.row();

  const saveBtn = await makeActionButton(ctx, { label: t('screens.daily_report.time_save'), action: 'dr.time_save', data: { reportDayId, itemId: item.id } });
  const skipBtn = await makeActionButton(ctx, { label: t('buttons.skip'), action: 'dr.skip', data: { reportDayId, itemId: item.id } });
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'dr.menu', data: { reportDayId } });

  kb.text(saveBtn.text, saveBtn.callback_data).row();
  kb.text(skipBtn.text, skipBtn.callback_data).text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, { titleKey: t('screens.daily_report.title'), bodyLines: lines, inlineKeyboard: kb });
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
    const btn = await makeActionButton(ctx, { label: `+${delta}`, action: 'dr.num_delta', data: { reportDayId, itemId: item.id, delta } });
    kb.text(btn.text, btn.callback_data);
  }
  kb.row();

  const saveBtn = await makeActionButton(ctx, { label: t('screens.daily_report.numeric_save'), action: 'dr.num_save', data: { reportDayId, itemId: item.id } });
  const skipBtn = await makeActionButton(ctx, { label: t('buttons.skip'), action: 'dr.skip', data: { reportDayId, itemId: item.id } });
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'dr.menu', data: { reportDayId } });

  kb.text(saveBtn.text, saveBtn.callback_data).row();
  kb.text(skipBtn.text, skipBtn.callback_data).text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, { titleKey: t('screens.daily_report.title'), bodyLines: lines, inlineKeyboard: kb });
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

const renderDailyReportRoot = async (ctx: Context, localDate?: string): Promise<void> => {
  const { user } = await ensureUserAndSettings(ctx);
  const local = formatLocalTime(user.timezone ?? config.defaultTimezone);

  const targetDate = localDate ?? local.date;
  const { reportDay, items } = await ensureSpecificReportContext(ctx, targetDate);

  const statuses = await listCompletionStatus(reportDay.id, items);
  const completed = statuses.filter((s) => s.filled).length;
  const total = statuses.length;
  const template = (await getTemplateById(reportDay.template_id)) ?? (await ensureDefaultTemplate(reportDay.user_id));
  const templateName = template.title ?? 'Default Template';
  const yesterdayStatus = await loadYesterdayStatus(ctx);

  const template = await ensureDefaultTemplate(reportDay.user_id);
  const templateName = template.title ?? 'Default Template';

  const bodyLines: string[] = [
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

const renderDailyStatusWithFilter = async (ctx: Context, reportDayId: string, filter: 'all' | 'not_filled' | 'filled' = 'all'): Promise<void> => {
  const { user } = await ensureUserAndSettings(ctx);

  // Find reportDay for id (use range for safety; service provides getReportDayByLocalDate but not by id).
  // Most flows pass current reportDayId; we can rely on context cache for that day.
  const cached = [...reportContextCache.values()].find((v) => v.reportDay.id === reportDayId);
  const reportDay = cached?.reportDay ?? (await getOrCreateReportDay({ userId: user.id, templateId: (await ensureDefaultTemplate(user.id)).id, localDate: formatLocalTime(user.timezone ?? config.defaultTimezone).date }));

  const items = cached?.items ?? (await ensureDefaultItems(user.id));
  const statuses = await listCompletionStatus(reportDay.id, items);

  let filtered = statuses;
  if (filter === 'not_filled') filtered = statuses.filter((s) => !s.filled && !s.skipped);
  if (filter === 'filled') filtered = statuses.filter((s) => s.filled);

  const lines: string[] = [t('screens.daily_report.root_header', { date: reportDay.local_date }), t('screens.daily_report.status_header')];

  if (filtered.length === 0) {
    lines.push(filter === 'filled' ? t('screens.daily_report.none_filled') : t('screens.daily_report.none_pending'));
  } else {
    filtered.forEach((s, idx) => {
      const icon = s.filled ? '✅' : s.skipped ? '⏭' : '⬜️';
      lines.push(`${icon} ${idx + 1}) ${s.item.label}`);
    });
  }

  const kb = new InlineKeyboard();

  const allBtn = await makeActionButton(ctx, { label: t('screens.daily_report.filter_all'), action: 'dr.status', data: { reportDayId: reportDay.id, filter: 'all' } });
  const notFilledBtn = await makeActionButton(ctx, { label: t('screens.daily_report.filter_not_filled'), action: 'dr.status', data: { reportDayId: reportDay.id, filter: 'not_filled' } });
  const filledBtn = await makeActionButton(ctx, { label: t('screens.daily_report.filter_filled'), action: 'dr.status', data: { reportDayId: reportDay.id, filter: 'filled' } });

  kb.text(allBtn.text, allBtn.callback_data).text(notFilledBtn.text, notFilledBtn.callback_data).text(filledBtn.text, filledBtn.callback_data).row();

  // Only allow edit actions if NOT locked.
  for (const status of filtered) {
    const label = `${status.filled ? '✅' : status.skipped ? '⏭' : '⬜️'} ${status.item.label}`;
    const action = reportDay.locked ? 'noop' : 'dr.item';
    const btn = await makeActionButton(ctx, { label, action, data: { reportDayId: reportDay.id, itemId: status.item.id } });
    kb.text(btn.text, btn.callback_data).row();
  }

  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'dr.menu', data: { reportDayId: reportDay.id } });
  kb.text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, { titleKey: t('screens.daily_report.title'), bodyLines: lines, inlineKeyboard: kb });
};

const renderTemplatesScreen = async (ctx: Context): Promise<void> => {
  const { user } = await ensureUserAndSettings(ctx);
  const templates = await listUserTemplates(user.id);

  const lines: string[] = [t('screens.templates.title'), ''];

  if (!templates.length) {
    lines.push(t('screens.templates.none'));
  } else {
    templates.forEach((tpl) => {
      lines.push(`• ${tpl.title ?? 'Template'}${tpl.is_active ? ` (${t('common.active')})` : ''}`);
    });
  }

  const kb = new InlineKeyboard();

  for (const tpl of templates) {
    const btn = await makeActionButton(ctx, { label: `🗂 ${tpl.title ?? 'Template'}`, action: 'tpl.open', data: { templateId: tpl.id } });
    kb.text(btn.text, btn.callback_data).row();
  }

  const newBtn = await makeActionButton(ctx, { label: t('buttons.templates_new'), action: 'tpl.new' });
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'dr.menu' });

  kb.text(newBtn.text, newBtn.callback_data).row();
  kb.text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, { titleKey: t('screens.templates.title'), bodyLines: lines, inlineKeyboard: kb });
};

const renderTemplateDetails = async (ctx: Context, templateId: string): Promise<void> => {
  const { user } = await ensureUserAndSettings(ctx);
  const tpl = await getTemplateById(user.id, templateId);
  if (!tpl) {
    await renderTemplatesScreen(ctx);
    return;
  }

  const lines: string[] = [
    t('screens.templates.details_title'),
    '',
    `${t('common.title')}: ${tpl.title ?? '-'}`,
    `${t('common.status')}: ${tpl.is_active ? t('common.active') : t('common.inactive')}`
  ];

  const kb = new InlineKeyboard();

  const setActiveBtn = await makeActionButton(ctx, { label: t('buttons.templates_set_active'), action: 'tpl.set_active', data: { templateId } });
  const dupBtn = await makeActionButton(ctx, { label: t('buttons.templates_duplicate'), action: 'tpl.duplicate', data: { templateId } });
  const delBtn = await makeActionButton(ctx, { label: t('buttons.templates_delete'), action: 'tpl.delete', data: { templateId } });
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'dr.templates' });

  kb.text(setActiveBtn.text, setActiveBtn.callback_data).row();
  kb.text(dupBtn.text, dupBtn.callback_data).row();
  kb.text(delBtn.text, delBtn.callback_data).row();
  kb.text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, { titleKey: t('screens.templates.details_title'), bodyLines: lines, inlineKeyboard: kb });
};

const renderHistory = async (ctx: Context): Promise<void> => {
  const { user } = await ensureUserAndSettings(ctx);
  const local = formatLocalTime(user.timezone ?? config.defaultTimezone);

  // Show last 14 days by default.
  const end = local.date;
  const [yy, mm, dd] = end.split('-').map((x) => Number(x));
  const dt = new Date(Date.UTC(yy, mm - 1, dd));
  dt.setUTCDate(dt.getUTCDate() - 13);
  const start = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;

  const days = await listReportDaysByRange({ userId: user.id, startLocalDate: start, endLocalDate: end });

  const lines: string[] = [t('screens.history.title'), '', t('screens.history.range', { start, end })];

  const kb = new InlineKeyboard();

  if (!days.length) {
    lines.push('', t('screens.history.none'));
  } else {
    lines.push('');
    for (const day of days) {
      const label = `${day.local_date}${day.locked ? ` 🔒` : ''}`;
      const btn = await makeActionButton(ctx, { label, action: 'hist.open', data: { localDate: day.local_date } });
      kb.text(btn.text, btn.callback_data).row();
    }
  }

  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'dr.menu' });
  kb.text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, { titleKey: t('screens.history.title'), bodyLines: lines, inlineKeyboard: kb });
};

const renderHistoryDay = async (ctx: Context, localDate: string): Promise<void> => {
  const { userId, reportDay, items } = await ensureSpecificReportContext(ctx, localDate);
  const statuses = await listCompletionStatus(reportDay.id, items);

  const lines: string[] = [t('screens.history.day_title', { date: reportDay.local_date }), ''];

  statuses.forEach((s, idx) => {
    const icon = s.filled ? '✅' : s.skipped ? '⏭' : '⬜️';
    lines.push(`${icon} ${idx + 1}) ${s.item.label}`);
  });

  const kb = new InlineKeyboard();
  const openBtn = await makeActionButton(ctx, { label: t('buttons.dr_open_date'), action: 'dr.open_date', data: { localDate } });
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'dr.history' });

  kb.text(openBtn.text, openBtn.callback_data).row().text(backBtn.text, backBtn.callback_data);

  // Make sure cache is warmed for that day
  reportContextCache.set(`${userId}:${localDate}`, { reportDay, items });

  await renderScreen(ctx, { titleKey: t('screens.history.day_title', { date: reportDay.local_date }), bodyLines: lines, inlineKeyboard: kb });
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
  const stateKey = String(ctx.from.id);
  const state = userStates.get(stateKey);
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
    userStates.delete(stateKey);
    await renderScreen(ctx, {
      titleKey: t('screens.daily_report.title'),
      bodyLines: [t('screens.daily_report.session_expired')],
      inlineKeyboard: await buildDailyReportKeyboard(ctx, reportDay)
    });
    return;
  }

  if (reportDay.locked) {
    userStates.delete(stateKey);
    await renderScreen(ctx, {
      titleKey: t('screens.daily_report.title'),
      bodyLines: isLockedMessageLines(reportDay),
      inlineKeyboard: await buildDailyReportKeyboard(ctx, reportDay)
    });
    return;
  }

  const item = items.find((i) => i.id === itemId);
  if (!item) {
    userStates.delete(stateKey);
    await renderScreen(ctx, {
      titleKey: t('screens.daily_report.title'),
      bodyLines: [t('screens.daily_report.item_not_found')],
      inlineKeyboard: await buildDailyReportKeyboard(ctx, reportDay)
    });
    return;
  }

  let valueJson: Record<string, unknown> | null = null;

  switch (item.item_type) {
    case 'time_hhmm': {
      const parsed = parseTimeHhmm(text);
      if (!parsed) {
        await renderScreen(ctx, { titleKey: t('screens.daily_report.title'), bodyLines: [t('screens.daily_report.invalid_time')], inlineKeyboard: await buildDailyReportKeyboard(ctx, reportDay) });
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
          inlineKeyboard: await buildDailyReportKeyboard(ctx, reportDay)
        });
        return;
      }
      valueJson = { value: mins, minutes: mins };
      break;
    }
    case 'number': {
      const n = Number(text.trim());
      if (!Number.isFinite(n)) {
        await renderScreen(ctx, { titleKey: t('screens.daily_report.title'), bodyLines: [t('screens.daily_report.invalid_number')], inlineKeyboard: await buildDailyReportKeyboard(ctx, reportDay) });
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
    console.error({ scope: 'daily_report', event: 'save_value_failed', error, reportDayId, itemId: item.id, valueJson });
    await renderScreen(ctx, { titleKey: t('screens.daily_report.title'), bodyLines: [t('screens.daily_report.save_failed')], inlineKeyboard: await buildDailyReportKeyboard(ctx, reportDay) });
    return;
  }

  const userSettings = (await ensureUserAndSettings(ctx)).user.settings_json as Record<string, unknown>;
  await logForUser({ userId: reportDay.user_id, ctx, eventName: 'db_write', payload: { action: 'save_value', item_id: item.id }, enabled: telemetryEnabledForUser(userSettings) });

  // Clear state for that field
  const nextState = { ...(userStates.get(stateKey) ?? {}) };
  delete nextState.awaitingValue;
  delete nextState.numericDraft;
  delete nextState.timeDraft;
  userStates.set(stateKey, nextState);

  await renderDailyReportRoot(ctx, reportDay.local_date);
};

const renderSettingsRoot = async (ctx: Context): Promise<void> => {
  const speedBtn = await makeActionButton(ctx, { label: t('buttons.settings_speed_test'), action: 'settings.speed_test' });
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'nav.dashboard' });
  const kb = new InlineKeyboard().text(speedBtn.text, speedBtn.callback_data).row().text(backBtn.text, backBtn.callback_data);
  await renderScreen(ctx, { titleKey: t('screens.settings.title'), bodyLines: [t('screens.settings.choose_option')], inlineKeyboard: kb });
};

/* ===== Commands ===== */

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

bot.callbackQuery('dbg:test', async (ctx) => {
  await safeAnswerCallback(ctx, { text: 'Inline is working!' });
});

bot.hears('🏠 Dashboard', renderDashboard);
bot.hears('🧾 Daily Report', async (ctx: Context) => renderDailyReportRoot(ctx));
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
bot.hears('⚙️ Settings', renderSettingsRoot);
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

    await logTelemetryEvent({ userId: user.id, traceId, eventName: 'callback_token_pressed', payload: { data: ctx.callbackQuery.data }, enabled });

    const token = ctx.callbackQuery.data;
    const payload = await consumeCallbackToken(token);

    await logTelemetryEvent({ userId: user.id, traceId, eventName: 'callback_token_consumed', payload: { token, valid: Boolean(payload) }, enabled });

    const action = typeof payload === 'object' && payload ? (payload as { action?: string }).action : null;

    if (!action) {
      await ctx.answerCallbackQuery({ text: t('errors.action_expired'), show_alert: true });
      return;
    }

    switch (action) {
      case 'noop':
        return;

      /* --- Navigation --- */
      case 'nav.dashboard':
        await renderDashboard(ctx);
        return;
      case 'nav.daily_report':
        await renderDailyReportRoot(ctx);
        return;
      case 'nav.reportcar':
        await renderReportcar(ctx);
        return;
      case 'nav.tasks':
        await renderTasks(ctx);
        return;
      case 'nav.reminders':
        await renderReminders(ctx);
        return;
      case 'nav.rewards':
        await renderRewardCenter(ctx);
        return;
      case 'nav.reports':
        await renderReportsMenu(ctx);
        return;
      case 'nav.settings':
        await renderSettingsRoot(ctx);
        return;

      /* --- Reports --- */
      case 'reports.xp':
        await renderXpSummary(ctx);
        return;
      case 'reports.sleep':
      case 'reports.study':
      case 'reports.tasks':
      case 'reports.chart': {
        const kind = action.split('.')[1];
        await renderScreen(ctx, {
          titleKey: t('screens.reports.title'),
          bodyLines: [t('screens.coming_soon_generic', { feature: kind })],
          inlineKeyboard: await buildReportsMenuKeyboard(ctx)
        });
        return;
      }

      /* --- Rewards (Buy) --- */
      case 'rewards.buy':
        await renderRewardBuyList(ctx);
        return;

      case 'rewards.confirm': {
        const rewardId = (payload as { data?: { rewardId?: string } }).data?.rewardId;
        if (!rewardId) {
          await renderRewardBuyList(ctx);
          return;
        }

        const reward = await getRewardById(rewardId);
        if (!reward) {
          const kb = await buildRewardCenterKeyboard(ctx);
          await renderScreen(ctx, { titleKey: t('screens.rewards.title'), bodyLines: [t('errors.reward_not_found')], inlineKeyboard: kb });
          return;
        }

        await purchaseReward({ userId: user.id, reward });
        const balance = await getXpBalance(user.id);

        await logForUser({ userId: user.id, ctx, eventName: 'db_write', payload: { action: 'purchase_reward', reward_id: reward.id, cost: reward.xp_cost }, enabled });

        const kb = await buildRewardCenterKeyboard(ctx);
        await renderScreen(ctx, { titleKey: t('screens.rewards.title'), bodyLines: [t('screens.rewards.purchased', { title: reward.title, xp: reward.xp_cost }), t('screens.rewards.new_balance', { xp: balance })], inlineKeyboard: kb });
        return;
      }

      /* --- Rewards (Edit Store) --- */
      case 'rewards.edit_root':
        await renderRewardStoreEditorRoot(ctx);
        return;

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
        return;
      }

      case 'rewards.edit_title':
      case 'rewards.edit_description':
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
        return;
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
        userStates.set(telegramId, { ...(userStates.get(telegramId) || {}), rewardEdit: { mode: 'edit', rewardId, step: 'confirm_delete', draft: {} } });

        const confirmBtn = await makeActionButton(ctx, { label: t('buttons.yes_delete'), action: 'rewards.delete_confirm', data: { rewardId } });
        const cancelBtn = await makeActionButton(ctx, { label: t('buttons.cancel'), action: 'rewards.edit_open', data: { rewardId } });

        const kb = new InlineKeyboard().text(confirmBtn.text, confirmBtn.callback_data).row().text(cancelBtn.text, cancelBtn.callback_data);

        await renderScreen(ctx, { titleKey: t('screens.rewards.delete_title'), bodyLines: [t('screens.rewards.confirm_delete', { title: reward.title })], inlineKeyboard: kb });
        return;
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
        const st = { ...(userStates.get(telegramId) || {}) };
        delete st.rewardEdit;
        userStates.set(telegramId, st);

        await renderRewardStoreEditorRoot(ctx);
        return;
      }

      /* --- Settings --- */
      case 'settings.speed_test': {
        const startHandler = Date.now();
        const { user: u } = await ensureUserAndSettings(ctx);

        const supabaseStart = Date.now();
        await getOrCreateUserSettings(u.id);
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
          t('screens.settings.speed_title'),
          '',
          t('screens.settings.speed_supabase', { ms: supabaseMs }),
          t('screens.settings.speed_telegram', { ms: telegramMs }),
          t('screens.settings.speed_handler', { ms: handlerMs }),
          '',
          t('screens.settings.speed_note')
        ];

        const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'nav.settings' });
        await renderScreen(ctx, { titleKey: t('screens.settings.speed_title'), bodyLines: lines, inlineKeyboard: new InlineKeyboard().text(backBtn.text, backBtn.callback_data) });
        return;
      }

      /* --- Daily Report --- */
      case 'dr.menu': {
        const reportDayId = (payload as { data?: { reportDayId?: string } }).data?.reportDayId;
        if (reportDayId) {
          // find cached date
          const cachedById = [...reportContextCache.entries()].find(([, v]) => v.reportDay.id === reportDayId);
          if (cachedById) {
            const date = cachedById[1].reportDay.local_date;
            await renderDailyReportRoot(ctx, date);
            return;
          }
        }
        await renderDailyReportRoot(ctx);
        return;
      }

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

      case 'dr.status': {
        const data = (payload as { data?: { reportDayId?: string; filter?: 'all' | 'not_filled' | 'filled' } }).data;
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
        await renderDailyStatusWithFilter(ctx, reportDayId, filter);
        return;
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
        await promptForItem(ctx, reportDay, next.item);
        return;
      }

      case 'dr.pick_item': {
        const reportDayId = (payload as { data?: { reportDayId?: string } }).data?.reportDayId;
        const { reportDay } = await (reportDayId ? ensureReportContext(ctx) : ensureReportContext(ctx));
        await renderDailyStatusWithFilter(ctx, reportDay.id, 'all');
        return;
      }

      case 'dr.item': {
        const data = (payload as { data?: { reportDayId?: string; itemId?: string } }).data;
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
          await ctx.answerCallbackQuery({ text: t('errors.item_not_found'), show_alert: true });
          return;
        }
        await promptForItem(ctx, reportDay, item);
        return;
      }

      case 'dr.time_set_hour':
      case 'dr.time_set_mtens':
      case 'dr.time_set_mones':
      case 'dr.time_set_ampm': {
        const data = (payload as { data?: any }).data as {
          reportDayId?: string;
          itemId?: string;
          hour12?: number;
          minuteTens?: number;
          minuteOnes?: number;
          ampm?: 'AM' | 'PM';
        };
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
        if (reportDay.locked) {
          await renderScreen(ctx, { titleKey: t('screens.daily_report.title'), bodyLines: isLockedMessageLines(reportDay), inlineKeyboard: await buildDailyReportKeyboard(ctx, reportDay) });
          return;
        }
        await renderTimePicker(ctx, reportDayId, item, nextDraft);
        return;
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

        const updated = { ...(userStates.get(telegramId) || {}) };
        delete updated.timeDraft;
        userStates.set(telegramId, updated);
        return;
      }

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
          await renderDailyReportRoot(ctx);
          return;
        }

        userStates.set(telegramId, {
          ...state,
          numericDraft: { reportDayId, itemId, value: next }
        });

        const { items } = await ensureReportContext(ctx, { reportDayId });
        const item = items.find((i) => i.id === itemId);
        if (!item) {
          await renderDailyReportRoot(ctx);
          return;
        }

        if (reportDay.locked) {
          await renderScreen(ctx, { titleKey: t('screens.daily_report.title'), bodyLines: isLockedMessageLines(reportDay), inlineKeyboard: await buildDailyReportKeyboard(ctx, reportDay) });
          return;
        }

        const current = state.numericDraft.value ?? 0;
        const next = Math.max(0, current + delta);

        userStates.set(telegramId, { ...state, numericDraft: { reportDayId, itemId, value: next } });

        await renderNumericInput(ctx, reportDayId, item, next);
        return;
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
          await renderDailyReportRoot(ctx);
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
        const data = (payload as { data?: { reportDayId?: string; itemId?: string } }).data;
        const reportDayId = data?.reportDayId;
        const itemId = data?.itemId;
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

        const cached = [...reportContextCache.values()].find((v) => v.reportDay.id === reportDayId);
        const reportDay = cached?.reportDay ?? (await ensureReportContext(ctx)).reportDay;
        const items = cached?.items ?? (await ensureDefaultItems(reportDay.user_id));
        const item = items.find((i) => i.id === itemId);
        if (!item) {
          await renderDailyReportRoot(ctx);
          return;
        }

        if (reportDay.locked) {
          await renderScreen(ctx, { titleKey: t('screens.daily_report.title'), bodyLines: isLockedMessageLines(reportDay), inlineKeyboard: await buildDailyReportKeyboard(ctx, reportDay) });
          return;
        }

        await saveValue({ reportDayId, item, valueJson: { skipped: true }, userId: reportDay.user_id });

        // Clear state for that field if it was awaiting this.
        const telegramId = String(ctx.from?.id ?? '');
        const st = { ...(userStates.get(telegramId) || {}) };
        if (st.awaitingValue?.itemId === itemId && st.awaitingValue?.reportDayId === reportDayId) delete st.awaitingValue;
        delete st.numericDraft;
        delete st.timeDraft;
        userStates.set(telegramId, st);

        await renderDailyReportRoot(ctx, reportDay.local_date);
        return;
      }

      case 'dr.lock': {
        const reportDayId = (payload as { data?: { reportDayId?: string } }).data?.reportDayId;
        if (!reportDayId) {
          await renderDailyReportRoot(ctx);
          return;
        }
        const cached = [...reportContextCache.values()].find((v) => v.reportDay.id === reportDayId);
        const reportDay = cached?.reportDay ?? (await ensureReportContext(ctx)).reportDay;

        await lockReportDay({ reportDayId: reportDay.id });

        // Invalidate cache for that day so next render reflects lock.
        reportContextCache.forEach((v, k) => {
          if (v.reportDay.id === reportDay.id) reportContextCache.delete(k);
        });

        await renderDailyReportRoot(ctx, reportDay.local_date);
        return;
      }

      case 'dr.unlock': {
        const reportDayId = (payload as { data?: { reportDayId?: string } }).data?.reportDayId;
        if (!reportDayId) {
          await renderDailyReportRoot(ctx);
          return;
        }
        const cached = [...reportContextCache.values()].find((v) => v.reportDay.id === reportDayId);
        const reportDay = cached?.reportDay ?? (await ensureReportContext(ctx)).reportDay;

        await unlockReportDay({ reportDayId: reportDay.id });

        reportContextCache.forEach((v, k) => {
          if (v.reportDay.id === reportDay.id) reportContextCache.delete(k);
        });

        await renderDailyReportRoot(ctx, reportDay.local_date);
        return;
      }

      case 'dr.templates': {
        await renderTemplatesScreen(ctx);
        return;
      }

      case 'tpl.open': {
        const templateId = (payload as { data?: { templateId?: string } }).data?.templateId;
        if (!templateId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        await renderTemplateDetails(ctx, templateId);
        return;
      }

      case 'tpl.set_active': {
        const templateId = (payload as { data?: { templateId?: string } }).data?.templateId;
        if (!templateId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        const { user: u } = await ensureUserAndSettings(ctx);
        await setActiveTemplate(u.id, templateId);
        reportContextCache.clear();
        await renderTemplateDetails(ctx, templateId);
        return;
      }

      case 'tpl.duplicate': {
        const templateId = (payload as { data?: { templateId?: string } }).data?.templateId;
        if (!templateId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        const { user: u } = await ensureUserAndSettings(ctx);
        await duplicateTemplate(u.id, templateId);
        reportContextCache.clear();
        await renderTemplatesScreen(ctx);
        return;
      }

      case 'tpl.delete': {
        const templateId = (payload as { data?: { templateId?: string } }).data?.templateId;
        if (!templateId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        const { user: u } = await ensureUserAndSettings(ctx);
        await deleteTemplate(u.id, templateId);
        reportContextCache.clear();
        await renderTemplatesScreen(ctx);
        return;
      }

      case 'tpl.new': {
        const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'dr.templates' });
        await renderScreen(ctx, {
          titleKey: t('screens.templates.title'),
          bodyLines: [t('screens.templates.new_coming_soon')],
          inlineKeyboard: new InlineKeyboard().text(backBtn.text, backBtn.callback_data)
        });
        return;
      }

      case 'dr.history': {
        await renderHistory(ctx);
        return;
      }

      case 'hist.open': {
        const localDate = (payload as { data?: { localDate?: string } }).data?.localDate;
        if (!localDate) {
          await renderHistory(ctx);
          return;
        }
        await renderHistoryDay(ctx, localDate);
        return;
      }

      /* --- Error report --- */
      case 'error.send_report': {
        const errorCode =
          (payload as { errorCode?: string; data?: { errorCode?: string } }).errorCode ?? (payload as { data?: { errorCode?: string } }).data?.errorCode;

        if (!errorCode) {
          await ctx.answerCallbackQuery({ text: t('errors.report_not_found'), show_alert: true });
          return;
        }

        const report = await getErrorReportByCode(errorCode);
        if (!report) {
          await ctx.answerCallbackQuery({ text: t('errors.report_not_found'), show_alert: true });
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

          const message = ['*Error report*', `Code: ${report.error_code}`, `Trace: ${report.trace_id}`, `Created: ${report.created_at}`, `User: ${report.user_id}`, '', 'Recent events:', events].join('\n');
          await ctx.api.sendMessage(targetId, message, { parse_mode: 'Markdown' });
        }

        await ctx.answerCallbackQuery({ text: t('screens.error_report.sent'), show_alert: true });
        await logTelemetryEvent({ userId: report.user_id, traceId, eventName: 'error_report_sent', payload: { error_code: errorCode, target: config.telegram.adminId ?? ctx.from?.id }, enabled });
        return;
      }

      default:
        await ctx.answerCallbackQuery({ text: t('errors.action_expired'), show_alert: true });
        return;
    }
  } catch (error) {
    console.error({ scope: 'callback_tokens', event: 'consume_failure', error });
    await ctx.answerCallbackQuery({ text: t('errors.unexpected_try_again'), show_alert: true });
  }
});

/**
 * Text message handler: only active during explicit flows.
 */
bot.on('message:text', async (ctx: Context) => {
  if (!ctx.from || !ctx.message || typeof ctx.message.text !== 'string') return;

  const text = ctx.message.text.trim();
  const stateKey = String(ctx.from.id);
  const state = userStates.get(stateKey) ?? {};

  // 1) Daily Report free text input (when explicitly requested)
  if (state.awaitingValue) {
    await handleSaveValue(ctx, text);
    return;
  }

  // 2) Settings routine steps (kept for backward-compat)
  if (state.settingsRoutine?.step === 'label') {
    userStates.set(stateKey, { ...state, settingsRoutine: { step: 'xp', label: text } });

    const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'nav.settings' });
    await renderScreen(ctx, { titleKey: t('screens.settings.title'), bodyLines: [t('screens.settings.enter_xp_for_routine')], inlineKeyboard: new InlineKeyboard().text(backBtn.text, backBtn.callback_data) });
    return;
  }

  if (state.settingsRoutine?.step === 'xp') {
    const xp = Number(text);
    if (!Number.isInteger(xp)) {
      const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'nav.settings' });
      await renderScreen(ctx, { titleKey: t('screens.settings.title'), bodyLines: [t('screens.settings.invalid_xp')], inlineKeyboard: new InlineKeyboard().text(backBtn.text, backBtn.callback_data) });
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

    userStates.set(stateKey, { ...state, settingsRoutine: undefined });
    await renderSettingsRoot(ctx);
    return;
  }

  // 3) Reward Store edit flow
  if (state.rewardEdit) {
    const flow = state.rewardEdit;

    // Handle confirm_delete step (text input ignored)
    if (flow.step === 'confirm_delete') {
      await renderRewardStoreEditorRoot(ctx);
      return;
    }

    if (flow.step === 'title') {
      if (flow.mode === 'create') {
        userStates.set(stateKey, { ...state, rewardEdit: { ...flow, step: 'description', draft: { ...flow.draft, title: text } } });
        const cancelBtn = await makeActionButton(ctx, { label: t('buttons.cancel'), action: 'rewards.edit_root' });
        await renderScreen(ctx, { titleKey: t('screens.rewards.add_title'), bodyLines: [t('screens.rewards.ask_description')], inlineKeyboard: new InlineKeyboard().text(cancelBtn.text, cancelBtn.callback_data) });
        return;
      }

      if (!flow.rewardId) {
        userStates.set(stateKey, { ...state, rewardEdit: undefined });
        await renderRewardStoreEditorRoot(ctx);
        return;
      }

      const updated = await updateReward({ rewardId: flow.rewardId, patch: { title: text } });
      userStates.set(stateKey, { ...state, rewardEdit: undefined });
      await renderRewardEditMenu(ctx, updated);
      return;
    }

    if (flow.step === 'description') {
      const desc = text === '-' ? null : text;

      if (flow.mode === 'create') {
        userStates.set(stateKey, { ...state, rewardEdit: { ...flow, step: 'xp', draft: { ...flow.draft, description: desc } } });
        const cancelBtn = await makeActionButton(ctx, { label: t('buttons.cancel'), action: 'rewards.edit_root' });
        await renderScreen(ctx, { titleKey: t('screens.rewards.add_title'), bodyLines: [t('screens.rewards.ask_xp_cost')], inlineKeyboard: new InlineKeyboard().text(cancelBtn.text, cancelBtn.callback_data) });
        return;
      }

      if (!flow.rewardId) {
        userStates.set(stateKey, { ...state, rewardEdit: undefined });
        await renderRewardStoreEditorRoot(ctx);
        return;
      }

      const updated = await updateReward({ rewardId: flow.rewardId, patch: { description: desc } });
      userStates.set(stateKey, { ...state, rewardEdit: undefined });
      await renderRewardEditMenu(ctx, updated);
      return;
    }

    if (flow.step === 'xp') {
      const xp = Number(text);
      if (!Number.isInteger(xp) || xp <= 0) {
        const cancelAction = flow.mode === 'create' ? 'rewards.edit_root' : 'rewards.edit_open';
        const cancelData = flow.mode === 'create' ? {} : { rewardId: flow.rewardId };
        const cancelBtn = await makeActionButton(ctx, { label: t('buttons.cancel'), action: cancelAction, data: cancelData });
        await renderScreen(ctx, { titleKey: t('screens.rewards.add_title'), bodyLines: [t('screens.rewards.invalid_xp_cost')], inlineKeyboard: new InlineKeyboard().text(cancelBtn.text, cancelBtn.callback_data) });
        return;
      }

      if (flow.mode === 'create') {
        const { user } = await ensureUserAndSettings(ctx);
        await createReward({ userId: user.id, title: flow.draft.title ?? 'Reward', description: flow.draft.description ?? null, xpCost: xp });
        userStates.set(stateKey, { ...state, rewardEdit: undefined });
        await renderRewardStoreEditorRoot(ctx);
        return;
      }

      if (!flow.rewardId) {
        userStates.set(stateKey, { ...state, rewardEdit: undefined });
        await renderRewardStoreEditorRoot(ctx);
        return;
      }

      const updated = await updateReward({ rewardId: flow.rewardId, patch: { xpCost: xp } });
      userStates.set(stateKey, { ...state, rewardEdit: undefined });
      await renderRewardEditMenu(ctx, updated);
      return;
    }

    userStates.set(stateKey, { ...state, rewardEdit: undefined });
    await renderRewardStoreEditorRoot(ctx);
  }
});

bot.catch((err: BotError<Context>) => {
  const { ctx, error } = err;
  console.error('Bot error:', { updateId: ctx.update?.update_id, error });
});
