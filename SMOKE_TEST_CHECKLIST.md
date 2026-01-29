# Smoke Test Checklist (Telegram + Render)

## Setup
- Configure Render env vars (Telegram token, Supabase keys, CRON_SECRET, ARCHIVE settings).
- Deploy the service and confirm `/health` returns `{ ok: true }`.

## Cron
1) **Unauthorized**  
   - `GET /cron/tick` (no key) → expect **401** `{ ok: false, error: "unauthorized" }`.  
2) **Wrong key**  
   - `GET /cron/tick?key=wrong` → expect **401**.  
3) **Correct key**  
   - `GET /cron/tick?key=<CRON_SECRET>` → expect **200** with `{ ok, processed, sent, failed, duration_ms, version, time }`.  

## Notes
1) **Today screen**  
   - No notes → no “Clear today” button.  
2) **Create note**  
   - Send title (optional) and body → saved.  
3) **Attachments**  
   - Upload multiple files and finish → archived and viewable.  
4) **History**  
   - Notes history shows entries and pagination; no duplicate header.  
5) **View details**  
   - “View all” sends media groups + summary card + returns to details.  
6) **Delete note**  
   - Deletes note in app; archive item status updated.  

## Reminders
1) **Create reminder**  
   - Title saved, description saved (verify in details).  
2) **Schedule**  
   - Set schedule type + time/date; status reflects enabled + schedule.  
3) **Attachments**  
   - Upload attachments; resend should use file IDs (no archive caption).  
4) **Delete reminder**  
   - Reminder disappears; archive status updated.  
5) **Cron execution**  
   - Due reminders are sent, next_run_at updated for recurring schedules.  

## Settings
1) **Emoji toggle**  
   - Open Settings → toggle `Emoji: ON/OFF`.  
   - UI updates immediately for the current user only.  

## Archive Channel
1) **Notes**  
   - Attachments appear in archive with proper summary line.  
2) **Reminders**  
   - Attachments archived on create/edit.  
3) **Delete/ Ringed**  
   - Archive messages append status line safely (no failures).  
