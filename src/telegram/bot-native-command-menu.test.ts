import { describe, expect, it, vi } from "vitest";
import {
  buildCappedTelegramMenuCommands,
  buildPluginTelegramMenuCommands,
  syncTelegramMenuCommands,
} from "./bot-native-command-menu.js";

describe("bot-native-command-menu", () => {
  it("caps menu entries to Telegram limit", () => {
    const allCommands = Array.from({ length: 105 }, (_, i) => ({
      command: `cmd_${i}`,
      description: `Command ${i}`,
    }));

    const result = buildCappedTelegramMenuCommands({ allCommands });

    expect(result.commandsToRegister).toHaveLength(99);
    expect(result.totalCommands).toBe(105);
    expect(result.maxCommands).toBe(99);
    expect(result.overflowCount).toBe(6);
    expect(result.commandsToRegister[0]).toEqual({ command: "cmd_0", description: "Command 0" });
    expect(result.commandsToRegister[98]).toEqual({
      command: "cmd_98",
      description: "Command 98",
    });
  });

  it("validates plugin command specs and reports conflicts", () => {
    const existingCommands = new Set(["native"]);

    const result = buildPluginTelegramMenuCommands({
      specs: [
        { name: "valid", description: "  Works  " },
        { name: "bad-name!", description: "Bad" },
        { name: "native", description: "Conflicts with native" },
        { name: "valid", description: "Duplicate plugin name" },
        { name: "empty", description: "   " },
      ],
      existingCommands,
    });

    expect(result.commands).toEqual([{ command: "valid", description: "Works" }]);
    expect(result.issues).toContain(
      'Plugin command "/bad-name!" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).',
    );
    expect(result.issues).toContain(
      'Plugin command "/native" conflicts with an existing Telegram command.',
    );
    expect(result.issues).toContain('Plugin command "/valid" is duplicated.');
    expect(result.issues).toContain('Plugin command "/empty" is missing a description.');
  });

  it("rejects plugin commands with descriptions that are too short", () => {
    const result = buildPluginTelegramMenuCommands({
      specs: [
        { name: "short", description: "ab" },
        { name: "ok", description: "abc" },
      ],
      existingCommands: new Set<string>(),
    });

    expect(result.commands).toEqual([{ command: "ok", description: "abc" }]);
    expect(result.issues).toContain(
      'Plugin command "/short" description is too short (minimum 3 characters).',
    );
  });

  it("truncates plugin command descriptions longer than 256 characters", () => {
    const longDescription = "A".repeat(300);
    const result = buildPluginTelegramMenuCommands({
      specs: [{ name: "longdesc", description: longDescription }],
      existingCommands: new Set<string>(),
    });

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.description).toHaveLength(256);
    expect(result.commands[0]?.description.endsWith("…")).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("normalizes hyphenated plugin command names", () => {
    const result = buildPluginTelegramMenuCommands({
      specs: [{ name: "agent-run", description: "Run agent" }],
      existingCommands: new Set<string>(),
    });

    expect(result.commands).toEqual([{ command: "agent_run", description: "Run agent" }]);
    expect(result.issues).toEqual([]);
  });

  it("deletes stale commands before setting new menu", async () => {
    const callOrder: string[] = [];
    const deleteMyCommands = vi.fn(async () => {
      callOrder.push("delete");
    });
    const setMyCommands = vi.fn(async () => {
      callOrder.push("set");
    });

    syncTelegramMenuCommands({
      bot: {
        api: {
          deleteMyCommands,
          setMyCommands,
        },
      } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
      runtime: {} as Parameters<typeof syncTelegramMenuCommands>[0]["runtime"],
      commandsToRegister: [{ command: "cmd", description: "Command" }],
    });

    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalled();
    });

    expect(callOrder).toEqual(["delete", "set"]);
  });

  it("logs setMyCommands failure once without rethrowing", async () => {
    const runtimeError = vi.fn();
    const setMyCommands = vi.fn().mockRejectedValue(new Error("BOT_COMMANDS_TOO_MUCH"));

    syncTelegramMenuCommands({
      bot: {
        api: { setMyCommands },
      } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
      runtime: {
        error: runtimeError,
      } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["runtime"],
      commandsToRegister: [{ command: "cmd", description: "Command" }],
    });

    // syncTelegramMenuCommands fires void sync() which is async; waitFor lets the
    // microtask queue drain so withTelegramApiErrorLogging can log the rejection.
    await vi.waitFor(() => {
      expect(runtimeError).toHaveBeenCalled();
    });

    // Error must be logged exactly once (no double-logging).
    expect(runtimeError).toHaveBeenCalledTimes(1);
    expect(runtimeError.mock.calls[0]?.[0]).toContain("setMyCommands");
  });

  it("skips setMyCommands when deleteMyCommands fails with a 5xx server error", async () => {
    const serverError = Object.assign(new Error("Gateway Timeout"), { error_code: 504 });
    const deleteMyCommands = vi.fn().mockRejectedValue(serverError);
    const setMyCommands = vi.fn();
    const runtimeError = vi.fn();

    syncTelegramMenuCommands({
      bot: {
        api: { deleteMyCommands, setMyCommands },
      } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
      runtime: {
        error: runtimeError,
      } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["runtime"],
      commandsToRegister: [{ command: "cmd", description: "Command" }],
    });

    await vi.waitFor(() => {
      expect(deleteMyCommands).toHaveBeenCalled();
    });

    // setMyCommands must NOT be attempted — the API is unreachable.
    expect(setMyCommands).not.toHaveBeenCalled();
    // deleteMyCommands failure is still logged once.
    expect(runtimeError).toHaveBeenCalledTimes(1);
    expect(runtimeError.mock.calls[0]?.[0]).toContain("deleteMyCommands");
  });

  it("still calls setMyCommands when deleteMyCommands fails with a 4xx client error", async () => {
    const clientError = Object.assign(new Error("Bad Request"), { error_code: 400 });
    const deleteMyCommands = vi.fn().mockRejectedValue(clientError);
    const setMyCommands = vi.fn().mockResolvedValue(undefined);
    const runtimeError = vi.fn();

    syncTelegramMenuCommands({
      bot: {
        api: { deleteMyCommands, setMyCommands },
      } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
      runtime: {
        error: runtimeError,
      } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["runtime"],
      commandsToRegister: [{ command: "cmd", description: "Command" }],
    });

    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalled();
    });

    // deleteMyCommands failure logged, setMyCommands succeeded (no additional error).
    expect(runtimeError).toHaveBeenCalledTimes(1);
    expect(runtimeError.mock.calls[0]?.[0]).toContain("deleteMyCommands");
  });
});
