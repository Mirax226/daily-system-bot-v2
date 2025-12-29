import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { webhookCallback } from 'grammy';
import { bot } from './bot';
import { config } from './config';
import { getSupabaseClient } from './db';

const server = Fastify({ logger: true });

server.get('/health', async () => {
  return { status: 'ok' };
});

server.post('/webhook', webhookCallback(bot, 'fastify'));

server.post('/cron/tick', async (request: FastifyRequest, reply: FastifyReply) => {
  const headerSecret = request.headers['x-cron-secret'];
  const providedSecret = Array.isArray(headerSecret) ? headerSecret[0] : headerSecret;

  if (providedSecret !== config.cron.secret) {
    reply.code(401);
    return { error: 'unauthorized' };
  }

  console.log({ scope: 'cron', event: 'tick' });
  return { status: 'ok', processed: [] as unknown[] };
});

const start = async () => {
  getSupabaseClient();

  try {
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
          server.log.error({ err: error }, 'Failed to set Telegram webhook.');
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
