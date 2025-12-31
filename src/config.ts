import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  DEV_POLLING: z.coerce.boolean().default(false),
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_ADMIN_ID: z.string().optional(),
  TELEGRAM_WEBHOOK_URL: z
    .preprocess((value: unknown) => {
      if (typeof value !== 'string') return undefined;
      const trimmed = value.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    }, z.string().url().optional()),
  CRON_SECRET: z.string().min(1, 'CRON_SECRET is required'),
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  DEFAULT_TIMEZONE: z.string().min(1, 'DEFAULT_TIMEZONE is required')
});

const env = envSchema.parse(process.env);

export const config = {
  server: {
    host: env.HOST,
    port: env.PORT
  },
  telegram: {
    botToken: env.TELEGRAM_BOT_TOKEN,
    adminId: env.TELEGRAM_ADMIN_ID,
    webhookUrl: env.TELEGRAM_WEBHOOK_URL,
    devPolling: env.DEV_POLLING
  },
  cron: {
    secret: env.CRON_SECRET
  },
  supabase: {
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY
  },
  defaultTimezone: env.DEFAULT_TIMEZONE
};
