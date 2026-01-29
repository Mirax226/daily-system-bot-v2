import { InlineKeyboard } from 'grammy';
import type { Context } from 'grammy';
import { labels } from './labels';
import { makeActionButton } from './inlineButtons';
import { renderScreen } from './renderScreen';

type InlineButton = { text: string; callback_data: string };

export const renderSettingsScreen = async (
  ctx: Context,
  params: { emojiEnabled: boolean; extraButtons?: InlineButton[] }
): Promise<void> => {
  const toggleBtn = await makeActionButton(ctx, {
    label: labels.settingsButtons.emojiToggle(params.emojiEnabled),
    action: 'settings.emoji_toggle'
  });
  const backBtn = await makeActionButton(ctx, {
    label: labels.settingsButtons.back(),
    action: 'nav.dashboard'
  });

  const kb = new InlineKeyboard().text(toggleBtn.text, toggleBtn.callback_data).row();
  for (const btn of params.extraButtons ?? []) {
    kb.text(btn.text, btn.callback_data).row();
  }
  kb.text(backBtn.text, backBtn.callback_data);

  await renderScreen(ctx, {
    title: labels.settings.title(),
    bodyLines: ['screens.settings.choose_option'],
    inlineKeyboard: kb
  });
};
