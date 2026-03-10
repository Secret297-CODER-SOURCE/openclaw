import { updateSessionStoreEntry } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";

const CONFIRM_COMMANDS = new Set(["/confirm", "/agree", "/yes"]);
const REJECT_COMMANDS = new Set(["/reject", "/cancel", "/no"]);
const DIALOGUE_COMMAND_PREFIX = "/dialogue";

/**
 * Handles explicit /confirm (/agree, /yes) and /reject (/cancel, /no) commands as
 * well as /dialogue management commands.
 *
 * /confirm – clears pendingConfirmation with a "confirmed" note.
 * /reject  – clears pendingConfirmation with a "rejected" note.
 * /dialogue status – reports the current dialogue state.
 * /dialogue confirm-required on|off – toggle confirmationRequired mode.
 */
export const handleDialogueCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const body = params.command.commandBodyNormalized.trim().toLowerCase();
  const firstWord = body.split(/\s+/)[0];

  // ── /confirm | /agree | /yes ──────────────────────────────────────────────
  if (CONFIRM_COMMANDS.has(firstWord)) {
    if (!params.command.isAuthorizedSender) {
      logVerbose(`Ignoring ${firstWord} from unauthorized sender`);
      return { shouldContinue: false };
    }
    const entry = params.sessionEntry;
    const pending = entry?.pendingConfirmation;
    if (!pending) {
      return {
        shouldContinue: false,
        reply: { text: "ℹ️ There is nothing awaiting confirmation right now." },
      };
    }
    if (params.storePath && params.sessionKey) {
      await updateSessionStoreEntry({
        storePath: params.storePath,
        sessionKey: params.sessionKey,
        update: async () => ({ pendingConfirmation: undefined }),
      });
    }
    return {
      shouldContinue: false,
      reply: {
        text:
          `✅ Confirmed: "${pending.task}"\n\n` +
          `Send your next message and the agent will proceed with the confirmed action.`,
      },
    };
  }

  // ── /reject | /cancel | /no ───────────────────────────────────────────────
  if (REJECT_COMMANDS.has(firstWord)) {
    if (!params.command.isAuthorizedSender) {
      logVerbose(`Ignoring ${firstWord} from unauthorized sender`);
      return { shouldContinue: false };
    }
    const entry = params.sessionEntry;
    const pending = entry?.pendingConfirmation;
    if (!pending) {
      return {
        shouldContinue: false,
        reply: { text: "ℹ️ There is nothing awaiting confirmation right now." },
      };
    }
    if (params.storePath && params.sessionKey) {
      await updateSessionStoreEntry({
        storePath: params.storePath,
        sessionKey: params.sessionKey,
        update: async () => ({ pendingConfirmation: undefined }),
      });
    }
    return {
      shouldContinue: false,
      reply: {
        text:
          `❌ Cancelled: "${pending.task}"\n\n` +
          `Send your next message to tell the agent what you'd like to do instead.`,
      },
    };
  }

  // ── /dialogue ─────────────────────────────────────────────────────────────
  if (!body.startsWith(DIALOGUE_COMMAND_PREFIX)) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose("Ignoring /dialogue from unauthorized sender");
    return { shouldContinue: false };
  }

  const rest = body.slice(DIALOGUE_COMMAND_PREFIX.length).trim();

  // /dialogue status
  if (!rest || rest === "status") {
    const entry = params.sessionEntry;
    const pending = entry?.pendingConfirmation;
    const confirmRequired = entry?.confirmationRequired ?? false;
    const lines: string[] = ["📋 **Dialogue state**"];
    lines.push(confirmRequired ? "• Mode: confirmation-required ✅" : "• Mode: normal");
    if (pending) {
      const age = Math.round((Date.now() - pending.sentAt) / 1000);
      lines.push(`• Pending confirmation (${age}s ago): "${pending.task}"`);
      lines.push('• Use /confirm or /reject to respond, or just type "yes"/"no".');
    } else {
      lines.push("• No pending confirmation");
    }
    return { shouldContinue: false, reply: { text: lines.join("\n") } };
  }

  // /dialogue confirm-required on|off
  const crMatch = rest.match(/^confirm-required\s+(on|off|true|false|enable|disable)$/i);
  if (crMatch) {
    const value = /^(on|true|enable)$/i.test(crMatch[1]);
    if (params.storePath && params.sessionKey) {
      await updateSessionStoreEntry({
        storePath: params.storePath,
        sessionKey: params.sessionKey,
        update: async () => ({ confirmationRequired: value }),
      });
    }
    const label = value ? "enabled ✅" : "disabled";
    return {
      shouldContinue: false,
      reply: {
        text:
          `✅ Confirmation-required mode ${label}. The agent will now ` +
          (value
            ? "always ask for your agreement before taking significant actions."
            : "proceed without requesting explicit confirmation."),
      },
    };
  }

  return {
    shouldContinue: false,
    reply: {
      text:
        "Usage:\n" +
        "• `/dialogue status` – show current dialogue state\n" +
        "• `/dialogue confirm-required on|off` – toggle confirmation-required mode\n" +
        "• `/confirm` (or /agree, /yes) – confirm a pending action\n" +
        "• `/reject` (or /cancel, /no) – reject/cancel a pending action",
    },
  };
};
