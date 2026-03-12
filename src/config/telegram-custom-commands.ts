export const TELEGRAM_COMMAND_NAME_PATTERN = /^[a-z0-9_]{1,32}$/;
export const TELEGRAM_COMMAND_DESCRIPTION_MAX_LENGTH = 256;
export const TELEGRAM_COMMAND_DESCRIPTION_MIN_LENGTH = 3;

export type TelegramCustomCommandInput = {
  command?: string | null;
  description?: string | null;
};

export type TelegramCustomCommandIssue = {
  index: number;
  field: "command" | "description";
  message: string;
};

export function normalizeTelegramCommandName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const withoutSlash = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  return withoutSlash.trim().toLowerCase().replace(/-/g, "_");
}

export function normalizeTelegramCommandDescription(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length > TELEGRAM_COMMAND_DESCRIPTION_MAX_LENGTH) {
    // Truncate to fit Telegram's 256-character limit, appending an ellipsis.
    return trimmed.slice(0, TELEGRAM_COMMAND_DESCRIPTION_MAX_LENGTH - 1) + "…";
  }
  return trimmed;
}

export function resolveTelegramCustomCommands(params: {
  commands?: TelegramCustomCommandInput[] | null;
  reservedCommands?: Set<string>;
  checkReserved?: boolean;
  checkDuplicates?: boolean;
}): {
  commands: Array<{ command: string; description: string }>;
  issues: TelegramCustomCommandIssue[];
} {
  const entries = Array.isArray(params.commands) ? params.commands : [];
  const reserved = params.reservedCommands ?? new Set<string>();
  const checkReserved = params.checkReserved !== false;
  const checkDuplicates = params.checkDuplicates !== false;
  const seen = new Set<string>();
  const resolved: Array<{ command: string; description: string }> = [];
  const issues: TelegramCustomCommandIssue[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const normalized = normalizeTelegramCommandName(String(entry?.command ?? ""));
    if (!normalized) {
      issues.push({
        index,
        field: "command",
        message: "Telegram custom command is missing a command name.",
      });
      continue;
    }
    if (!TELEGRAM_COMMAND_NAME_PATTERN.test(normalized)) {
      issues.push({
        index,
        field: "command",
        message: `Telegram custom command "/${normalized}" is invalid (use a-z, 0-9, underscore; max 32 chars).`,
      });
      continue;
    }
    if (checkReserved && reserved.has(normalized)) {
      issues.push({
        index,
        field: "command",
        message: `Telegram custom command "/${normalized}" conflicts with a native command.`,
      });
      continue;
    }
    if (checkDuplicates && seen.has(normalized)) {
      issues.push({
        index,
        field: "command",
        message: `Telegram custom command "/${normalized}" is duplicated.`,
      });
      continue;
    }
    const description = normalizeTelegramCommandDescription(String(entry?.description ?? ""));
    if (!description) {
      issues.push({
        index,
        field: "description",
        message: `Telegram custom command "/${normalized}" is missing a description.`,
      });
      continue;
    }
    if (description.length < TELEGRAM_COMMAND_DESCRIPTION_MIN_LENGTH) {
      issues.push({
        index,
        field: "description",
        message: `Telegram custom command "/${normalized}" description is too short (minimum ${TELEGRAM_COMMAND_DESCRIPTION_MIN_LENGTH} characters).`,
      });
      continue;
    }
    if (checkDuplicates) {
      seen.add(normalized);
    }
    resolved.push({ command: normalized, description });
  }

  return { commands: resolved, issues };
}
