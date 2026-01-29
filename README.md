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
ADMIN_TELEGRAM_ID=123456789
TELEGRAM_WEBHOOK_URL=https://your-service.onrender.com/webhook
CRON_SECRET=your-cron-secret
SUPABASE_DB_CONNECTION=postgresql://user:password@host:5432/postgres
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
DEFAULT_TIMEZONE=Asia/Tehran
ARCHIVE_CHAT_ID=-1000000000000
LOG_REPORTER_ENABLED=true
LOG_LEVELS=error
PATH_APPLIER_LOG_INGEST_URL=https://path-applier.example.com/project-log/daily-system
PATH_APPLIER_LOG_INGEST_KEY=your-ingest-key
UI_EMOJI_ENABLED=true
DB_MIGRATIONS_ENABLED=true
RUN_BACKFILL=false
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
- Endpoint: `GET /cron/tick?key=<CRON_SECRET>`
- Returns a JSON summary (`ok`, `processed`, `sent`, `failed`, `duration_ms`, `version`).

## Log forwarding to Path Applier
If `PATH_APPLIER_LOG_INGEST_URL` and `PATH_APPLIER_LOG_INGEST_KEY` are set, the bot will forward logs to Path Applier in addition to console output.
Use `LOG_LEVELS` to control which levels are sent:
`error` (default), `warn`, or `info` (comma-separated).
