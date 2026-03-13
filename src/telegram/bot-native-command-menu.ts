import type { Bot } from "grammy";
import { GrammyError } from "grammy";
import {
  normalizeTelegramCommandName,
  TELEGRAM_COMMAND_NAME_PATTERN,
} from "../config/telegram-custom-commands.js";
import type { RuntimeEnv } from "../runtime.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";

// Telegram's documented limit is 100, but the API rejects with BOT_COMMANDS_TOO_MUCH
// at exactly 100 in practice. Cap at 99 to stay safely under the enforced threshold.
export const TELEGRAM_MAX_COMMANDS = 99;

// Pattern matching the Telegram error code for too many commands.
const BOT_COMMANDS_TOO_MUCH_RE = /BOT_COMMANDS_TOO_MUCH/;
// Max self-healing retries: reduce command count one-by-one until the API accepts it.
const SET_COMMANDS_MAX_RETRIES = 5;

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

    // Self-healing retry: Telegram may reject at a limit slightly below the
    // documented 100 (BOT_COMMANDS_TOO_MUCH). Drop the last command and retry
    // up to SET_COMMANDS_MAX_RETRIES times so the installed binary also heals.
    let cmds = commandsToRegister;
    for (let attempt = 0; attempt <= SET_COMMANDS_MAX_RETRIES; attempt++) {
      runtime.log?.(`Registering ${cmds.length} Telegram bot commands`);
      try {
        await bot.api.setMyCommands(cmds);
        return; // success — exit the sync fn
      } catch (err) {
        const isTooMuch =
          (err instanceof GrammyError && BOT_COMMANDS_TOO_MUCH_RE.test(err.description)) ||
          BOT_COMMANDS_TOO_MUCH_RE.test(String(err));
        if (isTooMuch && cmds.length > 0 && attempt < SET_COMMANDS_MAX_RETRIES) {
          runtime.error?.(
            `telegram setMyCommands: BOT_COMMANDS_TOO_MUCH at ${cmds.length} commands — retrying with ${cmds.length - 1}`,
          );
          cmds = cmds.slice(0, -1);
        } else {
          // Not a retryable error, or retries exhausted — log via standard helper.
          await withTelegramApiErrorLogging({
            operation: "setMyCommands",
            runtime,
            fn: () => Promise.reject(err),
          });
        }
      }
    }
  };

  void sync().catch((err) => {
    runtime.error?.(`Telegram command sync failed: ${String(err)}`);
  });
}
