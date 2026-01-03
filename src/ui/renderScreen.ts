import { InlineKeyboard } from 'grammy';
import type { Context } from 'grammy';
import { ensureUser } from '../services/users';
import { getOrCreateUserSettings } from '../services/userSettings';
import { t } from '../i18n';

export type RenderScreenParams = {
  titleKey?: string;
  title?: string;
  bodyLines?: string[];
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

  const resolvedTitle =
    params.title ??
    (params.titleKey && (params.titleKey.startsWith('screens.') || params.titleKey.startsWith('errors.'))
      ? t(params.titleKey)
      : params.titleKey) ??
    '';

  const resolvedLines =
    params.bodyLines?.map((line) => {
      if (typeof line === 'string' && (line.startsWith('screens.') || line.startsWith('errors.'))) {
        return t(line);
      }
      return line;
    }) ?? [];

  const text = [resolvedTitle, '', ...resolvedLines].join('\n');
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
