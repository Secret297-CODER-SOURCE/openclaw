import type { Bot } from "grammy";
import {
  normalizeTelegramCommandName,
  TELEGRAM_COMMAND_NAME_PATTERN,
} from "../config/telegram-custom-commands.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { formatDurationPrecise } from "../infra/format-time/format-duration.js";
import type { RuntimeEnv } from "../runtime.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";

// Telegram's documented limit is 100, but the API rejects with BOT_COMMANDS_TOO_MUCH
// at exactly 100 in practice. Cap at 99 to stay safely under the enforced threshold.
export const TELEGRAM_MAX_COMMANDS = 99;

export type TelegramMenuCommand = {
  command: string;
  description: string;
};

type TelegramPluginCommandSpec = {
  name: string;
  description: string;
};

export function buildPluginTelegramMenuCommands(params: {
  specs: TelegramPluginCommandSpec[];
  existingCommands: Set<string>;
}): { commands: TelegramMenuCommand[]; issues: string[] } {
  const { specs, existingCommands } = params;
  const commands: TelegramMenuCommand[] = [];
  const issues: string[] = [];
  const pluginCommandNames = new Set<string>();

  for (const spec of specs) {
    const normalized = normalizeTelegramCommandName(spec.name);
    if (!normalized || !TELEGRAM_COMMAND_NAME_PATTERN.test(normalized)) {
      issues.push(
        `Plugin command "/${spec.name}" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).`,
      );
      continue;
    }
    const description = spec.description.trim();
    if (!description) {
      issues.push(`Plugin command "/${normalized}" is missing a description.`);
      continue;
    }
    if (existingCommands.has(normalized)) {
      if (pluginCommandNames.has(normalized)) {
        issues.push(`Plugin command "/${normalized}" is duplicated.`);
      } else {
        issues.push(`Plugin command "/${normalized}" conflicts with an existing Telegram command.`);
      }
      continue;
    }
    pluginCommandNames.add(normalized);
    existingCommands.add(normalized);
    commands.push({ command: normalized, description });
  }

  return { commands, issues };
}

export function buildCappedTelegramMenuCommands(params: {
  allCommands: TelegramMenuCommand[];
  maxCommands?: number;
}): {
  commandsToRegister: TelegramMenuCommand[];
  totalCommands: number;
  maxCommands: number;
  overflowCount: number;
} {
  const { allCommands } = params;
  const maxCommands = params.maxCommands ?? TELEGRAM_MAX_COMMANDS;
  const totalCommands = allCommands.length;
  const overflowCount = Math.max(0, totalCommands - maxCommands);
  const commandsToRegister = allCommands.slice(0, maxCommands);
  return { commandsToRegister, totalCommands, maxCommands, overflowCount };
}

// Retry policy for command sync when the network is recovering after an outage.
const COMMAND_SYNC_RETRY_POLICY = {
  initialMs: 3000,
  maxMs: 60_000,
  factor: 2,
  jitter: 0.25,
};

const MAX_COMMAND_SYNC_RETRIES = 5;

export function syncTelegramMenuCommands(params: {
  bot: Bot;
  runtime: RuntimeEnv;
  commandsToRegister: TelegramMenuCommand[];
  abortSignal?: AbortSignal;
}): void {
  const { bot, runtime, commandsToRegister, abortSignal } = params;
  const sync = async () => {
    let attempt = 0;
    while (true) {
      const isFinalAttempt = attempt >= MAX_COMMAND_SYNC_RETRIES;
      // Keep delete -> set ordering to avoid stale deletions racing after fresh registrations.
      if (typeof bot.api.deleteMyCommands === "function") {
        await withTelegramApiErrorLogging({
          operation: "deleteMyCommands",
          runtime,
          // Only log non-network errors or errors on the final attempt; transient
          // network failures are silently swallowed since we retry the full sync below.
          shouldLog: (err) =>
            isFinalAttempt || !isRecoverableTelegramNetworkError(err, { context: "unknown" }),
          fn: () => bot.api.deleteMyCommands(),
        }).catch(() => {});
      }

      if (commandsToRegister.length === 0) {
        return;
      }

      if (attempt === 0) {
        runtime.log?.(`Registering ${commandsToRegister.length} Telegram bot commands`);
      }

      try {
        await withTelegramApiErrorLogging({
          operation: "setMyCommands",
          runtime,
          // Only log on the final attempt or for non-network errors; intermediate
          // network failures during startup/reconnect are retried silently.
          shouldLog: (err) =>
            isFinalAttempt || !isRecoverableTelegramNetworkError(err, { context: "unknown" }),
          fn: () => bot.api.setMyCommands(commandsToRegister),
        });
        return;
      } catch (err) {
        if (
          isFinalAttempt ||
          abortSignal?.aborted ||
          !isRecoverableTelegramNetworkError(err, { context: "unknown" })
        ) {
          throw err;
        }
        attempt++;
        const delayMs = computeBackoff(COMMAND_SYNC_RETRY_POLICY, attempt);
        runtime.log?.(
          `Telegram command sync: network error, retrying in ${formatDurationPrecise(delayMs)}`,
        );
        try {
          await sleepWithAbort(delayMs, abortSignal);
        } catch {
          // Aborted during sleep - bail out cleanly without logging an error.
          return;
        }
      }
    }
  };

  void sync().catch((err) => {
    runtime.error?.(`Telegram command sync failed: ${String(err)}`);
  });
}
