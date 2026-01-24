import { Keyboard } from 'grammy';
import type { Context } from 'grammy';
import type { ReplyKeyboardMarkup } from 'grammy/types';
import { t } from '../i18n';
import { labels } from './labels';

export const buildMainMenuKeyboard = (options: { aiEnabled: boolean }): ReplyKeyboardMarkup => {
  const kb = new Keyboard()
    .text(t('buttons.nav_dashboard'))
    .row()
    .text(t('buttons.nav_daily_report'))
    .text(t('buttons.nav_reportcar'))
    .row()
    .text(labels.nav.notes())
    .row()
    .text(t('buttons.nav_tasks'))
    .text(t('buttons.nav_todo'))
    .row()
    .text(t('buttons.nav_planning'))
    .text(t('buttons.nav_my_day'))
    .row()
    .text(labels.nav.freeText())
    .text(labels.nav.reminders())
    .row()
    .text(t('buttons.nav_rewards'))
    .text(t('buttons.nav_reports'))
    .row()
    .text(t('buttons.nav_calendar'))
    .text(t('buttons.nav_settings'));

  if (options.aiEnabled) {
    kb.row().text(t('buttons.nav_ai'));
  }

  return kb.resized();
};

export const aiEnabledForUser = (settingsJson: Record<string, unknown> | null | undefined): boolean =>
  (settingsJson as { ai?: { enabled?: boolean } } | null | undefined)?.ai?.enabled !== false;

export const sendMainMenu = async (ctx: Context, aiEnabled: boolean): Promise<void> => {
  const keyboard = buildMainMenuKeyboard({ aiEnabled });
  await ctx.reply(t('screens.main_menu.title'), { reply_markup: keyboard });
};
