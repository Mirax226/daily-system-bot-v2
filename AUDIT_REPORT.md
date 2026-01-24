# Daily System Bot v2 — Audit Report

## Summary
Audit goal: verify Notes/Reminders/Archive/Cron flows end-to-end, harden Telegram messaging, and ensure DB/migrations are safe for Render + Supabase/Postgres.

## ✅ Working Features (Reviewed)
- Notes creation/edit flows (title/body saved and rendered) use `notes` + `note_attachments` with file IDs for resend, avoiding expired attachments.  
- Notes history uses pagination via `list_note_date_counts` and `listNotesByDatePage` (not limited to 7 days).  
- Notes “Clear today” button is conditional on existing notes in the UI.  
- Archive status updates (deleted/ringed) are appended to archive item messages via `markArchiveItemStatus`.  
- Reminder scheduling logic (once/hourly/daily/weekly/monthly/yearly) computes next run from timezone-aware helpers.

## ❌ Broken Features (Fixed)
1) **Reminder attachment resend used archive copy (risk: expired attachment + caption leakage).**  
   - **Repro:** create reminder with attachments → wait → cron delivers reminder → attachments are copied from archive channel.  
   - **Impact:** Telegram archive copies can carry archive captions and can fail after file expiration.  
   - **Fix:** store `file_id` on reminder attachments and resend via `sendMediaGroup`/direct API sends using file IDs.  

2) **Cron tick endpoint response didn’t include processing summary.**  
   - **Repro:** call `/cron/tick?key=...` → response was `{ ok, started }` while processing ran in background.  
   - **Impact:** hard to monitor and verify processed counts.  
   - **Fix:** run cron tick inline (bounded by config) and return `{ ok, tick_id, claimed, sent, failed, skipped, duration_ms, time }`.  

3) **Message-too-long risk for screen renders.**  
   - **Repro:** long content in a details screen → `editMessageText` can fail with `MESSAGE_TOO_LONG`.  
   - **Fix:** screen renders are truncated to a safe length before sending.  

## ⚠️ Risky Areas / Edge Cases
- **Existing reminder attachments without `file_id`** will now be skipped (new attachments are safe).  
  - Recommended: backfill `file_id` by reattaching or a migration script if feasible.  
- **Build/TS checks blocked by dependency install** due to registry access restrictions in this environment.  

## Fixes Applied (File-by-File)
- **`src/services/cron.service.ts`**  
  - Re-sent reminder attachments using stored file IDs via `sendAttachmentsWithApi`.  
  - Added warnings when attachments are missing `file_id`.  
- **`src/services/reminders.ts`**  
  - Stored `file_id` on reminder attachments.  
  - Resend attachments via `sendAttachmentsWithApi` (no archive copy).  
  - Truncated reminder notification messages to safe length.  
- **`src/services/telegram-media.ts`**  
  - Added `sendAttachmentsWithApi` helper for non-`Context` senders (cron).  
- **`src/ui/renderScreen.ts`**  
  - Safe truncation before sending/editing Telegram messages.  
- **`src/index.ts`**  
  - `/cron/tick` now returns processing summary with bounded runtime.  
- **`src/types/supabase.ts`**  
  - Added `file_id` to `reminders_attachments` type definitions.  
- **`supabase/migrations/0016_reminders_attachments_file_id.sql`**  
  - Added `file_id` column (idempotent).  
- **`src/bot.ts`**  
  - Stored reminder attachment `file_id` when archiving.  

## Remaining TODOs (Prioritized)
1) **Backfill `reminders_attachments.file_id` for existing records**  
   - Priority: **High** (affects resend reliability).  
2) **Resolve dependency install in CI/Render for local builds**  
   - Priority: **Medium** (blocks local `npm ci` in this environment).  

## Build & TypeScript Sanity
- `npm ci` failed in this environment due to registry access restrictions (403).  
- `npm run build` and `npm run lint` failed because dependencies were not installed.

