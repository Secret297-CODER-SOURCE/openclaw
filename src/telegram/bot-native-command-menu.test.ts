import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCappedTelegramMenuCommands,
  buildPluginTelegramMenuCommands,
  syncTelegramMenuCommands,
} from "./bot-native-command-menu.js";

/** Creates a mock GrammyError representing the BOT_COMMANDS_TOO_MUCH response. */
function makeBotCommandsTooMuchError(): Error & { description: string } {
  return Object.assign(
    new Error("Call to 'setMyCommands' failed! (400: Bad Request: BOT_COMMANDS_TOO_MUCH)"),
    { description: "Bad Request: BOT_COMMANDS_TOO_MUCH" },
  );
}

/** Creates a grammy-style HttpError with a message indicating a network failure. */
function makeNetworkError(message: string): Error {
  const err = new Error(message) as Error & { name: string };
  err.name = "HttpError";
  return err;
}

const { computeBackoff, sleepWithAbort } = vi.hoisted(() => ({
  computeBackoff: vi.fn(() => 0),
  sleepWithAbort: vi.fn(async () => undefined),
}));

vi.mock("../infra/backoff.js", () => ({ computeBackoff, sleepWithAbort }));

describe("bot-native-command-menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sleepWithAbort.mockResolvedValue(undefined);
  });
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

  it("retries setMyCommands on recoverable network errors without logging intermediate failures", async () => {
    const networkErr = makeNetworkError("Network request for 'setMyCommands' failed!");
    const setMyCommands = vi
      .fn()
      .mockRejectedValueOnce(networkErr)
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValue(true);
    const deleteMyCommands = vi.fn().mockResolvedValue(true);
    const errorSpy = vi.fn();
    const logSpy = vi.fn();

    syncTelegramMenuCommands({
      bot: {
        api: { deleteMyCommands, setMyCommands },
      } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
      runtime: { error: errorSpy, log: logSpy } as unknown as Parameters<
        typeof syncTelegramMenuCommands
      >[0]["runtime"],
      commandsToRegister: [{ command: "cmd", description: "Command" }],
    });

    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalledTimes(3);
    });

    // No error-level logs should appear for intermediate network failures.
    expect(errorSpy).not.toHaveBeenCalled();
    // Retry info messages should be logged.
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("network error, retrying"));
  });

  it("logs error for setMyCommands after all retries are exhausted", async () => {
    const networkErr = makeNetworkError("Network request for 'setMyCommands' failed!");
    const setMyCommands = vi.fn().mockRejectedValue(networkErr);
    const deleteMyCommands = vi.fn().mockResolvedValue(true);
    const errorSpy = vi.fn();

    syncTelegramMenuCommands({
      bot: {
        api: { deleteMyCommands, setMyCommands },
      } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
      runtime: { error: errorSpy } as unknown as Parameters<
        typeof syncTelegramMenuCommands
      >[0]["runtime"],
      commandsToRegister: [{ command: "cmd", description: "Command" }],
    });

    await vi.waitFor(() => {
      // Should have tried 6 times total (1 initial + 5 retries = MAX_COMMAND_SYNC_RETRIES + 1).
      expect(setMyCommands).toHaveBeenCalledTimes(6);
    });

    // Final failure should be logged as an error.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Telegram command sync failed"));
  });

  it("suppresses deleteMyCommands network error logging", async () => {
    const networkErr = makeNetworkError("Network request for 'deleteMyCommands' failed!");
    const deleteMyCommands = vi.fn().mockRejectedValue(networkErr);
    const setMyCommands = vi.fn().mockResolvedValue(true);
    const errorSpy = vi.fn();

    syncTelegramMenuCommands({
      bot: {
        api: { deleteMyCommands, setMyCommands },
      } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
      runtime: { error: errorSpy } as unknown as Parameters<
        typeof syncTelegramMenuCommands
      >[0]["runtime"],
      commandsToRegister: [{ command: "cmd", description: "Command" }],
    });

    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalled();
    });

    // Network errors on deleteMyCommands must not be logged at error level.
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("deleteMyCommands"));
  });

  it("stops retrying when abortSignal fires during sleep", async () => {
    const networkErr = makeNetworkError("Network request for 'setMyCommands' failed!");
    const setMyCommands = vi.fn().mockRejectedValue(networkErr);
    const deleteMyCommands = vi.fn().mockResolvedValue(true);
    const errorSpy = vi.fn();

    const ac = new AbortController();

    // Make sleepWithAbort throw when aborted so the abort is detected.
    sleepWithAbort.mockImplementationOnce(async () => {
      ac.abort();
      throw new Error("aborted");
    });

    syncTelegramMenuCommands({
      bot: {
        api: { deleteMyCommands, setMyCommands },
      } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
      runtime: { error: errorSpy } as unknown as Parameters<
        typeof syncTelegramMenuCommands
      >[0]["runtime"],
      commandsToRegister: [{ command: "cmd", description: "Command" }],
      abortSignal: ac.signal,
    });

    await vi.waitFor(() => {
      // Sleep was called once then aborted - sync should have stopped.
      expect(sleepWithAbort).toHaveBeenCalledTimes(1);
    });

    // Only the first attempt should have run before abort.
    expect(setMyCommands).toHaveBeenCalledTimes(1);
    // No error logged when aborted.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("handles BOT_COMMANDS_TOO_MUCH with one specific error message and no retry", async () => {
    const tooMuchErr = makeBotCommandsTooMuchError();
    const setMyCommands = vi.fn().mockRejectedValue(tooMuchErr);
    const deleteMyCommands = vi.fn().mockResolvedValue(true);
    const errorSpy = vi.fn();

    syncTelegramMenuCommands({
      bot: {
        api: { deleteMyCommands, setMyCommands },
      } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
      runtime: { error: errorSpy } as unknown as Parameters<
        typeof syncTelegramMenuCommands
      >[0]["runtime"],
      commandsToRegister: [{ command: "cmd", description: "Command" }],
    });

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalled();
    });

    // Should only have tried once (no retries for BOT_COMMANDS_TOO_MUCH).
    expect(setMyCommands).toHaveBeenCalledTimes(1);
    // Should not have retried (sleepWithAbort not called).
    expect(sleepWithAbort).not.toHaveBeenCalled();
    // Should log exactly ONE error message with actionable guidance.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("BOT_COMMANDS_TOO_MUCH"));
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("channels.telegram.commands.native: false"),
    );
  });

  it("does not double-log BOT_COMMANDS_TOO_MUCH via withTelegramApiErrorLogging", async () => {
    // Verify that the specific "telegram setMyCommands failed: ..." line from
    // withTelegramApiErrorLogging is NOT emitted for BOT_COMMANDS_TOO_MUCH;
    // only the single actionable message from the catch block should appear.
    const tooMuchErr = makeBotCommandsTooMuchError();
    const setMyCommands = vi.fn().mockRejectedValue(tooMuchErr);
    const deleteMyCommands = vi.fn().mockResolvedValue(true);
    const errorSpy = vi.fn();

    syncTelegramMenuCommands({
      bot: {
        api: { deleteMyCommands, setMyCommands },
      } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
      runtime: { error: errorSpy } as unknown as Parameters<
        typeof syncTelegramMenuCommands
      >[0]["runtime"],
      commandsToRegister: [{ command: "cmd", description: "Command" }],
    });

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalled();
    });

    // Must be exactly one error log (not doubled by withTelegramApiErrorLogging).
    expect(errorSpy).toHaveBeenCalledTimes(1);
    // The logged message must NOT come from withTelegramApiErrorLogging (which would say
    // "telegram setMyCommands failed: ...").
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("telegram setMyCommands failed"),
    );
  });
});
