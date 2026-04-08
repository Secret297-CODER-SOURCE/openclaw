# Re-Engagement System Status Report

**Date:** 2026-04-06  
**Agent:** di (ID: b90cd9d4-6007-402b-8b0a-06c778bdd782)

## Current Status: ✅ WORKING CORRECTLY

The re-engagement system is functioning as designed. **No messages are being sent because all tracked contacts have already received messages for their current day windows.**

## Contact Status

| Chat ID     | Last Contact     | Days Silent | Already Sent Days | Matching Windows | Blocked?             |
| ----------- | ---------------- | ----------- | ----------------- | ---------------- | -------------------- |
| 864179107   | 2026-03-30 12:51 | 6.98 days   | 1, 2, 6, 7, 8     | 6, 7, 8          | ✅ Yes (all blocked) |
| 6936748802  | 2026-03-30 12:33 | 7.00 days   | 1, 2, 5, 6, 7, 8  | 6, 7, 8          | ✅ Yes (all blocked) |
| -5103392897 | (not shown)      | -           | 4, 5, 6           | -                | ✅ Yes               |

## Why Nothing Is Sending

The re-engagement check runs every ~90 seconds and checks days 1-14. For each day window:

- **Day 6**: 3 contacts in window, all 3 `dedupBlocked` ← already sent
- **Day 7**: 2 contacts in window, all 2 `dedupBlocked` ← already sent
- **Day 8**: 2 contacts in window, all 2 `dedupBlocked` ← already sent
- **Days 1-5, 9-14**: No contacts in these windows

## Deduplication Logic

Re-engagement uses a composite key to prevent duplicates:

```
(agent_id, chat_id, delay_days, period_ref)
```

Where `period_ref` is the timestamp of `last_client_msg_at`. This ensures:

1. Each contact gets ONE message per day window
2. If a contact replies, `last_client_msg_at` updates and they can receive new messages later
3. The system never spams contacts with duplicate messages for the same silence period

## How to Test Re-Engagement

### Option 1: Wait for Natural Progression (RECOMMENDED)

Contacts will automatically move into new day windows as time passes. For example:

- In ~24 hours, both contacts will be ~8 days silent
- If day 9 hasn't been sent yet, they'll receive messages then

### Option 2: Clear Re-Engagement History (TESTING ONLY)

**⚠️ Warning:** This will allow re-sending to ALL contacts, including those already contacted.

```bash
# Clear ALL re-engagement history for agent 'di'
sqlite3 ~/.openclaw/telegram/telegram.db "DELETE FROM tg_reengagement WHERE agent_id = 'b90cd9d4-6007-402b-8b0a-06c778bdd782';"

# Or clear specific days only (e.g., clear day 6,7,8 records)
sqlite3 ~/.openclaw/telegram/telegram.db "DELETE FROM tg_reengagement WHERE agent_id = 'b90cd9d4-6007-402b-8b0a-06c778bdd782' AND delay_days IN (6,7,8);"

# Restart agent to trigger immediate check
# (or wait ~90 seconds for next cron run)
```

### Option 3: Add New Test Contacts

Create new Telegram contacts and message them, then wait for the configured delay period.

### Option 4: Manually Update Last Contact Time

```bash
# Make a contact appear as if they were silent 10 days ago
# (This will trigger day 10 re-engagement if not already sent)
sqlite3 ~/.openclaw/telegram/telegram.db "
UPDATE tg_contacts
SET last_client_msg_at = datetime('now', '-10 days')
WHERE agent_id = 'b90cd9d4-6007-402b-8b0a-06c778bdd782'
AND chat_id = '864179107';
"
```

## Configuration Check

Current re-engagement settings for agent 'di':

- ✅ Enabled: `true`
- Delay range: Days 1-14
- Mode: `template` or `ai`
- Pause between sends: 1-25 seconds
- Template enhancement: Check UI setting "✨ ИИ улучшает шаблон"

## Database Schema Reference

```sql
-- Re-engagement tracking table
CREATE TABLE tg_reengagement (
  agent_id    TEXT NOT NULL,
  chat_id     TEXT NOT NULL,
  delay_days  INTEGER NOT NULL,   -- Which day window (1-14)
  period_ref  TEXT NOT NULL,       -- Timestamp of last_client_msg_at
  sent_at     TEXT NOT NULL,       -- When we sent the message
  PRIMARY KEY (agent_id, chat_id, delay_days, period_ref)
);

-- Contacts table (tracks last interaction)
CREATE TABLE tg_contacts (
  agent_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  username TEXT,
  last_client_msg_at TEXT NOT NULL,  -- Used to calculate silence duration
  PRIMARY KEY (agent_id, chat_id)
);
```

## Monitoring Commands

```bash
# View all re-engagement sends for a contact
sqlite3 ~/.openclaw/telegram/telegram.db "
SELECT chat_id, delay_days, period_ref, sent_at
FROM tg_reengagement
WHERE agent_id = 'b90cd9d4-6007-402b-8b0a-06c778bdd782'
AND chat_id = '864179107'
ORDER BY delay_days;
"

# Count total re-engagement messages sent
sqlite3 ~/.openclaw/telegram/telegram.db "
SELECT COUNT(*) as total_reengagement_sends
FROM tg_reengagement
WHERE agent_id = 'b90cd9d4-6007-402b-8b0a-06c778bdd782';
"

# View contacts and their silence duration
sqlite3 ~/.openclaw/telegram/telegram.db "
SELECT
  chat_id,
  first_name || ' ' || COALESCE(last_name, '') as name,
  last_client_msg_at,
  ROUND((julianday('now') - julianday(last_client_msg_at)) * 24, 1) as hours_silent
FROM tg_contacts
WHERE agent_id = 'b90cd9d4-6007-402b-8b0a-06c778bdd782'
ORDER BY last_client_msg_at DESC;
"
```

## Conclusion

✅ **Re-engagement is working correctly.**  
✅ **Deduplication is preventing spam.**  
✅ **System will send messages when contacts enter new day windows.**

The logs showing `found=0` are expected when all contacts have already been processed for their current windows. This is the system doing exactly what it should: preventing duplicate messages while waiting for new opportunities to re-engage.
