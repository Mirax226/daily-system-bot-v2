# Environment Variables Used

This list is derived from `src/config.ts` (runtime config) and npm-provided metadata (`npm_package_name`, `npm_package_version`).

## Required
- `TELEGRAM_BOT_TOKEN` — Telegram bot token. (`src/config.ts`)
- `SUPABASE_URL` — Supabase project URL. (`src/config.ts`)
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role key. (`src/config.ts`)
- `SUPABASE_DB_CONNECTION` — Postgres connection string for schema sync/PG pool. (`src/config.ts`)
- `DEFAULT_TIMEZONE` — Default timezone for scheduling. (`src/config.ts`)

## Optional
- `HOST` — Fastify host (default `0.0.0.0`). (`src/config.ts`)
- `PORT` — Fastify port (default `3000`). (`src/config.ts`)
- `DEV_POLLING` — Enable long polling (default `false`). (`src/config.ts`)
- `ADMIN_TELEGRAM_ID` — Admin Telegram ID. (`src/config.ts`)
- `TELEGRAM_WEBHOOK_URL` — Webhook URL. (`src/config.ts`)
- `CRON_SECRET` — Cron auth key; empty means no auth. (`src/config.ts`)
- `CRON_MAX_BATCH` — Cron max batch size (default `20`). (`src/config.ts`)
- `CRON_MAX_RUNTIME_MS` — Cron runtime limit (default `20000`). (`src/config.ts`)
- `TELEGRAM_SEND_DELAY_MS` — Delay between cron sends (default `0`). (`src/config.ts`)
- `ARCHIVE_ENABLED` — Enable archive (default `true`). (`src/config.ts`)
- `ARCHIVE_MODE` — Archive mode (default `channel`). (`src/config.ts`)
- `ARCHIVE_CHANNEL_ID` — Archive channel id (fallback to `ARCHIVE_CHAT_ID`). (`src/config.ts`)
- `ARCHIVE_CHAT_ID` — Archive channel id (used if `ARCHIVE_CHANNEL_ID` missing). (`src/config.ts`)
- `ARCHIVE_MAX_CHUNK` — Archive text chunk size (default `3500`). (`src/config.ts`)
- `LOG_REPORTER_ENABLED` — Enable log reporter (default `true`). (`src/config.ts`)
- `LOG_LEVELS` — Comma-separated log levels for remote logging (default `error`). (`src/config.ts`)
- `PATH_APPLIER_LOG_INGEST_URL` — Log ingest URL. (`src/config.ts`)
- `PATH_APPLIER_LOG_INGEST_KEY` — Log ingest key. (`src/config.ts`)
- `PROJECT_ID` — Log reporter project ID (default `daily-system`). (`src/config.ts`)
- `SERVICE_NAME` — Log reporter service name (fallback to Render vars). (`src/config.ts`)
- `APP_ENV` — App environment label (default `production`). (`src/config.ts`)
- `RENDER_SERVICE_NAME` — Render service name fallback. (`src/config.ts`)
- `RENDER_SERVICE_ID` — Render service id fallback. (`src/config.ts`)
- `UI_EMOJI_ENABLED` — Default emoji toggle (default `true`). (`src/config.ts`)
- `DB_MIGRATIONS_ENABLED` — Enable schema sync (default `true`). (`src/config.ts`)
- `RUN_BACKFILL` — Run attachment backfill (default `false`). (`src/config.ts`)
- `npm_package_name` — npm-provided package name for logging fallback. (`src/config.ts`)
- `npm_package_version` — npm-provided package version for cron response. (`src/config.ts`)

## Defaults
- `HOST=0.0.0.0`
- `PORT=3000`
- `DEV_POLLING=false`
- `CRON_MAX_BATCH=20`
- `CRON_MAX_RUNTIME_MS=20000`
- `TELEGRAM_SEND_DELAY_MS=0`
- `ARCHIVE_ENABLED=true`
- `ARCHIVE_MODE=channel`
- `ARCHIVE_MAX_CHUNK=3500`
- `LOG_REPORTER_ENABLED=true`
- `LOG_LEVELS=error`
- `PROJECT_ID=daily-system`
- `APP_ENV=production`
- `UI_EMOJI_ENABLED=true`
- `DB_MIGRATIONS_ENABLED=true`
- `RUN_BACKFILL=false`

## Deprecated-Aliases
- `TELEGRAM_ADMIN_ID` — Deprecated alias for `ADMIN_TELEGRAM_ID`. (`src/config.ts`)
- `SUPABASE_DB_CONNECTION_STRING` — Deprecated alias for `SUPABASE_DB_CONNECTION`. (`src/config.ts`)
- `SUPABASE_DSN_DAILY_SYSTEM` — Deprecated alias for `SUPABASE_DB_CONNECTION`. (`src/config.ts`)
