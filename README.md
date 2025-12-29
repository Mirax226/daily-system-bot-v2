# Daily System Bot

Minimal, production-ready baseline for a Telegram daily system bot built with TypeScript, Fastify, grammY, and Supabase.

## Stack
- Node.js + TypeScript
- Fastify HTTP server
- grammY Telegram bot framework
- Supabase (supabase-js)
- Webhook mode for production, optional polling for local development

## Environment Variables
Copy `.env.example` to `.env` and fill in your values:

```
HOST=0.0.0.0
PORT=3000
DEV_POLLING=false
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
TELEGRAM_WEBHOOK_URL=https://your-service.onrender.com/webhook
CRON_SECRET=your-cron-secret
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
DEFAULT_TIMEZONE=Asia/Tehran
```

## Local Development
1. Install dependencies:
   ```bash
   npm install
   ```
2. Run in dev mode with polling enabled:
   ```bash
   DEV_POLLING=true npm run dev
   ```
3. Check the health endpoint:
   ```bash
   curl http://localhost:3000/health
   ```

## Production (Render example)
- Keep `DEV_POLLING=false`.
- Set `TELEGRAM_WEBHOOK_URL` to your Render URL plus `/webhook` (e.g., `https://your-service.onrender.com/webhook`).
- On startup, the bot registers the webhook automatically.

## Cron
- Endpoint: `POST /cron/tick`
- Header: `X-CRON-SECRET: <CRON_SECRET>`
- Configure cron-job.org to call this endpoint. The handler is currently a stub and just acknowledges the request.
