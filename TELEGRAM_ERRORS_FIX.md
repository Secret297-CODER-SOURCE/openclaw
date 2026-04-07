# Telegram Agent Errors Fix

## Issues Fixed

This document describes the fixes applied to resolve the following errors:

```
13:38:29 [ws] ⇄ res ✗ telegram.agent.getPromptSummary 0ms errorCode=INVALID_REQUEST errorMessage=unknown method
13:38:36 [ws] ⇄ res ✗ telegram.agent.deleteReEngagementHistoryItem 1ms errorCode=UNAVAILABLE errorMessage=SqliteError: no such table: tg_reengagement_history
```

## Root Causes

1. **Missing Method Registration**: The `telegram.agent.getPromptSummary` method was implemented in `TelegramPlugin.ts` but not registered in the exported methods list in `index.ts`.

2. **Database Table Name Mismatch**: The `deleteReEngagementHistoryItem` method was trying to delete from a table named `tg_reengagement_history`, but the actual table is named `tg_reengagement`.

3. **Missing Database Column**: The `tg_reengagement` table was missing a `message_text` column that is needed to store the actual re-engagement message text, which is displayed in the UI.

## Changes Made

### 1. Database Schema Update (`TelegramStorage.ts`)

**Added `message_text` column to `tg_reengagement` table:**

```sql
CREATE TABLE IF NOT EXISTS tg_reengagement (
  agent_id     TEXT NOT NULL,
  chat_id      TEXT NOT NULL,
  delay_days   INTEGER NOT NULL,
  period_ref   TEXT NOT NULL,
  sent_at      TEXT NOT NULL,
  message_text TEXT,  -- NEW COLUMN
  PRIMARY KEY (agent_id, chat_id, delay_days, period_ref)
);
```

**Added migration for existing databases:**

```typescript
// Incremental migration: add message_text column to tg_reengagement for existing DBs
const reengagementCols = this.db.prepare("PRAGMA table_info(tg_reengagement)").all() as Array<{
  name: string;
}>;
if (!reengagementCols.some((c) => c.name === "message_text")) {
  this.db.exec("ALTER TABLE tg_reengagement ADD COLUMN message_text TEXT");
}
```

### 2. Storage Method Updates (`TelegramStorage.ts`)

**Updated `markReEngagementSent` to accept and store message text:**

```typescript
markReEngagementSent(
  agentId: string,
  chatId: string,
  delayDays: number,
  periodRef: string,
  messageText?: string,  // NEW PARAMETER
): void {
  this.db
    .prepare(
      `INSERT OR IGNORE INTO tg_reengagement (agent_id, chat_id, delay_days, period_ref, sent_at, message_text)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(agentId, chatId, delayDays, periodRef, new Date().toISOString(), messageText ?? null);
}
```

**Fixed `deleteReEngagementHistoryItem` to use correct table name:**

```typescript
deleteReEngagementHistoryItem(agentId: string, chatId: string, sentAt: string): void {
  this.db
    .prepare(
      `DELETE FROM tg_reengagement  // Changed from tg_reengagement_history
       WHERE agent_id = ? AND chat_id = ? AND sent_at = ?`,
    )
    .run(agentId, chatId, sentAt);
}
```

### 3. Method Registration (`index.ts`)

**Added missing method to exported methods list:**

```typescript
const methods = [
  // ... existing methods ...
  "telegram.agent.runReEngagementNow",
  "telegram.agent.getPromptSummary", // ADDED
  "telegram.agent.reEngagementHistory",
  "telegram.agent.deleteReEngagementHistoryItem",
  // ... more methods ...
] as const;
```

### 4. Agent Code Update (`BaseAgent.ts`)

The agent code already passes the message text to `markReEngagementSent`, so no changes were needed there. The method signature was just updated to accept the optional parameter.

## Migration Notes

- **Existing databases**: The migration code will automatically add the `message_text` column when the storage is initialized. This is safe for existing databases and will not cause data loss.
- **New databases**: The column will be created as part of the initial schema.
- **Backward compatibility**: The `message_text` column is nullable, so old code that doesn't pass it will continue to work (storing NULL values).

## Testing

The build completed successfully with no errors:

```bash
pnpm build --filter=@openclaw/telegram-manager
✔ Build complete in 1410ms
```

## Summary

All three issues have been resolved:

1. ✅ `telegram.agent.getPromptSummary` is now properly registered and available
2. ✅ `telegram.agent.deleteReEngagementHistoryItem` now correctly deletes from `tg_reengagement`
3. ✅ Re-engagement messages are now stored with their text content for display in the UI
