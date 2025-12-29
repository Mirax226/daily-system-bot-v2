import { Bot, Keyboard } from 'grammy';
import type { BotError, Context } from 'grammy';
import { config } from './config';
import { ensureUser } from './services/users';

const welcomeMessage = 'سلام! به ربات روزانه خوش آمدی. از منو می‌توانی خانه را انتخاب کنی.';

export const bot = new Bot(config.telegram.botToken);

const replyKeyboard = new Keyboard().text('🏠 خانه').resized();

bot.command('start', async (ctx: Context) => {
  if (!ctx.from) {
    await ctx.reply('خطا: اطلاعات کاربری در دسترس نیست.');
    return;
  }

  const telegramId = String(ctx.from.id);
  const username = ctx.from.username ?? null;

  try {
    await ensureUser({ telegramId, username });
  } catch (error) {
    console.error({ scope: 'services/users', error });
    await ctx.reply('خطا در اتصال به بانک اطلاعاتی. لطفاً بعداً دوباره امتحان کن.');
    return;
  }

  await ctx.reply(welcomeMessage, {
    reply_markup: replyKeyboard
  });
});

bot.hears('🏠 خانه', async (ctx: Context) => {
  await ctx.reply(welcomeMessage, {
    reply_markup: replyKeyboard
  });
});

bot.catch((err: BotError<Context>) => {
  const { ctx, error } = err;

  console.error('Bot error:', {
    updateId: ctx.update?.update_id,
    error
  });
});
