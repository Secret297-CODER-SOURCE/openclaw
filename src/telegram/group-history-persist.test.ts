import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HistoryEntry } from "../auto-reply/reply/history.js";
import {
  loadGroupHistoriesFromDisk,
  resolveGroupHistoryPersistPath,
  saveGroupHistoriesToDisk,
} from "./group-history-persist.js";

describe("resolveGroupHistoryPersistPath", () => {
  it("builds a path from agentDir and accountId", () => {
    const p = resolveGroupHistoryPersistPath("/home/user/.openclaw/agents/default/agent", "main");
    expect(p).toBe("/home/user/.openclaw/agents/default/agent/telegram-group-history-main.json");
  });

  it("sanitizes accountId to avoid special characters", () => {
    const p = resolveGroupHistoryPersistPath("/tmp", "acc/ount:123");
    expect(path.basename(p)).toBe("telegram-group-history-acc_ount_123.json");
  });

  it("falls back to 'default' when accountId is empty", () => {
    const p = resolveGroupHistoryPersistPath("/tmp", "");
    expect(path.basename(p)).toBe("telegram-group-history-default.json");
  });
});

describe("saveGroupHistoriesToDisk / loadGroupHistoriesFromDisk", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-"));
    filePath = path.join(tmpDir, "test-history.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips a populated history map", () => {
    const map = new Map<string, HistoryEntry[]>();
    const entries: HistoryEntry[] = [
      { sender: "Alice", body: "Hello!", timestamp: 1000, messageId: "1" },
      { sender: "Bob", body: "Hi there", timestamp: 2000 },
    ];
    map.set("-100123:1", entries);
    map.set("-100456", [{ sender: "Charlie", body: "Hey" }]);

    saveGroupHistoriesToDisk(filePath, map);
    const loaded = loadGroupHistoriesFromDisk(filePath);

    expect(loaded.size).toBe(2);
    expect(loaded.get("-100123:1")).toEqual(entries);
    expect(loaded.get("-100456")).toEqual([{ sender: "Charlie", body: "Hey" }]);
  });

  it("returns empty map when file does not exist", () => {
    const loaded = loadGroupHistoriesFromDisk(path.join(tmpDir, "nonexistent.json"));
    expect(loaded.size).toBe(0);
  });

  it("returns empty map when file contains invalid JSON", () => {
    fs.writeFileSync(filePath, "not json{{{", "utf-8");
    const loaded = loadGroupHistoriesFromDisk(filePath);
    expect(loaded.size).toBe(0);
  });

  it("returns empty map when file contains non-array JSON", () => {
    fs.writeFileSync(filePath, JSON.stringify({ key: "value" }), "utf-8");
    const loaded = loadGroupHistoriesFromDisk(filePath);
    expect(loaded.size).toBe(0);
  });

  it("skips entries with invalid shape", () => {
    const raw = JSON.stringify([
      ["-100abc", [{ sender: "A", body: "msg" }]],
      ["-100bad", [{ notSender: "X" }]], // missing required fields
      [null, [{ sender: "B", body: "ok" }]], // null key
    ]);
    fs.writeFileSync(filePath, raw, "utf-8");
    const loaded = loadGroupHistoriesFromDisk(filePath);
    // Only the first entry is valid
    expect(loaded.size).toBe(1);
    expect(loaded.get("-100abc")).toEqual([{ sender: "A", body: "msg" }]);
  });

  it("creates parent directories when saving", () => {
    const nestedPath = path.join(tmpDir, "a", "b", "c", "history.json");
    const map = new Map<string, HistoryEntry[]>();
    map.set("group1", [{ sender: "X", body: "test" }]);
    saveGroupHistoriesToDisk(nestedPath, map);
    expect(fs.existsSync(nestedPath)).toBe(true);
  });

  it("silently ignores save errors for unwritable paths", () => {
    // Should not throw even when path is invalid.
    expect(() =>
      saveGroupHistoriesToDisk("/dev/null/impossible/path.json", new Map()),
    ).not.toThrow();
  });

  it("overwrites the file on each save", () => {
    const map1 = new Map<string, HistoryEntry[]>();
    map1.set("g1", [{ sender: "A", body: "first" }]);
    saveGroupHistoriesToDisk(filePath, map1);

    const map2 = new Map<string, HistoryEntry[]>();
    map2.set("g2", [{ sender: "B", body: "second" }]);
    saveGroupHistoriesToDisk(filePath, map2);

    const loaded = loadGroupHistoriesFromDisk(filePath);
    expect(loaded.size).toBe(1);
    expect(loaded.has("g1")).toBe(false);
    expect(loaded.get("g2")).toEqual([{ sender: "B", body: "second" }]);
  });
});
