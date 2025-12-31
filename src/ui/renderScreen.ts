import { InlineKeyboard, GrammyError } from 'grammy';
import type { Context } from 'grammy';
import { getSupabaseClient } from '../db';
import { config } from '../config';
import { isTelemetryEnabled, logTelemetryEvent } from '../services/telemetry';
import { ensureUser } from '../services/users';
import { getOrCreateUserSettings } from '../services/userSettings';
import { aiEnabledForUser, buildMainMenuKeyboard } from './mainMenu';

export type RenderScreenParams = {
  titleKey: string;
  bodyLines: string[];
  inlineKeyboard?: InlineKeyboard;
};

const telemetryEnabledForUser = (userSettingsJson?: Record<string, unknown>) => isTelemetryEnabled(userSettingsJson);

export const ensureUserAndSettings = async (ctx: Context) => {
  if (!ctx.from) throw new Error('User not found in context');
  const telegramId = String(ctx.from.id);
  const username = ctx.from.username ?? null;
  const user = await ensureUser({ telegramId, username });
  const settings = await getOrCreateUserSettings(user.id);
  return { user, settings };
};

export const renderScreen = async (ctx: Context, params: RenderScreenParams): Promise<void> => {
  const { user, settings } = await ensureUserAndSettings(ctx);
  const chatId = ctx.chat?.id ?? (user.home_chat_id ? Number(user.home_chat_id) : undefined) ?? ctx.from?.id;
  if (!chatId) throw new Error('Chat id missing for renderScreen');

  const text = [params.titleKey, '', ...params.bodyLines].join('\n');
  const mainMenu = buildMainMenuKeyboard(aiEnabledForUser(user.settings_json as Record<string, unknown>));

  const canEdit = Boolean(user.home_chat_id && user.home_message_id);
  if (canEdit) {
    try {
      await ctx.api.editMessageText(Number(user.home_chat_id), Number(user.home_message_id), text, {
        reply_markup: params.inlineKeyboard
      });
      await logTelemetryEvent({
        userId: user.id,
        traceId: (ctx as unknown as { traceId?: string }).traceId ?? '',
        eventName: 'screen_render',
        screen: params.titleKey,
        payload: { chat_id: Number(user.home_chat_id), message_id: Number(user.home_message_id) },
        enabled: telemetryEnabledForUser(user.settings_json as Record<string, unknown>)
      });
      return;
    } catch (error) {
      if (error instanceof GrammyError && error.description.toLowerCase().includes('message is not modified')) {
        console.debug({ scope: 'render_screen', event: 'not_modified', screen: params.titleKey });
        return;
      }
      if (error instanceof GrammyError && error.description.toLowerCase().includes('message to edit not found')) {
        // fall through to send new message
      } else {
        throw error;
      }
    }
  }

  const message = await ctx.api.sendMessage(chatId, text, {
    reply_markup: params.inlineKeyboard ?? mainMenu
  });

  const client = getSupabaseClient();
  const { error } = await client
    .from('users')
    .update({
      home_chat_id: String(message.chat.id),
      home_message_id: String(message.message_id),
      updated_at: new Date().toISOString()
    })
    .eq('id', user.id);

  if (error) {
    console.error({
      scope: 'render_screen',
      event: 'persist_home_message_failed',
      userId: user.id,
      messageId: message.message_id,
      error
    });
  }

  await logTelemetryEvent({
    userId: user.id,
    traceId: (ctx as unknown as { traceId?: string }).traceId ?? '',
    eventName: 'screen_render',
    screen: params.titleKey,
    payload: { chat_id: message.chat.id, message_id: message.message_id },
    enabled: telemetryEnabledForUser(user.settings_json as Record<string, unknown>)
  });
};
