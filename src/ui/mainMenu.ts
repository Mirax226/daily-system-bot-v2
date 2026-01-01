import { Keyboard } from 'grammy';
import type { Context } from 'grammy';
import type { ReplyKeyboardMarkup } from 'grammy/types';

export const buildMainMenuKeyboard = (options: { aiEnabled: boolean }): ReplyKeyboardMarkup => {
  const kb = new Keyboard()
    .text('🏠 Dashboard')
    .row()
    .text('🧾 Daily Report')
    .text('📘 Reportcar')
    .row()
    .text('✅ Tasks / Routines')
    .text('📋 To-Do List')
    .row()
    .text('🗓 Planning')
    .text('🧭 My Day')
    .row()
    .text('📝 Free Text')
    .text('⏰ Reminders')
    .row()
    .text('🎁 Reward Center')
    .text('📊 Reports')
    .row()
    .text('📅 Calendar & Events')
    .text('⚙️ Settings');

  if (options.aiEnabled) {
    kb.row().text('🤖 AI');
  }

  return kb.resized();
};

export const aiEnabledForUser = (settingsJson: Record<string, unknown> | null | undefined): boolean =>
  (settingsJson as { ai?: { enabled?: boolean } } | null | undefined)?.ai?.enabled !== false;

export const sendMainMenu = async (ctx: Context, aiEnabled: boolean): Promise<void> => {
  const keyboard = buildMainMenuKeyboard({ aiEnabled });
  await ctx.reply('Main menu', { reply_markup: keyboard });
};
