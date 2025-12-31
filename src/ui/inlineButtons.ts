import { InlineKeyboard } from 'grammy';
import type { Context } from 'grammy';
import { createCallbackToken } from '../services/callbackTokens';

export async function makeActionButton(
  ctx: Context,
  params: { label: string; action: string; data?: any; ttlMinutes?: number }
): Promise<{ text: string; callback_data: string }> {
  const userId = (ctx as unknown as { session?: { userId?: string } }).session?.userId ?? ctx.from?.id?.toString();
  const payload = { action: params.action, data: params.data ?? null };
  const token = await createCallbackToken({ userId, payload, ttlMinutes: params.ttlMinutes });
  if (token.length > 32) {
    console.warn({ scope: 'inline_buttons', event: 'token_length_warning', length: token.length, action: params.action });
  }
  return { text: params.label, callback_data: token };
}

export async function makeRow(
  ctx: Context,
  buttons: Array<{ label: string; action: string; data?: any; ttlMinutes?: number }>
): Promise<InlineKeyboard> {
  const kb = new InlineKeyboard();
  for (const button of buttons) {
    const built = await makeActionButton(ctx, button);
    kb.text(built.text, built.callback_data);
  }
  return kb;
}
