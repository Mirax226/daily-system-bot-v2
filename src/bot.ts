import { Bot, Keyboard } from 'grammy';
import type { BotError, Context } from 'grammy';
import { config } from './config';
import { ensureUser } from './services/users';
import { formatLocalTime } from './utils/time';

export const bot = new Bot(config.telegram.botToken);

const replyKeyboard = new Keyboard().text('خانه 🏠').resized();

const sendHome = async (ctx: Context) => {
  if (!ctx.from) {
    await ctx.reply('خطا: اطلاعات کاربری در دسترس نیست.');
    return;
  }

  const telegramId = String(ctx.from.id);
  const username = ctx.from.username ?? null;

  try {
    const user = await ensureUser({ telegramId, username });
    const localTime = formatLocalTime(user.timezone ?? config.defaultTimezone);

    const homeMessage = [
      'سلام! خوش آمدی به داشبورد خانه.',
      'در اینجا وضعیت کلی روزانه‌ات را می‌بینی.',
      `⏱ زمان فعلی: ${localTime.date} | ${localTime.time} (${localTime.timezone})`
    ].join('\n');

    await ctx.reply(homeMessage, {
      reply_markup: replyKeyboard
    });
  } catch (error) {
    console.error({ scope: 'services/users', error });
    await ctx.reply('خطا در اتصال به بانک اطلاعاتی. لطفاً بعداً دوباره امتحان کن.');
    return;
  }
};

bot.command('start', async (ctx: Context) => {
  await sendHome(ctx);
});

bot.hears('🏠 خانه', async (ctx: Context) => {
  await sendHome(ctx);
});

bot.command('home', async (ctx: Context) => {
  await sendHome(ctx);
});

bot.hears('خانه 🏠', async (ctx: Context) => {
  await sendHome(ctx);
});

bot.catch((err: BotError<Context>) => {
  const { ctx, error } = err;

  console.error('Bot error:', {
    updateId: ctx.update?.update_id,
    error
  });
});
