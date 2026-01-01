import { InlineKeyboard } from 'grammy';
import type { Context } from 'grammy';
import { ensureUser } from '../services/users';
import { getOrCreateUserSettings } from '../services/userSettings';

export type RenderScreenParams = {
  titleKey: string;
  bodyLines: string[];
  inlineKeyboard?: InlineKeyboard;
};

export const ensureUserAndSettings = async (ctx: Context) => {
  if (!ctx.from) throw new Error('User not found in context');
  const telegramId = String(ctx.from.id);
  const username = ctx.from.username ?? null;
  const user = await ensureUser({ telegramId, username });
  const settings = await getOrCreateUserSettings(user.id);
  return { user, settings };
};

export const renderScreen = async (ctx: Context, params: RenderScreenParams): Promise<void> => {
  await ensureUserAndSettings(ctx);
  const text = [params.titleKey, '', ...params.bodyLines].join('\n');
  const replyMarkup = params.inlineKeyboard;

  if (ctx.callbackQuery?.message) {
    const { chat, message_id: messageId } = ctx.callbackQuery.message;
    await ctx.api.editMessageText(chat.id, messageId, text, {
      reply_markup: replyMarkup
    });
    return;
  }

  await ctx.reply(text, {
    reply_markup: replyMarkup
  });
};
