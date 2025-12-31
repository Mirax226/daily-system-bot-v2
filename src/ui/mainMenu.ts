import { Keyboard } from 'grammy';

const ROWS = [
  ['🏠 Dashboard', '🧾 Daily Report'],
  ['📘 Reportcar', '✅ Tasks / Routines'],
  ['📋 To-Do List', '🗓 Planning'],
  ['🧭 My Day', '📝 Free Text'],
  ['⏰ Reminders', '🎁 Reward Center'],
  ['📊 Reports', '📅 Calendar & Events'],
  ['⚙️ Settings']
];

export const buildMainMenuKeyboard = (aiEnabled: boolean): Keyboard => {
  const kb = new Keyboard();
  ROWS.forEach((row) => {
    kb.text(row[0]);
    if (row[1]) kb.text(row[1]);
    kb.row();
  });
  if (aiEnabled) {
    kb.text('🤖 AI').row();
  }
  return kb.resized();
};

export const aiEnabledForUser = (settingsJson?: Record<string, unknown>) =>
  Boolean((settingsJson as { ai?: { enabled?: boolean } } | undefined)?.ai?.enabled);

export const sendMainMenu = async (ctx: { reply: Function }, aiEnabled: boolean): Promise<void> => {
  const keyboard = buildMainMenuKeyboard(aiEnabled);
  await ctx.reply('Main menu ready. Use the buttons below.', { reply_markup: keyboard });
};
