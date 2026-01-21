import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { GrammyError, webhookCallback } from 'grammy';
import { bot } from './bot';
import { config } from './config';
import { getSupabaseClient } from './db';
import { runMigrations } from './db/migrations';
import { resolveArchiveChatId } from './services/archive';
import { getCronHealth, runCronTick } from './services/cron.service';
import { logError } from './utils/logger';

const server = Fastify({ logger: true });

server.setErrorHandler((err, request, reply) => {
  try {
    logError('HTTP request error', {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      error: err.message,
      stack: err.stack
    });
  } catch (logErrorErr) {
    request.log.error({ err: logErrorErr }, 'Failed to log HTTP request error.');
  }

  reply.status(500).send({ ok: false });
});

process.on('unhandledRejection', (reason) => {
  logError('Unhandled promise rejection', { reason });
});

process.on('uncaughtException', (err) => {
  logError('Uncaught exception', { error: err.message, stack: err.stack });
});

server.get('/health', async () => {
  return { ok: true };
});

server.get('/', async () => {
  return { ok: true, service: 'daily-system', ts: new Date().toISOString() };
});

server.post('/webhook', webhookCallback(bot, 'fastify'));

server.get(
  '/cron/tick',
  async (
    request: FastifyRequest<{ Querystring: { key?: string } }>,
    reply: FastifyReply
  ) => {
    const result = await runCronTick({ key: request.query.key, botClient: bot });
    if (!result.ok && result.error === 'unauthorized') {
      reply.code(401);
    }
    return result;
  }
);

server.get('/cron/health', async () => {
  const health = await getCronHealth();
  return { ok: true, ...health };
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

const logArchiveStatus = (logger: typeof server.log): void => {
  const enabled = config.archive.enabled;
  const chatId = resolveArchiveChatId();
  const looksValid = Boolean(chatId && /^-100\\d+$/.test(String(chatId)));
  if (enabled && looksValid) {
    logger.info('[archive] channel configured');
    return;
  }
  if (enabled) {
    logger.warn('[archive] channel missing, archive fallback enabled');
    return;
  }
  logger.info('[archive] disabled');
};

const start = async () => {
  try {
    const port = Number(process.env.PORT ?? config.server.port);
    const host = '0.0.0.0';
    await server.listen({ host, port });
    server.log.info({ host, port }, 'HTTP server is listening');

    void (async () => {
      try {
        server.log.info('Init start');
        await runMigrations();
        getSupabaseClient();
        logArchiveStatus(server.log);

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
                server.log.error(
                  { err: error },
                  'Failed to set Telegram webhook (non-fatal).'
                );
              }
            }
          }

          server.log.info(
            'Running in WEBHOOK mode: NOT calling bot.start(), updates come via /webhook.'
          );
        }

        server.log.info('Init done');
      } catch (err) {
        server.log.error({ err }, 'Init failed (service stays up, health still OK).');
      }
    })();
  } catch (error) {
    server.log.error({ err: error }, 'Failed to start application.');
    process.exit(1);
  }
};

void start();
