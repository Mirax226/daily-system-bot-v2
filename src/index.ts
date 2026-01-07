import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { GrammyError, webhookCallback } from 'grammy';
import { bot } from './bot';
import { config } from './config';
import { getSupabaseClient } from './db';
import { runMigrations } from './db/migrations';
import { processDueReminders } from './services/reminders';
import { logError } from './utils/logger';

const server = Fastify({ logger: true });

server.setErrorHandler((err, request, reply) => {
  logError('HTTP request error', {
    method: request.method,
    url: request.url,
    statusCode: reply.statusCode,
    error: err.message,
    stack: err.stack
  });

  reply.status(500).send({ ok: false });
});

process.on('unhandledRejection', (reason) => {
  logError('Unhandled promise rejection', { reason });
});

process.on('uncaughtException', (err) => {
  logError('Uncaught exception', { error: err.message, stack: err.stack });
});

server.get('/health', async () => {
  return { status: 'ok' };
});

server.post('/webhook', webhookCallback(bot, 'fastify'));

server.post('/cron/tick', async (request: FastifyRequest, reply: FastifyReply) => {
  const headerSecret = request.headers['x-cron-secret'];
  const providedSecret = Array.isArray(headerSecret) ? headerSecret[0] : headerSecret;

  if (providedSecret !== config.cron.secret) {
    console.warn({ scope: 'cron', event: 'cron_unauthorized' });
    reply.code(401);
    return { error: 'unauthorized' };
  }

  const nowUtc = new Date();
  const result = await processDueReminders(nowUtc, bot);

  console.log({ scope: 'cron', event: 'cron_tick_done', processed: result.processed });
  return { status: 'ok', processed: result.processed };
});

const isTelegramTooManyRequests = (error: unknown): boolean => {
  if (error instanceof GrammyError) {
    return error.error_code === 429;
  }

  if (typeof error === 'object' && error !== null && 'error_code' in error) {
    const errorCode = (error as { error_code?: number }).error_code;
    return errorCode === 429;
  }

  return false;
};

const start = async () => {
  try {
    await runMigrations();
    getSupabaseClient();

    await server.listen({ host: config.server.host, port: config.server.port });
    server.log.info(`Server listening on ${config.server.host}:${config.server.port}`);

    if (config.telegram.devPolling) {
      server.log.info('Running in DEV_POLLING mode: starting bot via long polling.');
      await bot.start();
    } else {
      if (config.telegram.webhookUrl) {
        try {
          await bot.api.setWebhook(config.telegram.webhookUrl);
          server.log.info('Webhook registered with Telegram.');
        } catch (error) {
          if (isTelegramTooManyRequests(error)) {
            server.log.warn(
              { err: error, scope: 'telegram/webhook' },
              'Telegram setWebhook rate limited.'
            );
          } else {
            server.log.error({ err: error }, 'Failed to set Telegram webhook.');
          }
        }
      }

      server.log.info('Running in WEBHOOK mode: NOT calling bot.start(), updates come via /webhook.');
    }
  } catch (error) {
    server.log.error({ err: error }, 'Failed to start application.');
    process.exit(1);
  }
};

void start();
