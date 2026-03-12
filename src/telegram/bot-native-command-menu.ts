import type { Bot } from "grammy";
import {
  normalizeTelegramCommandDescription,
  normalizeTelegramCommandName,
  TELEGRAM_COMMAND_DESCRIPTION_MIN_LENGTH,
  TELEGRAM_COMMAND_NAME_PATTERN,
} from "../config/telegram-custom-commands.js";
import { danger } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";

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
    const description = normalizeTelegramCommandDescription(spec.description);
    if (!description) {
      issues.push(`Plugin command "/${normalized}" is missing a description.`);
      continue;
    }
    if (description.length < TELEGRAM_COMMAND_DESCRIPTION_MIN_LENGTH) {
      issues.push(
        `Plugin command "/${normalized}" description is too short (minimum ${TELEGRAM_COMMAND_DESCRIPTION_MIN_LENGTH} characters).`,
      );
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

export function syncTelegramMenuCommands(params: {
  bot: Bot;
  runtime: RuntimeEnv;
  commandsToRegister: TelegramMenuCommand[];
}): void {
  const { bot, runtime, commandsToRegister } = params;
  const sync = async () => {
    // Keep delete -> set ordering to avoid stale deletions racing after fresh registrations.
    if (typeof bot.api.deleteMyCommands === "function") {
      await withTelegramApiErrorLogging({
        operation: "deleteMyCommands",
        runtime,
        fn: () => bot.api.deleteMyCommands(),
      }).catch(() => {});
    }

    if (commandsToRegister.length === 0) {
      return;
    }

    await withTelegramApiErrorLogging({
      operation: "setMyCommands",
      runtime,
      fn: () => bot.api.setMyCommands(commandsToRegister),
    }).catch(() => {
      // withTelegramApiErrorLogging already logged the error above.
      // Catch here to prevent the outer void sync().catch from logging a
      // second "command sync failed" message for the same failure.
    });
  };

  void sync().catch((err) => {
    // API errors are already logged by withTelegramApiErrorLogging and silently
    // swallowed by the inner .catch() above. This outer catch only fires for
    // unexpected non-API errors (e.g. programming errors inside sync()).
    runtime.error?.(danger(`telegram command sync failed: ${String(err)}`));
  });
}
