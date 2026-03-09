import fs from "node:fs";
import path from "node:path";
import type { HistoryEntry } from "../auto-reply/reply/history.js";

type PersistedHistories = Array<[string, HistoryEntry[]]>;

/**
 * Resolve the path for persisting Telegram group message history to disk.
 * Stored per-account so multi-account setups don't share history files.
 */
export function resolveGroupHistoryPersistPath(agentDir: string, accountId: string): string {
  // Sanitize accountId to avoid path traversal or invalid filenames.
  const safeAccountId = accountId.replace(/[^a-zA-Z0-9_-]/g, "_") || "default";
  return path.join(agentDir, `telegram-group-history-${safeAccountId}.json`);
}

/**
 * Load persisted Telegram group histories from disk.
 * Returns an empty Map if the file is missing, unreadable, or malformed.
 */
export function loadGroupHistoriesFromDisk(filePath: string): Map<string, HistoryEntry[]> {
  const map = new Map<string, HistoryEntry[]>();
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    // File doesn't exist yet — normal on first run.
    return map;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupted file — start fresh.
    return map;
  }
  if (!Array.isArray(parsed)) {
    return map;
  }
  for (const item of parsed as unknown[]) {
    if (!Array.isArray(item) || item.length < 2) {
      continue;
    }
    const [key, entries] = item as [unknown, unknown];
    if (typeof key !== "string" || !Array.isArray(entries)) {
      continue;
    }
    const valid: HistoryEntry[] = [];
    for (const e of entries as unknown[]) {
      if (
        e !== null &&
        typeof e === "object" &&
        typeof (e as Record<string, unknown>).sender === "string" &&
        typeof (e as Record<string, unknown>).body === "string"
      ) {
        valid.push(e as HistoryEntry);
      }
    }
    if (valid.length > 0) {
      map.set(key, valid);
    }
  }
  return map;
}

/**
 * Save Telegram group histories to disk. Best-effort: silently swallows
 * write errors since history persistence is non-critical.
 */
export function saveGroupHistoriesToDisk(filePath: string, map: Map<string, HistoryEntry[]>): void {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const data: PersistedHistories = [...map.entries()];
    fs.writeFileSync(filePath, JSON.stringify(data), "utf-8");
  } catch {
    // Best-effort persistence; ignore transient write errors.
  }
}
