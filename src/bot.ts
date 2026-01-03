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
  upsertItem,
  listItems,
  listAllItems,
  listUserTemplates,
  setActiveTemplate,
  deleteTemplate,
  duplicateTemplate,
  getTemplateById,
  getItemById,
  updateItem,
  setItemEnabled,
  moveItem,
  deleteItem,
  createUserTemplate
} from './services/reportTemplates';

import {
  getOrCreateReportDay,
  getReportDayByDate,
  listCompletionStatus,
  saveValue,
  lockReportDay,
  unlockReportDay,
  listRecentReportDays
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
type TemplateItemFlow = {
  mode: 'create' | 'edit';
  templateId: string;
  itemId?: string;
  step: 'label' | 'key' | 'type' | 'category' | 'xp_mode' | 'xp_value';
  draft: {
    label?: string;
    itemKey?: string;
    itemType?: string;
    category?: string | null;
    xpMode?: string | null;
    xpValue?: number | null;
    optionsJson?: Record<string, unknown> | null;
  };
};

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

  templateItemFlow?: TemplateItemFlow;
};

const userStates = new Map<string, ReminderlessState>();

// Cache report context per (user,date) to reduce repeated DB fetches within same session.
const reportContextCache = new Map<string, { reportDay: ReportDayRow; items: ReportItemRow[] }>();
const clearReportContextCache = (): void => {
  reportContextCache.clear();
};
const clearTemplateItemFlow = (telegramId: string): void => {
  const st = { ...(userStates.get(telegramId) || {}) };
  delete st.templateItemFlow;
  userStates.set(telegramId, st);
};

const setTemplateItemFlow = (telegramId: string, flow: TemplateItemFlow): void => {
  const st = { ...(userStates.get(telegramId) || {}) };
  st.templateItemFlow = flow;
  userStates.set(telegramId, st);
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
    titleKey: 'errors.error_title',
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

const ensureReportContext = async (ctx: Context): Promise<{ userId: string; reportDay: ReportDayRow; items: ReportItemRow[] }> => {
  const { user, settings } = await ensureUserAndSettings(ctx);
  const local = formatLocalTime(user.timezone ?? config.defaultTimezone);
  const cacheKey = `${user.id}:${local.date}`;

  const cached = reportContextCache.get(cacheKey);
  if (cached) return { userId: user.id, ...cached };

  const defaultTemplate = await ensureDefaultTemplate(user.id);
  const settingsJson = (settings.settings_json ?? {}) as { active_template_id?: string | null };
  const activeTemplateId = settingsJson.active_template_id ?? defaultTemplate.id;
  const activeTemplateCandidate = activeTemplateId === defaultTemplate.id ? defaultTemplate : await getTemplateById(activeTemplateId);
  const template = activeTemplateCandidate && activeTemplateCandidate.user_id === user.id ? activeTemplateCandidate : defaultTemplate;

  const items = template.id === defaultTemplate.id ? await ensureDefaultItems(user.id) : await listItems(template.id);
  const reportDay = await getOrCreateReportDay({ userId: user.id, templateId: template.id, localDate: local.date });

  reportContextCache.set(cacheKey, { reportDay, items });
  return { userId: user.id, reportDay, items };
};

const ensureSpecificReportContext = async (
  ctx: Context,
  localDate: string
): Promise<{ userId: string; reportDay: ReportDayRow; items: ReportItemRow[] }> => {
  const { user, settings } = await ensureUserAndSettings(ctx);

  const cacheKey = `${user.id}:${localDate}`;
  const cached = reportContextCache.get(cacheKey);
  if (cached) return { userId: user.id, ...cached };

  const defaultTemplate = await ensureDefaultTemplate(user.id);
  const settingsJson = (settings.settings_json ?? {}) as { active_template_id?: string | null };
  const activeTemplateId = settingsJson.active_template_id ?? defaultTemplate.id;
  const activeTemplateCandidate = activeTemplateId === defaultTemplate.id ? defaultTemplate : await getTemplateById(activeTemplateId);
  const template = activeTemplateCandidate && activeTemplateCandidate.user_id === user.id ? activeTemplateCandidate : defaultTemplate;

  const items = template.id === defaultTemplate.id ? await ensureDefaultItems(user.id) : await listItems(template.id);

  const reportDay = await getOrCreateReportDay({ userId: user.id, templateId: template.id, localDate });

  reportContextCache.set(cacheKey, { reportDay, items });
  return { userId: user.id, reportDay, items };
};

const isLockedMessageLines = (reportDay: ReportDayRow): string[] => {
  // Only one localized line should be shown; translations handle language.
  return [t('screens.daily_report.day_locked')];
};

const renderDashboard = async (ctx: Context): Promise<void> => {
  try {
    const { user, settings } = await ensureUserAndSettings(ctx);
    const isNew = !settings.onboarded;

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

const renderRewardBuyList = async (ctx: Context): Promise<void> => {
  const { user } = await ensureUserAndSettings(ctx);
  const rewards = await listRewards(user.id);

  if (!rewards.length) {
    const kb = await buildRewardCenterKeyboard(ctx);
    await renderScreen(ctx, { titleKey: t('screens.rewards.title'), bodyLines: [t('screens.rewards.empty')], inlineKeyboard: kb });
    return;
  }

  const kb = new InlineKeyboard();
  for (const reward of rewards) {
    const btn = await makeActionButton(ctx, { label: `${reward.title} (${reward.xp_cost} XP)`, action: 'rewards.confirm', data: { rewardId: reward.id } });
    kb.text(btn.text, btn.callback_data).row();
  }

  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'nav.rewards' });
  kb.text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, { titleKey: t('screens.rewards.title'), bodyLines: [t('screens.rewards.choose_reward')], inlineKeyboard: kb });
};

const renderRewardStoreEditorRoot = async (ctx: Context): Promise<void> => {
  const { user } = await ensureUserAndSettings(ctx);
  const rewards = await listRewardsForEdit(user.id);

  const bodyLines: string[] = [t('screens.rewards.edit_store_title'), ''];

  if (!rewards.length) {
    bodyLines.push(t('screens.rewards.edit_store_empty'));
  } else {
    bodyLines.push(t('screens.rewards.edit_store_list_header'));
    rewards.forEach((r) => {
      const status = r.is_active ? t('common.active') : t('common.inactive');
      bodyLines.push(`• ${r.title} — ${r.xp_cost} XP (${status})`);
    });
  }

  bodyLines.push('', t('screens.rewards.edit_store_hint'));

  const addBtn = await makeActionButton(ctx, { label: t('buttons.rewards_add'), action: 'rewards.add' });
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'nav.rewards' });

  const kb = new InlineKeyboard().text(addBtn.text, addBtn.callback_data).row().text(backBtn.text, backBtn.callback_data);

  // Also add per-reward edit buttons
  if (rewards.length) {
    kb.row();
    for (const r of rewards) {
      const btn = await makeActionButton(ctx, { label: `✏ ${r.title}`, action: 'rewards.edit_open', data: { rewardId: r.id } });
      kb.text(btn.text, btn.callback_data).row();
    }
  }

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

  await renderScreen(ctx, { titleKey: t('screens.rewards.edit_store_title'), bodyLines: lines, inlineKeyboard: kb });
};

const renderReportsMenu = async (ctx: Context): Promise<void> => {
  const kb = await buildReportsMenuKeyboard(ctx);
  await renderScreen(ctx, { titleKey: 'screens.reports.title', bodyLines: ['screens.reports.choose_category'], inlineKeyboard: kb });
};

const renderXpSummary = async (ctx: Context): Promise<void> => {
  const { user } = await ensureUserAndSettings(ctx);
  const summary = await getXpSummary(user.id);

  const lines = [
    t('screens.reports.xp_earned', { earned: summary.earned }),
    t('screens.reports.xp_spent', { spent: summary.spent }),
    t('screens.reports.xp_net', { net: summary.net })
  ];

  const kb = await buildReportsMenuKeyboard(ctx);
  await renderScreen(ctx, { titleKey: 'screens.reports.xp_title', bodyLines: lines, inlineKeyboard: kb });
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

  const amBtn = await makeActionButton(ctx, { label: t('buttons.am'), action: 'dr.time_set_ampm', data: { reportDayId, itemId: item.id, ampm: 'AM' } });
  const pmBtn = await makeActionButton(ctx, { label: t('buttons.pm'), action: 'dr.time_set_ampm', data: { reportDayId, itemId: item.id, ampm: 'PM' } });
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
    await renderScreen(ctx, {
      titleKey: t('screens.daily_report.title'),
      bodyLines: isLockedMessageLines(reportDay),
      inlineKeyboard: await buildDailyReportKeyboard(ctx, reportDay)
    });
    return;
  }

  if (item.item_type === 'time_hhmm') {
    const initialDraft = { reportDayId: reportDay.id, itemId: item.id, hour12: 10, minuteTens: 0, minuteOnes: 0, ampm: 'PM' as const };
    userStates.set(telegramId, { ...existing, awaitingValue: { reportDayId: reportDay.id, itemId: item.id }, timeDraft: initialDraft });
    await renderTimePicker(ctx, reportDay.id, item, initialDraft);
    return;
  }

  if (item.item_type === 'number' || item.item_type === 'duration_minutes') {
    const draftValue = 0;
    userStates.set(telegramId, { ...existing, awaitingValue: { reportDayId: reportDay.id, itemId: item.id }, numericDraft: { reportDayId: reportDay.id, itemId: item.id, value: draftValue } });
    await renderNumericInput(ctx, reportDay.id, item, draftValue);
    return;
  }

  userStates.set(telegramId, { ...existing, awaitingValue: { reportDayId: reportDay.id, itemId: item.id } });

  const skipBtn = await makeActionButton(ctx, { label: t('buttons.skip'), action: 'dr.skip', data: { reportDayId: reportDay.id, itemId: item.id } });
  const cancelBtn = await makeActionButton(ctx, { label: t('buttons.cancel'), action: 'dr.menu', data: { reportDayId: reportDay.id } });

  const kb = new InlineKeyboard().text(skipBtn.text, skipBtn.callback_data).row().text(cancelBtn.text, cancelBtn.callback_data);

  await renderScreen(ctx, { titleKey: t('screens.daily_report.title'), bodyLines: [t('screens.daily_report.set_value_for', { label: item.label }), t('screens.daily_report.send_value_as_text')], inlineKeyboard: kb });
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
  const templateName = template?.title ?? t('screens.templates.default_title');

  const bodyLines: string[] = [
    t('screens.daily_report.root_header', { date: reportDay.local_date }),
    t('screens.daily_report.template_line', { template: templateName }),
    t('screens.daily_report.completion_line', { completed, total }),
    ''
  ];

  if (reportDay.locked) {
    bodyLines.push(t('screens.daily_report.today_locked_note'), '');
  }

  // After 00:00 Tehran time, show "Fill Yesterday" button only if yesterday has unfilled/unskipped items.
  // We treat server time via user timezone formatting; parse HH from "HH:MM".
  const hourNow = Number((local.time || '00:00').split(':')[0] ?? 0);
  const showYesterdayCheck = hourNow >= 0; // always true, but kept for clarity

  const kb = await buildDailyReportKeyboard(ctx, reportDay);

  if (showYesterdayCheck) {
    // Compute yesterday date (YYYY-MM-DD). We do simple date arithmetic in UTC and accept that formatLocalTime is the main source.
    const [y, m, d] = targetDate.split('-').map((x) => Number(x));
    if (Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d)) {
      const dt = new Date(Date.UTC(y, m - 1, d));
      dt.setUTCDate(dt.getUTCDate() - 1);
      const y2 = dt.getUTCFullYear();
      const m2 = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const d2 = String(dt.getUTCDate()).padStart(2, '0');
      const yesterday = `${y2}-${m2}-${d2}`;

      try {
        const yd = await getReportDayByDate({ userId: user.id, templateId: template.id, localDate: yesterday });
        if (yd) {
          const ydItems = await ensureDefaultItems(user.id);
          const ydStatuses = await listCompletionStatus(yd.id, ydItems);
          const hasPending = ydStatuses.some((s) => !s.filled && !s.skipped);
          if (hasPending) {
            const yBtn = await makeActionButton(ctx, { label: t('buttons.dr_fill_yesterday'), action: 'dr.open_date', data: { localDate: yesterday } });
            kb.row().text(yBtn.text, yBtn.callback_data);
          }
        }
      } catch (e) {
        console.warn({ scope: 'daily_report', event: 'yesterday_check_failed', e });
      }
    }
  }

  await renderScreen(ctx, { titleKey: t('screens.daily_report.title'), bodyLines, inlineKeyboard: kb });
};

const renderDailyStatusWithFilter = async (ctx: Context, reportDayId: string, filter: 'all' | 'not_filled' | 'filled' = 'all'): Promise<void> => {
  const { user } = await ensureUserAndSettings(ctx);

  // Find reportDay for id (use range for safety; service provides getReportDayByDate but not by id).
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

  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'dr.menu' });
  kb.text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, { titleKey: t('screens.daily_report.title'), bodyLines: lines, inlineKeyboard: kb });
};

const slugifyItemKey = (input: string): string =>
  input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

const generateUniqueItemKey = async (templateId: string, label: string): Promise<string> => {
  const base = slugifyItemKey(label) || 'item';
  const existing = await listAllItems(templateId);
  const existingKeys = new Set(existing.map((i) => i.item_key));
  let candidate = base;
  let counter = 2;
  while (existingKeys.has(candidate)) {
    candidate = `${base}_${counter}`;
    counter += 1;
  }
  return candidate;
};

const buildTypeKeyboard = async (ctx: Context, params: { templateId: string; itemId?: string; backAction?: string; backData?: Record<string, unknown> }) => {
  const kb = new InlineKeyboard();
  const types = ['boolean', 'number', 'time_hhmm', 'duration_minutes', 'text'];
  for (const type of types) {
    const btn = await makeActionButton(ctx, { label: type, action: 'dr.template_item_select_type', data: { templateId: params.templateId, itemId: params.itemId, itemType: type } });
    kb.text(btn.text, btn.callback_data).row();
  }
  const backAction = params.backAction ?? 'dr.template_edit';
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: backAction, data: params.backData ?? { templateId: params.templateId } });
  kb.text(backBtn.text, backBtn.callback_data);
  return kb;
};

const buildCategoryKeyboard = async (ctx: Context, params: { templateId: string; itemId?: string; backAction?: string; backData?: Record<string, unknown> }) => {
  const categories = ['sleep', 'routine', 'study', 'tasks', 'other', 'none'];
  const kb = new InlineKeyboard();
  for (const category of categories) {
    const btn = await makeActionButton(ctx, {
      label: category,
      action: 'dr.template_item_select_category',
      data: { templateId: params.templateId, itemId: params.itemId, category }
    });
    kb.text(btn.text, btn.callback_data).row();
  }
  const backAction = params.backAction ?? 'dr.template_edit';
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: backAction, data: params.backData ?? { templateId: params.templateId } });
  kb.text(backBtn.text, backBtn.callback_data);
  return kb;
};

const buildXpModeKeyboard = async (ctx: Context, params: { templateId: string; itemId?: string; backAction?: string; backData?: Record<string, unknown> }) => {
  const modes = [
    { key: 'none', label: t('screens.daily_report.ask_xp_mode_none') ?? 'No XP' },
    { key: 'fixed', label: t('screens.daily_report.ask_xp_mode_fixed') ?? 'Fixed XP' },
    { key: 'time', label: t('screens.daily_report.ask_xp_mode_time') ?? 'Time-based (per minute)' }
  ];
  const kb = new InlineKeyboard();
  for (const mode of modes) {
    const btn = await makeActionButton(ctx, { label: mode.label, action: 'dr.template_item_select_xp_mode', data: { templateId: params.templateId, itemId: params.itemId, xpMode: mode.key } });
    kb.text(btn.text, btn.callback_data).row();
  }
  const backAction = params.backAction ?? 'dr.template_edit';
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: backAction, data: params.backData ?? { templateId: params.templateId } });
  kb.text(backBtn.text, backBtn.callback_data);
  return kb;
};

const promptLabelInput = async (ctx: Context, params: { templateId: string; backToItemId?: string }) => {
  const backAction = params.backToItemId ? 'dr.template_item_menu' : 'dr.template_edit';
  const backData = params.backToItemId ? { templateId: params.templateId, itemId: params.backToItemId } : { templateId: params.templateId };
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: backAction, data: backData });
  const kb = new InlineKeyboard().text(backBtn.text, backBtn.callback_data);
  await renderScreen(ctx, {
    titleKey: t('screens.daily_report.template_builder_title'),
    bodyLines: [t('screens.daily_report.ask_label')],
    inlineKeyboard: kb
  });
};

const promptKeyInput = async (ctx: Context, params: { templateId: string; itemId: string }) => {
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'dr.template_item_menu', data: { templateId: params.templateId, itemId: params.itemId } });
  const kb = new InlineKeyboard().text(backBtn.text, backBtn.callback_data);
  await renderScreen(ctx, {
    titleKey: t('screens.daily_report.template_builder_title'),
    bodyLines: [t('screens.daily_report.ask_key')],
    inlineKeyboard: kb
  });
};

const promptTypeSelection = async (ctx: Context, params: { templateId: string; itemId?: string; backToItem?: boolean }) => {
  const kb = await buildTypeKeyboard(ctx, {
    templateId: params.templateId,
    itemId: params.itemId,
    backAction: params.backToItem ? 'dr.template_item_menu' : 'dr.template_edit',
    backData: params.backToItem ? { templateId: params.templateId, itemId: params.itemId } : { templateId: params.templateId }
  });
  await renderScreen(ctx, {
    titleKey: t('screens.daily_report.template_builder_title'),
    bodyLines: [t('screens.daily_report.ask_type')],
    inlineKeyboard: kb
  });
};

const promptCategorySelection = async (ctx: Context, params: { templateId: string; itemId?: string; backToItem?: boolean }) => {
  const kb = await buildCategoryKeyboard(ctx, {
    templateId: params.templateId,
    itemId: params.itemId,
    backAction: params.backToItem ? 'dr.template_item_menu' : 'dr.template_edit',
    backData: params.backToItem ? { templateId: params.templateId, itemId: params.itemId } : { templateId: params.templateId }
  });
  await renderScreen(ctx, {
    titleKey: t('screens.daily_report.template_builder_title'),
    bodyLines: [t('screens.daily_report.ask_category')],
    inlineKeyboard: kb
  });
};

const promptXpModeSelection = async (ctx: Context, params: { templateId: string; itemId?: string; backToItem?: boolean }) => {
  const kb = await buildXpModeKeyboard(ctx, {
    templateId: params.templateId,
    itemId: params.itemId,
    backAction: params.backToItem ? 'dr.template_item_menu' : 'dr.template_edit',
    backData: params.backToItem ? { templateId: params.templateId, itemId: params.itemId } : { templateId: params.templateId }
  });
  await renderScreen(ctx, {
    titleKey: t('screens.daily_report.template_builder_title'),
    bodyLines: [t('screens.daily_report.ask_xp_mode')],
    inlineKeyboard: kb
  });
};

const promptXpValueInput = async (ctx: Context, params: { templateId: string; itemId?: string; backToItem?: boolean }) => {
  const backAction = params.backToItem ? 'dr.template_item_menu' : 'dr.template_edit';
  const backData = params.backToItem ? { templateId: params.templateId, itemId: params.itemId } : { templateId: params.templateId };
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: backAction, data: backData });
  const kb = new InlineKeyboard().text(backBtn.text, backBtn.callback_data);
  await renderScreen(ctx, {
    titleKey: t('screens.daily_report.template_builder_title'),
    bodyLines: [t('screens.daily_report.ask_xp_value')],
    inlineKeyboard: kb
  });
};

const renderTemplatesScreen = async (ctx: Context, flashLine?: string): Promise<void> => {
  const { user, settings } = await ensureUserAndSettings(ctx);
  await ensureDefaultTemplate(user.id);
  const templates = await listUserTemplates(user.id);
  const settingsJson = (settings.settings_json ?? {}) as { active_template_id?: string | null };
  const fallbackTemplateId = templates[0]?.id ?? null;
  const activeTemplateId = settingsJson.active_template_id ?? fallbackTemplateId;
  const resolvedActiveId = templates.some((tpl) => tpl.id === activeTemplateId) ? activeTemplateId : fallbackTemplateId;

  const lines: string[] = [t('screens.daily_report.templates_title')];
  if (flashLine) lines.push(flashLine);
  if (templates.length === 0) {
    lines.push(t('screens.daily_report.templates_empty'));
  } else {
    templates.forEach((tpl) => {
      const isActive = tpl.id === resolvedActiveId;
      const prefix = isActive ? '⭐' : '•';
      const title = tpl.title ?? t('screens.templates.default_title');
      lines.push(`${prefix} ${title} (${tpl.itemCount ?? 0} items)`);
    });
  }

  const kb = new InlineKeyboard();

  for (const tpl of templates) {
    const setActiveBtn = await makeActionButton(ctx, { label: t('buttons.tpl_set_active'), action: 'dr.template_set_active', data: { templateId: tpl.id } });
    const editBtn = await makeActionButton(ctx, { label: t('buttons.tpl_edit_form'), action: 'dr.template_edit', data: { templateId: tpl.id } });
    const moreBtn = await makeActionButton(ctx, { label: t('buttons.tpl_more'), action: 'dr.template_actions', data: { templateId: tpl.id } });
    kb.text(setActiveBtn.text, setActiveBtn.callback_data).text(editBtn.text, editBtn.callback_data).text(moreBtn.text, moreBtn.callback_data).row();
  }

  const newBtn = await makeActionButton(ctx, { label: t('buttons.dr_template_new'), action: 'dr.template_new' });
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'dr.menu' });

  kb.text(newBtn.text, newBtn.callback_data).row();
  kb.text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, { titleKey: t('screens.daily_report.templates_title'), bodyLines: lines, inlineKeyboard: kb });
};

const renderTemplateActions = async (ctx: Context, templateId: string): Promise<void> => {
  const { user } = await ensureUserAndSettings(ctx);
  const tpl = await getTemplateById(templateId);
  if (!tpl || tpl.user_id !== user.id) {
    await renderTemplatesScreen(ctx);
    return;
  }

  const items = await listAllItems(templateId);
  const lines: string[] = [
    t('screens.daily_report.template_action_title'),
    tpl.title ?? t('screens.templates.default_title'),
    t('screens.daily_report.template_details_items_line', { count: items.length })
  ];

  const kb = new InlineKeyboard();
  const editBtn = await makeActionButton(ctx, { label: t('buttons.tpl_actions_edit'), action: 'dr.template_edit', data: { templateId } });
  const dupBtn = await makeActionButton(ctx, { label: t('buttons.tpl_actions_duplicate'), action: 'dr.template_duplicate', data: { templateId } });
  const delBtn = await makeActionButton(ctx, { label: t('buttons.tpl_actions_delete'), action: 'dr.template_delete_confirm', data: { templateId } });
  const backBtn = await makeActionButton(ctx, { label: t('buttons.tpl_actions_back'), action: 'dr.templates' });

  kb.text(editBtn.text, editBtn.callback_data).row();
  kb.text(dupBtn.text, dupBtn.callback_data).row();
  kb.text(delBtn.text, delBtn.callback_data).row();
  kb.text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, { titleKey: t('screens.daily_report.templates_title'), bodyLines: lines, inlineKeyboard: kb });
};

const renderTemplateEdit = async (ctx: Context, templateId: string, flashLine?: string): Promise<void> => {
  const { user } = await ensureUserAndSettings(ctx);
  const tpl = await getTemplateById(templateId);
  if (!tpl || tpl.user_id !== user.id) {
    await renderTemplatesScreen(ctx);
    return;
  }
  const telegramId = String(ctx.from?.id ?? '');
  clearTemplateItemFlow(telegramId);

  const items = await listAllItems(templateId);

  const lines: string[] = [
    t('screens.daily_report.template_builder_title'),
    t('screens.daily_report.template_items_header', { title: tpl.title ?? t('screens.templates.default_title') }),
    t('screens.daily_report.template_items_count', { count: items.length })
  ];
  if (flashLine) lines.push(flashLine);
  if (items.length === 0) {
    lines.push(t('screens.daily_report.template_items_empty'));
  } else {
    items.forEach((item, idx) => {
      const statusIcon = item.enabled ? '✅' : '🚫';
      const xpVal = item.xp_value ?? 0;
      lines.push(`[${idx + 1}] ${statusIcon} ${item.label} (${item.item_type}, XP: ${xpVal})`);
    });
  }

  const kb = new InlineKeyboard();

  for (const [idx, item] of items.entries()) {
    const btn = await makeActionButton(ctx, { label: `[${idx + 1}] ${item.label}`, action: 'dr.template_item_menu', data: { templateId, itemId: item.id } });
    kb.text(btn.text, btn.callback_data).row();
  }

  const addBtn = await makeActionButton(ctx, { label: t('buttons.tpl_add_item'), action: 'dr.template_item_add', data: { templateId } });
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'dr.templates' });
  kb.text(addBtn.text, addBtn.callback_data).row();
  kb.text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, { titleKey: t('screens.daily_report.template_builder_title'), bodyLines: lines, inlineKeyboard: kb });
};

const renderTemplateItemMenu = async (ctx: Context, templateId: string, itemId: string, flashLine?: string): Promise<void> => {
  const { user } = await ensureUserAndSettings(ctx);
  const tpl = await getTemplateById(templateId);
  const item = await getItemById(itemId);
  if (!tpl || tpl.user_id !== user.id || !item || item.template_id !== tpl.id) {
    await renderTemplatesScreen(ctx);
    return;
  }

  const xpMode = item.xp_mode ?? 'none';
  const xpValue = item.xp_value ?? 0;
  const lines: string[] = [
    t('screens.daily_report.item_menu_title'),
    t('screens.daily_report.item_menu_summary', {
      label: item.label,
      type: item.item_type,
      category: item.category ?? '-',
      xpMode,
      xpValue,
      enabled: item.enabled ? t('common.active') : t('common.inactive')
    })
  ];
  if (flashLine) lines.push(flashLine);

  const kb = new InlineKeyboard();
  const editLabelBtn = await makeActionButton(ctx, { label: t('buttons.tpl_item_edit_label'), action: 'dr.template_item_edit_label', data: { templateId, itemId } });
  const editKeyBtn = await makeActionButton(ctx, { label: t('buttons.tpl_item_edit_key'), action: 'dr.template_item_edit_key', data: { templateId, itemId } });
  const editTypeBtn = await makeActionButton(ctx, { label: t('buttons.tpl_item_edit_type'), action: 'dr.template_item_edit_type', data: { templateId, itemId } });
  const editCategoryBtn = await makeActionButton(ctx, { label: t('buttons.tpl_item_edit_category'), action: 'dr.template_item_edit_category', data: { templateId, itemId } });
  const editXpBtn = await makeActionButton(ctx, { label: t('buttons.tpl_item_edit_xp'), action: 'dr.template_item_edit_xp', data: { templateId, itemId } });
  const toggleBtn = await makeActionButton(ctx, { label: t('buttons.tpl_item_toggle_enabled'), action: 'dr.template_item_toggle_enabled', data: { templateId, itemId } });
  const moveUpBtn = await makeActionButton(ctx, { label: t('buttons.tpl_item_move_up'), action: 'dr.template_item_move_up', data: { templateId, itemId } });
  const moveDownBtn = await makeActionButton(ctx, { label: t('buttons.tpl_item_move_down'), action: 'dr.template_item_move_down', data: { templateId, itemId } });
  const delBtn = await makeActionButton(ctx, { label: t('buttons.tpl_item_delete'), action: 'dr.template_item_delete_confirm', data: { templateId, itemId } });
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'dr.template_edit', data: { templateId } });

  kb.text(editLabelBtn.text, editLabelBtn.callback_data).text(editKeyBtn.text, editKeyBtn.callback_data).row();
  kb.text(editTypeBtn.text, editTypeBtn.callback_data).text(editCategoryBtn.text, editCategoryBtn.callback_data).row();
  kb.text(editXpBtn.text, editXpBtn.callback_data).row();
  kb.text(toggleBtn.text, toggleBtn.callback_data).row();
  kb.text(moveUpBtn.text, moveUpBtn.callback_data).text(moveDownBtn.text, moveDownBtn.callback_data).row();
  kb.text(delBtn.text, delBtn.callback_data).row();
  kb.text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, { titleKey: t('screens.daily_report.item_menu_title'), bodyLines: lines, inlineKeyboard: kb });
};

const renderTemplateItemDeleteConfirm = async (ctx: Context, templateId: string, itemId: string): Promise<void> => {
  const { user } = await ensureUserAndSettings(ctx);
  const tpl = await getTemplateById(templateId);
  const item = await getItemById(itemId);
  if (!tpl || tpl.user_id !== user.id || !item || item.template_id !== tpl.id) {
    await renderTemplatesScreen(ctx);
    return;
  }

  const lines: string[] = [t('screens.daily_report.item_delete_confirm')];
  const yesBtn = await makeActionButton(ctx, { label: t('buttons.tpl_yes'), action: 'dr.template_item_delete', data: { templateId, itemId } });
  const noBtn = await makeActionButton(ctx, { label: t('buttons.tpl_no'), action: 'dr.template_item_menu', data: { templateId, itemId } });
  const kb = new InlineKeyboard().text(yesBtn.text, yesBtn.callback_data).row().text(noBtn.text, noBtn.callback_data);

  await renderScreen(ctx, { titleKey: t('screens.daily_report.item_menu_title'), bodyLines: lines, inlineKeyboard: kb });
};

const renderTemplateDeleteConfirm = async (ctx: Context, templateId: string): Promise<void> => {
  const { user } = await ensureUserAndSettings(ctx);
  const tpl = await getTemplateById(templateId);
  if (!tpl || tpl.user_id !== user.id) {
    await renderTemplatesScreen(ctx);
    return;
  }

  const lines: string[] = [t('screens.daily_report.templates_title'), '', t('screens.daily_report.template_delete_confirm', { title: tpl.title ?? t('screens.templates.default_title') })];

  const confirmBtn = await makeActionButton(ctx, { label: t('buttons.dr_template_delete'), action: 'dr.template_delete', data: { templateId } });
  const backBtn = await makeActionButton(ctx, { label: t('buttons.tpl_actions_back'), action: 'dr.template_actions', data: { templateId } });

  const kb = new InlineKeyboard().text(confirmBtn.text, confirmBtn.callback_data).row().text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, { titleKey: t('screens.daily_report.templates_title'), bodyLines: lines, inlineKeyboard: kb });
};

const finalizeNewTemplateItem = async (ctx: Context, telegramId: string, flow: TemplateItemFlow): Promise<void> => {
  try {
    const items = await listAllItems(flow.templateId);
    const maxSort = items.reduce((max, item) => Math.max(max, item.sort_order ?? 0), 0);
    const sortOrder = (maxSort || items.length * 10) + 10;
    const label = flow.draft.label ?? t('screens.daily_report.template_new_title');
    const itemKey = flow.draft.itemKey ?? (await generateUniqueItemKey(flow.templateId, label));
    const itemType = flow.draft.itemType ?? 'text';
    const category = flow.draft.category && flow.draft.category !== 'none' ? flow.draft.category : null;
    const xpMode = flow.draft.xpMode && flow.draft.xpMode !== 'none' ? flow.draft.xpMode : null;
    const xpValue = xpMode ? flow.draft.xpValue ?? 0 : null;
    const optionsJson = xpMode === 'time' ? flow.draft.optionsJson ?? { per: 'minute' } : {};

    await upsertItem({
      templateId: flow.templateId,
      label,
      itemKey,
      itemType,
      category,
      xpMode,
      xpValue,
      optionsJson,
      sortOrder
    });
    clearTemplateItemFlow(telegramId);
    clearReportContextCache();
    await renderTemplateEdit(ctx, flow.templateId, t('screens.daily_report.item_saved'));
  } catch (error) {
    console.error({ scope: 'daily_report', event: 'template_item_finalize_failed', error, flow });
    clearTemplateItemFlow(telegramId);
    await renderTemplateEdit(ctx, flow.templateId);
  }
};

const renderHistory = async (ctx: Context, range: '7d' | '30d' = '7d'): Promise<void> => {
  const { user } = await ensureUserAndSettings(ctx);
  const days = await listRecentReportDays({ userId: user.id, range });

  const lines: string[] = [
    t('screens.daily_report.history_title'),
    t('screens.daily_report.history_range', { range: range === '7d' ? t('buttons.dr_history_7d') : t('buttons.dr_history_30d') }),
    ''
  ];

  if (!days.length) {
    lines.push(t('screens.daily_report.history_no_results'));
  } else {
    for (const entry of days) {
      const suffix = entry.day.locked ? ' (locked)' : '';
      lines.push(`• ${entry.day.local_date}${suffix}`);
    }
  }

  const kb = new InlineKeyboard();
  const range7Btn = await makeActionButton(ctx, { label: t('buttons.dr_history_7d'), action: 'dr.history_7d' });
  const range30Btn = await makeActionButton(ctx, { label: t('buttons.dr_history_30d'), action: 'dr.history_30d' });
  const backBtn = await makeActionButton(ctx, { label: t('buttons.back'), action: 'dr.menu' });

  kb.text(range7Btn.text, range7Btn.callback_data).text(range30Btn.text, range30Btn.callback_data).row();
  kb.text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, { titleKey: t('screens.daily_report.history_title'), bodyLines: lines, inlineKeyboard: kb });
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

const handleSaveValue = async (ctx: Context, text: string): Promise<void> => {
  if (!ctx.from) return;
  const stateKey = String(ctx.from.id);
  const state = userStates.get(stateKey);
  if (!state?.awaitingValue) return;

  const { reportDayId, itemId } = state.awaitingValue;
  const cached = [...reportContextCache.values()].find((v) => v.reportDay.id === reportDayId);

  const reportDay = cached?.reportDay ?? (await ensureReportContext(ctx)).reportDay;
  const items = cached?.items ?? (await ensureDefaultItems(reportDay.user_id));

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
  await renderScreen(ctx, { titleKey: 'screens.settings.title', bodyLines: ['screens.settings.choose_option'], inlineKeyboard: kb });
};

/* ===== Commands ===== */

bot.command('start', async (ctx: Context) => {
  await renderDashboard(ctx);
});

bot.command('home', async (ctx: Context) => {
  await renderDashboard(ctx);
});

bot.command('debug_inline', async (ctx: Context) => {
  const keyboard = new InlineKeyboard().text(t('buttons.debug_inline'), 'dbg:test');
  await ctx.reply(t('screens.debug_inline.title'), { reply_markup: keyboard });
});

bot.callbackQuery('dbg:test', async (ctx) => {
  await safeAnswerCallback(ctx, { text: t('screens.debug_inline.success') });
});

bot.hears(t('buttons.nav_dashboard'), renderDashboard);
bot.hears(t('buttons.nav_daily_report'), async (ctx: Context) => renderDailyReportRoot(ctx));
bot.hears(t('buttons.nav_reportcar'), renderReportcar);
bot.hears(t('buttons.nav_tasks'), renderTasks);
bot.hears(t('buttons.nav_todo'), renderTodo);
bot.hears(t('buttons.nav_planning'), renderPlanning);
bot.hears(t('buttons.nav_my_day'), renderMyDay);
bot.hears(t('buttons.nav_free_text'), renderFreeText);
bot.hears(t('buttons.nav_reminders'), renderReminders);
bot.hears(t('buttons.nav_rewards'), renderRewardCenter);
bot.hears(t('buttons.nav_reports'), renderReportsMenu);
bot.hears(t('buttons.nav_calendar'), renderCalendarEvents);
bot.hears(t('buttons.nav_settings'), renderSettingsRoot);
bot.hears(t('buttons.nav_ai'), renderAI);

/**
 * Tokenized callback handler
 */
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
      case 'dr.back':
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
        userStates.set(telegramId, { ...(userStates.get(telegramId) || {}), rewardEdit: { mode: 'create', step: 'title', draft: {} } });

        const cancelBtn = await makeActionButton(ctx, { label: t('buttons.cancel'), action: 'rewards.edit_root' });
        await renderScreen(ctx, { titleKey: t('screens.rewards.add_title'), bodyLines: [t('screens.rewards.ask_title')], inlineKeyboard: new InlineKeyboard().text(cancelBtn.text, cancelBtn.callback_data) });
        return;
      }

      case 'rewards.edit_open': {
        const rewardId = (payload as { data?: { rewardId?: string } }).data?.rewardId;
        if (!rewardId) {
          await renderRewardStoreEditorRoot(ctx);
          return;
        }
        const reward = await getRewardById(rewardId);
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

        const step = action === 'rewards.edit_title' ? 'title' : action === 'rewards.edit_description' ? 'description' : 'xp';
        const telegramId = String(ctx.from?.id ?? '');
        userStates.set(telegramId, { ...(userStates.get(telegramId) || {}), rewardEdit: { mode: 'edit', rewardId, step, draft: {} } });

        const cancelBtn = await makeActionButton(ctx, { label: t('buttons.cancel'), action: 'rewards.edit_open', data: { rewardId } });

        const prompt =
          step === 'title'
            ? t('screens.rewards.ask_new_title')
            : step === 'description'
              ? t('screens.rewards.ask_new_description')
              : t('screens.rewards.ask_new_xp');

        await renderScreen(ctx, { titleKey: t('screens.rewards.edit_title'), bodyLines: [prompt], inlineKeyboard: new InlineKeyboard().text(cancelBtn.text, cancelBtn.callback_data) });
        return;
      }

      case 'rewards.toggle_active': {
        const rewardId = (payload as { data?: { rewardId?: string } }).data?.rewardId;
        if (!rewardId) {
          await renderRewardStoreEditorRoot(ctx);
          return;
        }
        const reward = await getRewardById(rewardId);
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
        const reward = await getRewardById(rewardId);
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

      case 'dr.open_date': {
        const localDate = (payload as { data?: { localDate?: string } }).data?.localDate;
        if (!localDate) {
          await renderDailyReportRoot(ctx);
          return;
        }
        await renderDailyReportRoot(ctx, localDate);
        return;
      }

      case 'dr.status': {
        const data = (payload as { data?: { reportDayId?: string; filter?: 'all' | 'not_filled' | 'filled' } }).data;
        const reportDayId = data?.reportDayId;
        const filter = data?.filter ?? 'all';
        if (!reportDayId) {
          const { reportDay } = await ensureReportContext(ctx);
          await renderDailyStatusWithFilter(ctx, reportDay.id, filter);
          return;
        }
        await renderDailyStatusWithFilter(ctx, reportDayId, filter);
        return;
      }

      case 'dr.next': {
        const reportDayId = (payload as { data?: { reportDayId?: string } }).data?.reportDayId;

        const cached = reportDayId ? [...reportContextCache.values()].find((v) => v.reportDay.id === reportDayId) : null;
        const reportDay = cached?.reportDay ?? (await ensureReportContext(ctx)).reportDay;
        const items = cached?.items ?? (await ensureDefaultItems(reportDay.user_id));

        if (reportDay.locked) {
          await renderScreen(ctx, { titleKey: t('screens.daily_report.title'), bodyLines: isLockedMessageLines(reportDay), inlineKeyboard: await buildDailyReportKeyboard(ctx, reportDay) });
          return;
        }

        const statuses = await listCompletionStatus(reportDay.id, items);
        const next = statuses.find((s) => !s.filled && !s.skipped);
        if (!next) {
          await renderScreen(ctx, { titleKey: t('screens.daily_report.title'), bodyLines: [t('screens.daily_report.all_done')], inlineKeyboard: await buildDailyReportKeyboard(ctx, reportDay) });
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
        if (!reportDayId || !itemId) {
          await ctx.answerCallbackQuery({ text: t('errors.item_not_found'), show_alert: true });
          return;
        }

        const cached = [...reportContextCache.values()].find((v) => v.reportDay.id === reportDayId);
        const reportDay = cached?.reportDay ?? (await ensureReportContext(ctx)).reportDay;
        const items = cached?.items ?? (await ensureDefaultItems(reportDay.user_id));

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
        if (!reportDayId || !itemId) return;

        const telegramId = String(ctx.from?.id ?? '');
        const state = userStates.get(telegramId);
        const draft = state?.timeDraft;

        if (!draft || draft.reportDayId !== reportDayId || draft.itemId !== itemId) {
          await renderDailyReportRoot(ctx);
          return;
        }

        const nextDraft = {
          ...draft,
          hour12: data.hour12 ?? draft.hour12,
          minuteTens: data.minuteTens ?? draft.minuteTens,
          minuteOnes: data.minuteOnes ?? draft.minuteOnes,
          ampm: (data.ampm ?? draft.ampm) as 'AM' | 'PM'
        };

        userStates.set(telegramId, { ...(state || {}), timeDraft: nextDraft });

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
        await renderTimePicker(ctx, reportDayId, item, nextDraft);
        return;
      }

      case 'dr.time_save': {
        const data = (payload as { data?: { reportDayId?: string; itemId?: string } }).data;
        const reportDayId = data?.reportDayId;
        const itemId = data?.itemId;
        if (!reportDayId || !itemId) return;

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
        if (!reportDayId || !itemId) return;

        const telegramId = String(ctx.from?.id ?? '');
        const state = userStates.get(telegramId);
        if (!state?.numericDraft || state.numericDraft.reportDayId !== reportDayId || state.numericDraft.itemId !== itemId) {
          await renderDailyReportRoot(ctx);
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
        if (!reportDayId || !itemId) return;

        const telegramId = String(ctx.from?.id ?? '');
        const state = userStates.get(telegramId);
        const draft = state?.numericDraft;

        if (!draft || draft.reportDayId !== reportDayId || draft.itemId !== itemId) {
          await renderDailyReportRoot(ctx);
          return;
        }

        await handleSaveValue(ctx, String(draft.value));

        const updated = { ...(userStates.get(telegramId) || {}) };
        delete updated.numericDraft;
        userStates.set(telegramId, updated);
        return;
      }

      case 'dr.skip': {
        const data = (payload as { data?: { reportDayId?: string; itemId?: string } }).data;
        const reportDayId = data?.reportDayId;
        const itemId = data?.itemId;
        if (!reportDayId || !itemId) {
          await renderDailyReportRoot(ctx);
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

        await unlockReportDay({ reportDayId: reportDay.id, userId: reportDay.user_id });

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

      case 'dr.template_details':
      case 'dr.template_actions': {
        const templateId = (payload as { data?: { templateId?: string } }).data?.templateId;
        if (!templateId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        await renderTemplateActions(ctx, templateId);
        return;
      }

      case 'dr.template_edit': {
        const templateId = (payload as { data?: { templateId?: string } }).data?.templateId;
        if (!templateId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        await renderTemplateEdit(ctx, templateId);
        return;
      }

      case 'dr.template_set_active': {
        const templateId = (payload as { data?: { templateId?: string } }).data?.templateId;
        if (!templateId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        try {
          const { user: u } = await ensureUserAndSettings(ctx);
          const tpl = await getTemplateById(templateId);
          if (!tpl || tpl.user_id !== u.id) {
            await renderTemplatesScreen(ctx);
            return;
          }
          await setActiveTemplate({ userId: u.id, templateId });
          clearReportContextCache();
        } catch (error) {
          console.error({ scope: 'daily_report', event: 'template_set_active_failed', error, templateId });
        }
        await renderTemplatesScreen(ctx);
        return;
      }

      case 'dr.template_duplicate': {
        const templateId = (payload as { data?: { templateId?: string } }).data?.templateId;
        if (!templateId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        try {
          const { user: u } = await ensureUserAndSettings(ctx);
          const tpl = await getTemplateById(templateId);
          if (!tpl || tpl.user_id !== u.id) {
            await renderTemplatesScreen(ctx);
            return;
          }
          const newTitle = `Copy of ${tpl.title ?? t('screens.templates.default_title')}`;
          const duplicated = await duplicateTemplate({ userId: u.id, sourceTemplateId: templateId, newTitle });
          clearReportContextCache();
          await renderTemplateEdit(ctx, duplicated.id, t('screens.daily_report.templates_duplicate_success'));
          return;
        } catch (error) {
          console.error({ scope: 'daily_report', event: 'template_duplicate_failed', error, templateId });
        }
        await renderTemplatesScreen(ctx);
        return;
      }

      case 'dr.template_delete_confirm': {
        const templateId = (payload as { data?: { templateId?: string } }).data?.templateId;
        if (!templateId) {
          await renderTemplatesScreen(ctx);
          return;
        }
          await renderTemplateDeleteConfirm(ctx, templateId);
        return;
      }

      case 'dr.template_delete': {
        const templateId = (payload as { data?: { templateId?: string } }).data?.templateId;
        if (!templateId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        try {
          const { user: u, settings } = await ensureUserAndSettings(ctx);
          const tpl = await getTemplateById(templateId);
          if (!tpl || tpl.user_id !== u.id) {
            await renderTemplatesScreen(ctx);
            return;
          }

          const settingsJson = (settings.settings_json ?? {}) as { active_template_id?: string | null };
          const activeTemplateId = settingsJson.active_template_id ?? null;

          await deleteTemplate({ userId: u.id, templateId });
          clearReportContextCache();

          if (activeTemplateId === templateId) {
            const remaining = await listUserTemplates(u.id);
            if (remaining.length > 0) {
              await setActiveTemplate({ userId: u.id, templateId: remaining[0].id });
            } else {
              const fallback = await ensureDefaultTemplate(u.id);
              await setActiveTemplate({ userId: u.id, templateId: fallback.id });
            }
          }

          await renderTemplatesScreen(ctx, t('screens.daily_report.templates_delete_success'));
        } catch (error) {
          console.error({ scope: 'daily_report', event: 'template_delete_failed', error, templateId });
          await renderTemplatesScreen(ctx);
        }
        return;
      }

      case 'dr.template_new': {
        try {
          const { user: u } = await ensureUserAndSettings(ctx);
          const newTemplate = await createUserTemplate({ userId: u.id, title: t('screens.daily_report.template_new_title') });
          clearReportContextCache();
          await renderTemplateEdit(ctx, newTemplate.id);
          return;
        } catch (error) {
          console.error({ scope: 'daily_report', event: 'template_new_failed', error });
        }
        await renderTemplatesScreen(ctx);
        return;
      }

      case 'dr.template_item_menu': {
        const data = (payload as { data?: { templateId?: string; itemId?: string } }).data;
        if (!data?.templateId || !data.itemId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        await renderTemplateItemMenu(ctx, data.templateId, data.itemId);
        return;
      }

      case 'dr.template_item_add': {
        const templateId = (payload as { data?: { templateId?: string } }).data?.templateId;
        if (!templateId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        const { user: u } = await ensureUserAndSettings(ctx);
        const tpl = await getTemplateById(templateId);
        if (!tpl || tpl.user_id !== u.id) {
          await renderTemplatesScreen(ctx);
          return;
        }
        const telegramId = String(ctx.from?.id ?? '');
        clearTemplateItemFlow(telegramId);
        setTemplateItemFlow(telegramId, { mode: 'create', templateId, step: 'label', draft: {} });
        await promptLabelInput(ctx, { templateId });
        return;
      }

      case 'dr.template_item_edit_label': {
        const data = (payload as { data?: { templateId?: string; itemId?: string } }).data;
        if (!data?.templateId || !data.itemId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        const { user: u } = await ensureUserAndSettings(ctx);
        const item = await getItemById(data.itemId);
        const tpl = await getTemplateById(data.templateId);
        if (!item || !tpl || tpl.user_id !== u.id || item.template_id !== tpl.id) {
          await renderTemplatesScreen(ctx);
          return;
        }
        const telegramId = String(ctx.from?.id ?? '');
        clearTemplateItemFlow(telegramId);
        setTemplateItemFlow(telegramId, { mode: 'edit', templateId: data.templateId, itemId: data.itemId, step: 'label', draft: { label: item.label } });
        await promptLabelInput(ctx, { templateId: data.templateId, backToItemId: data.itemId });
        return;
      }

      case 'dr.template_item_edit_key': {
        const data = (payload as { data?: { templateId?: string; itemId?: string } }).data;
        if (!data?.templateId || !data.itemId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        const { user: u } = await ensureUserAndSettings(ctx);
        const item = await getItemById(data.itemId);
        const tpl = await getTemplateById(data.templateId);
        if (!item || !tpl || tpl.user_id !== u.id || item.template_id !== tpl.id) {
          await renderTemplatesScreen(ctx);
          return;
        }
        const telegramId = String(ctx.from?.id ?? '');
        clearTemplateItemFlow(telegramId);
        setTemplateItemFlow(telegramId, { mode: 'edit', templateId: data.templateId, itemId: data.itemId, step: 'key', draft: { itemKey: item.item_key } });
        await promptKeyInput(ctx, { templateId: data.templateId, itemId: data.itemId });
        return;
      }

      case 'dr.template_item_edit_type': {
        const data = (payload as { data?: { templateId?: string; itemId?: string } }).data;
        if (!data?.templateId || !data.itemId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        const { user: u } = await ensureUserAndSettings(ctx);
        const item = await getItemById(data.itemId);
        const tpl = await getTemplateById(data.templateId);
        if (!item || !tpl || tpl.user_id !== u.id || item.template_id !== tpl.id) {
          await renderTemplatesScreen(ctx);
          return;
        }
        const telegramId = String(ctx.from?.id ?? '');
        clearTemplateItemFlow(telegramId);
        setTemplateItemFlow(telegramId, {
          mode: 'edit',
          templateId: data.templateId,
          itemId: data.itemId,
          step: 'type',
          draft: { itemType: item.item_type }
        });
        await promptTypeSelection(ctx, { templateId: data.templateId, itemId: data.itemId, backToItem: true });
        return;
      }

      case 'dr.template_item_select_type': {
        const data = (payload as { data?: { templateId?: string; itemId?: string; itemType?: string } }).data;
        if (!data?.templateId || !data.itemType) {
          await renderTemplatesScreen(ctx);
          return;
        }
        const telegramId = String(ctx.from?.id ?? '');
        const state = userStates.get(telegramId)?.templateItemFlow;
        if (state && state.mode === 'create' && state.templateId === data.templateId && state.step === 'type') {
          setTemplateItemFlow(telegramId, { ...state, draft: { ...state.draft, itemType: data.itemType }, step: 'category' });
          await promptCategorySelection(ctx, { templateId: data.templateId });
          return;
        }
        if (data.itemId) {
          const { user: u } = await ensureUserAndSettings(ctx);
          const tpl = await getTemplateById(data.templateId);
          const item = await getItemById(data.itemId);
          if (!tpl || tpl.user_id !== u.id || !item || item.template_id !== tpl.id) {
            await renderTemplatesScreen(ctx);
            return;
          }
          await updateItem(data.itemId, { item_type: data.itemType });
          clearTemplateItemFlow(telegramId);
          clearReportContextCache();
          await renderTemplateItemMenu(ctx, data.templateId, data.itemId, t('screens.daily_report.item_saved'));
          return;
        }
        await renderTemplateEdit(ctx, data.templateId);
        return;
      }

      case 'dr.template_item_edit_category': {
        const data = (payload as { data?: { templateId?: string; itemId?: string } }).data;
        if (!data?.templateId || !data.itemId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        const { user: u } = await ensureUserAndSettings(ctx);
        const tpl = await getTemplateById(data.templateId);
        const item = await getItemById(data.itemId);
        if (!tpl || tpl.user_id !== u.id || !item || item.template_id !== tpl.id) {
          await renderTemplatesScreen(ctx);
          return;
        }
        await promptCategorySelection(ctx, { templateId: data.templateId, itemId: data.itemId, backToItem: true });
        return;
      }

      case 'dr.template_item_select_category': {
        const data = (payload as { data?: { templateId?: string; itemId?: string; category?: string } }).data;
        if (!data?.templateId || !data.category) {
          await renderTemplatesScreen(ctx);
          return;
        }
        const telegramId = String(ctx.from?.id ?? '');
        const state = userStates.get(telegramId)?.templateItemFlow;
        if (state && state.mode === 'create' && state.templateId === data.templateId) {
          const category = data.category === 'none' ? null : data.category;
          setTemplateItemFlow(telegramId, { ...state, draft: { ...state.draft, category }, step: 'xp_mode' });
          await promptXpModeSelection(ctx, { templateId: data.templateId });
          return;
        }
        if (data.itemId) {
          const { user: u } = await ensureUserAndSettings(ctx);
          const tpl = await getTemplateById(data.templateId);
          const item = await getItemById(data.itemId);
          if (!tpl || tpl.user_id !== u.id || !item || item.template_id !== tpl.id) {
            await renderTemplatesScreen(ctx);
            return;
          }
          const category = data.category === 'none' ? null : data.category;
          await updateItem(data.itemId, { category });
          clearTemplateItemFlow(telegramId);
          clearReportContextCache();
          await renderTemplateItemMenu(ctx, data.templateId, data.itemId, t('screens.daily_report.item_saved'));
          return;
        }
        await renderTemplateEdit(ctx, data.templateId);
        return;
      }

      case 'dr.template_item_edit_xp': {
        const data = (payload as { data?: { templateId?: string; itemId?: string } }).data;
        if (!data?.templateId || !data.itemId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        const { user: u } = await ensureUserAndSettings(ctx);
        const tpl = await getTemplateById(data.templateId);
        const item = await getItemById(data.itemId);
        if (!tpl || tpl.user_id !== u.id || !item || item.template_id !== tpl.id) {
          await renderTemplatesScreen(ctx);
          return;
        }
        const telegramId = String(ctx.from?.id ?? '');
        clearTemplateItemFlow(telegramId);
        setTemplateItemFlow(telegramId, {
          mode: 'edit',
          templateId: data.templateId,
          itemId: data.itemId,
          step: 'xp_mode',
          draft: { xpMode: item.xp_mode ?? 'none', xpValue: item.xp_value ?? 0, optionsJson: item.options_json ?? {} }
        });
        await promptXpModeSelection(ctx, { templateId: data.templateId, itemId: data.itemId, backToItem: true });
        return;
      }

      case 'dr.template_item_select_xp_mode': {
        const data = (payload as { data?: { templateId?: string; itemId?: string; xpMode?: string } }).data;
        if (!data?.templateId || !data.xpMode) {
          await renderTemplatesScreen(ctx);
          return;
        }
        const telegramId = String(ctx.from?.id ?? '');
        const state = userStates.get(telegramId)?.templateItemFlow;
        const chosenMode = data.xpMode;
        const nextDraft = { ...(state?.draft ?? {}), xpMode: chosenMode, optionsJson: chosenMode === 'time' ? { per: 'minute' } : {} };

        if (state && state.mode === 'create' && state.templateId === data.templateId) {
          if (chosenMode === 'none') {
            setTemplateItemFlow(telegramId, { ...state, draft: { ...nextDraft, xpValue: null }, step: 'xp_mode' });
            await finalizeNewTemplateItem(ctx, telegramId, { ...state, draft: { ...nextDraft, xpValue: null } });
            return;
          }
          setTemplateItemFlow(telegramId, { ...state, draft: nextDraft, step: 'xp_value' });
          await promptXpValueInput(ctx, { templateId: data.templateId });
          return;
        }

        if (data.itemId) {
          const { user: u } = await ensureUserAndSettings(ctx);
          const tpl = await getTemplateById(data.templateId);
          const item = await getItemById(data.itemId);
          if (!tpl || tpl.user_id !== u.id || !item || item.template_id !== tpl.id) {
            await renderTemplatesScreen(ctx);
            return;
          }

          if (chosenMode === 'none') {
            await updateItem(data.itemId, { xp_mode: null, xp_value: null, options_json: {} });
            clearTemplateItemFlow(telegramId);
            clearReportContextCache();
            await renderTemplateItemMenu(ctx, data.templateId, data.itemId, t('screens.daily_report.item_saved'));
            return;
          }

          setTemplateItemFlow(telegramId, {
            mode: 'edit',
            templateId: data.templateId,
            itemId: data.itemId,
            step: 'xp_value',
            draft: nextDraft
          });
          await promptXpValueInput(ctx, { templateId: data.templateId, itemId: data.itemId, backToItem: true });
          return;
        }
        await renderTemplateEdit(ctx, data.templateId);
        return;
      }

      case 'dr.template_item_toggle_enabled': {
        const data = (payload as { data?: { templateId?: string; itemId?: string } }).data;
        if (!data?.templateId || !data.itemId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        try {
          const { user: u } = await ensureUserAndSettings(ctx);
          const tpl = await getTemplateById(data.templateId);
          const item = await getItemById(data.itemId);
          if (!tpl || tpl.user_id !== u.id || !item || item.template_id !== tpl.id) {
            await renderTemplatesScreen(ctx);
            return;
          }
          await setItemEnabled(item.id, !item.enabled);
          clearReportContextCache();
          await renderTemplateItemMenu(ctx, data.templateId, data.itemId, t('screens.daily_report.item_saved'));
        } catch (error) {
          console.error({ scope: 'daily_report', event: 'template_item_toggle_failed', error, data });
          await renderTemplateEdit(ctx, data.templateId);
        }
        return;
      }

      case 'dr.template_item_move_up':
      case 'dr.template_item_move_down': {
        const data = (payload as { data?: { templateId?: string; itemId?: string } }).data;
        if (!data?.templateId || !data.itemId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        const direction = action === 'dr.template_item_move_up' ? 'up' : 'down';
        try {
          const { user: u } = await ensureUserAndSettings(ctx);
          const tpl = await getTemplateById(data.templateId);
          const item = await getItemById(data.itemId);
          if (!tpl || tpl.user_id !== u.id || !item || item.template_id !== tpl.id) {
            await renderTemplatesScreen(ctx);
            return;
          }
          await moveItem(data.templateId, data.itemId, direction);
          clearReportContextCache();
        } catch (error) {
          console.error({ scope: 'daily_report', event: 'template_item_move_failed', error, data, direction });
        }
        await renderTemplateEdit(ctx, data.templateId);
        return;
      }

      case 'dr.template_item_delete_confirm': {
        const data = (payload as { data?: { templateId?: string; itemId?: string } }).data;
        if (!data?.templateId || !data.itemId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        await renderTemplateItemDeleteConfirm(ctx, data.templateId, data.itemId);
        return;
      }

      case 'dr.template_item_delete': {
        const data = (payload as { data?: { templateId?: string; itemId?: string } }).data;
        if (!data?.templateId || !data.itemId) {
          await renderTemplatesScreen(ctx);
          return;
        }
        try {
          const { user: u } = await ensureUserAndSettings(ctx);
          const tpl = await getTemplateById(data.templateId);
          const item = await getItemById(data.itemId);
          if (!tpl || tpl.user_id !== u.id || !item || item.template_id !== tpl.id) {
            await renderTemplatesScreen(ctx);
            return;
          }
          await deleteItem(data.itemId);
          clearReportContextCache();
          await renderTemplateEdit(ctx, data.templateId, t('screens.daily_report.item_deleted'));
        } catch (error) {
          console.error({ scope: 'daily_report', event: 'template_item_delete_failed', error, data });
          await renderTemplateEdit(ctx, data.templateId);
        }
        return;
      }

      case 'dr.history': {
        await renderHistory(ctx, '7d');
        return;
      }

      case 'dr.history_7d': {
        await renderHistory(ctx, '7d');
        return;
      }

      case 'dr.history_30d': {
        await renderHistory(ctx, '30d');
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

    const label = state.settingsRoutine.label ?? t('screens.settings.default_routine_label');
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

  const templateFlow = state.templateItemFlow;
  if (templateFlow) {
    const telegramId = stateKey;
    try {
      if (templateFlow.step === 'label') {
        if (!text) {
          await promptLabelInput(ctx, { templateId: templateFlow.templateId, backToItemId: templateFlow.itemId });
          return;
        }
        if (templateFlow.mode === 'create') {
          const itemKey = await generateUniqueItemKey(templateFlow.templateId, text);
          setTemplateItemFlow(telegramId, { ...templateFlow, draft: { ...templateFlow.draft, label: text, itemKey }, step: 'type' });
          await promptTypeSelection(ctx, { templateId: templateFlow.templateId });
          return;
        }
        if (!templateFlow.itemId) {
          clearTemplateItemFlow(telegramId);
          await renderTemplatesScreen(ctx);
          return;
        }
        await updateItem(templateFlow.itemId, { label: text });
        clearTemplateItemFlow(telegramId);
        clearReportContextCache();
        await renderTemplateItemMenu(ctx, templateFlow.templateId, templateFlow.itemId, t('screens.daily_report.item_saved'));
        return;
      }

      if (templateFlow.step === 'key') {
        const cleanedKey = slugifyItemKey(text);
        if (!cleanedKey) {
          await promptKeyInput(ctx, { templateId: templateFlow.templateId, itemId: templateFlow.itemId as string });
          return;
        }
        const items = await listAllItems(templateFlow.templateId);
        const duplicate = items.some((i) => i.item_key === cleanedKey && i.id !== templateFlow.itemId);
        if (duplicate) {
          await ctx.reply(t('screens.daily_report.duplicate_key'));
          return;
        }
        if (!templateFlow.itemId) {
          clearTemplateItemFlow(telegramId);
          await renderTemplateEdit(ctx, templateFlow.templateId);
          return;
        }
        await updateItem(templateFlow.itemId, { item_key: cleanedKey });
        clearTemplateItemFlow(telegramId);
        clearReportContextCache();
        await renderTemplateItemMenu(ctx, templateFlow.templateId, templateFlow.itemId, t('screens.daily_report.item_saved'));
        return;
      }

      if (templateFlow.step === 'xp_value') {
        const xpVal = Number(text);
        if (!Number.isInteger(xpVal)) {
          await ctx.reply(t('screens.daily_report.invalid_number'));
          return;
        }
        if (templateFlow.mode === 'create') {
          const draft = { ...templateFlow.draft, xpValue: xpVal };
          setTemplateItemFlow(telegramId, { ...templateFlow, draft, step: 'xp_value' });
          await finalizeNewTemplateItem(ctx, telegramId, { ...templateFlow, draft });
          return;
        }
        if (!templateFlow.itemId) {
          clearTemplateItemFlow(telegramId);
          await renderTemplateEdit(ctx, templateFlow.templateId);
          return;
        }
        const xpMode = templateFlow.draft.xpMode && templateFlow.draft.xpMode !== 'none' ? templateFlow.draft.xpMode : null;
        const xpValue = xpMode ? xpVal : null;
        const optionsJson = xpMode === 'time' ? templateFlow.draft.optionsJson ?? { per: 'minute' } : {};
        await updateItem(templateFlow.itemId, { xp_mode: xpMode, xp_value: xpValue, options_json: optionsJson });
        clearTemplateItemFlow(telegramId);
        clearReportContextCache();
        await renderTemplateItemMenu(ctx, templateFlow.templateId, templateFlow.itemId, t('screens.daily_report.item_saved'));
        return;
      }
    } catch (error) {
      console.error({ scope: 'daily_report', event: 'template_flow_error', error, templateFlow });
      clearTemplateItemFlow(telegramId);
      await ctx.reply(t('errors.unexpected'));
      return;
    }
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
