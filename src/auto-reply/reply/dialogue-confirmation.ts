/**
 * Dialogue confirmation loop support.
 *
 * Provides helpers to:
 *  - Detect whether a user message is confirming or rejecting a pending action.
 *  - Detect whether an agent response is requesting confirmation from the user.
 *  - Build prompt notes that tell the agent about a pending confirmation state.
 */

import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionStore } from "../../config/sessions.js";

/** Maximum character length for a task description in a pending confirmation entry. */
const MAX_TASK_DESCRIPTION_LENGTH = 120;

/** Words/phrases a user might send to confirm an action (English + Russian). */
const CONFIRMATION_PATTERNS: RegExp[] = [
  /^(yes|yeah|yep|yup|sure|ok|okay|k|agree|confirmed|confirm|proceed|go\s+ahead|do\s+it|sounds\s+good|absolutely|definitely|affirmative|correct|right|exactly|perfect|great|fine)[\s!.]*$/i,
  /^(да|ок|окей|согласен|согласна|подтверждаю|подтвердить|продолжай|продолжать|давай|верно|точно|отлично|хорошо)[\s!.]*$/i,
  /\b(yes|confirm|proceed|agree)\b/i,
  /\b(да|подтверждаю|согласен|согласна)\b/i,
];

/** Words/phrases a user might send to reject/cancel a pending action (English + Russian). */
const REJECTION_PATTERNS: RegExp[] = [
  /^(no|nope|nah|cancel|reject|stop|abort|don'?t|never|negative|disagree|skip)[\s!.]*$/i,
  /^(нет|не\s+надо|отмена|отменить|стоп|отказ|отказаться|не\s+соглашусь|не\s+буду)[\s!.]*$/i,
  /\b(cancel|reject|abort|stop)\b/i,
  /\b(нет|отмена|отказ)\b/i,
];

/**
 * Patterns indicating an agent response is requesting explicit user confirmation.
 */
const AGENT_CONFIRMATION_REQUEST_PATTERNS: RegExp[] = [
  /\bplease\s+confirm\b/i,
  /\bdo\s+you\s+(?:confirm|agree|approve)\b/i,
  /\bwould\s+you\s+like\s+(?:me\s+to\s+)?proceed\b/i,
  /\bshall\s+i\s+proceed\b/i,
  /\bcan\s+i\s+proceed\b/i,
  /\bneed\s+your\s+(?:confirmation|approval|agreement)\b/i,
  /\bwaiting\s+for\s+(?:your\s+)?(?:confirmation|approval|agreement)\b/i,
  /\bconfirm\s+(?:this|that|the|your)\b/i,
  // Russian patterns (use (?:^|\s) instead of \b — \b doesn't work with Cyrillic in JS)
  /(?:^|\s)подтвердите(?:\s|[,.:!?]|$)/i,
  /(?:^|\s)вы\s+подтверждаете(?:\s|[,.:!?]|$)/i,
  /(?:^|\s)ваше\s+подтверждение(?:\s|[,.:!?]|$)/i,
  /(?:^|\s)нужно\s+ваше\s+(?:согласие|подтверждение)(?:\s|[,.:!?]|$)/i,
];

/**
 * Returns true when the user message looks like an explicit confirmation.
 */
export function isConfirmationResponse(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return CONFIRMATION_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Returns true when the user message looks like an explicit rejection/cancellation.
 */
export function isRejectionResponse(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return REJECTION_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Returns true when the agent's response text contains a request for user confirmation.
 * This is used to automatically enter "awaiting confirmation" state.
 */
export function agentResponseRequestsConfirmation(text: string): boolean {
  if (!text.trim()) {
    return false;
  }
  return AGENT_CONFIRMATION_REQUEST_PATTERNS.some((re) => re.test(text));
}

/**
 * Builds a short note to prepend to the agent's prompt context when the session
 * is currently awaiting user confirmation for a specific task.
 */
export function buildPendingConfirmationNote(task: string): string {
  return (
    `[Dialogue state: awaiting user confirmation]\n` +
    `You previously proposed the following action and asked the user to confirm:\n` +
    `"${task}"\n` +
    `The user has not yet confirmed or rejected this action.\n` +
    `In your response, remind the user what you are waiting for and ask them to confirm ` +
    `(e.g. reply "yes", "ok", "да") or cancel (e.g. reply "no", "cancel", "нет").\n` +
    `Do NOT proceed with the action until the user explicitly confirms.`
  );
}

/**
 * Builds a short confirmation prompt that, when injected into the system prompt,
 * instructs the agent to seek user agreement before completing significant actions.
 */
export function buildConfirmationRequiredSystemNote(): string {
  return (
    `[Dialogue mode: confirmation required]\n` +
    `Before completing any significant action, you must:\n` +
    `1. Describe what you plan to do.\n` +
    `2. Explicitly ask the user to confirm (e.g. "Please confirm by replying yes/да") before proceeding.\n` +
    `3. Do NOT proceed until the user sends an explicit confirmation.\n` +
    `4. If the user says "no", "cancel", or "нет", stop and ask what they would like to do instead.\n` +
    `This ensures every important action has the user's agreement.`
  );
}

/**
 * When `pendingConfirmation` is set on the session and the raw user message is a
 * confirmation or rejection, prepend the appropriate context to the body and clear
 * the pending flag so the agent knows whether to proceed.
 *
 * Returns the (possibly modified) body string.
 */
export async function applyConfirmationContext(params: {
  body: string;
  rawUserMessage: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
}): Promise<string> {
  const { body, rawUserMessage, sessionEntry, sessionStore, sessionKey, storePath } = params;
  const pending = sessionEntry?.pendingConfirmation;
  if (!pending) {
    return body;
  }

  const confirmed = isConfirmationResponse(rawUserMessage);
  const rejected = isRejectionResponse(rawUserMessage);

  if (!confirmed && !rejected) {
    // Neither — leave body as-is; the system prompt note handles the reminder.
    return body;
  }

  // Clear pendingConfirmation from session
  if (sessionEntry) {
    sessionEntry.pendingConfirmation = undefined;
    sessionEntry.updatedAt = Date.now();
    if (sessionStore && sessionKey) {
      sessionStore[sessionKey] = sessionEntry;
    }
    if (storePath && sessionKey) {
      await updateSessionStore(storePath, (store) => {
        const existing = store[sessionKey];
        if (existing) {
          store[sessionKey] = {
            ...existing,
            pendingConfirmation: undefined,
            updatedAt: Date.now(),
          };
        }
      });
    }
  }

  if (confirmed) {
    const prefix =
      `[User confirmed the pending action]\n` +
      `Pending action: "${pending.task}"\n` +
      `The user has explicitly confirmed. Please proceed with the action.\n\n`;
    return `${prefix}${body}`;
  }

  // rejected
  const prefix =
    `[User rejected/cancelled the pending action]\n` +
    `Pending action: "${pending.task}"\n` +
    `The user has explicitly rejected/cancelled. Do NOT proceed with this action.\n` +
    `Ask the user what they would like to do instead.\n\n`;
  return `${prefix}${body}`;
}

/**
 * After the agent returns a response, inspect the response text and set
 * `pendingConfirmation` on the session if the agent is requesting confirmation.
 *
 * The `task` is derived from the command body that triggered the run.
 */
export async function setConfirmationPendingIfRequested(params: {
  responseText: string;
  commandBody: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
}): Promise<void> {
  const { responseText, commandBody, sessionEntry, sessionStore, sessionKey, storePath } = params;

  if (!agentResponseRequestsConfirmation(responseText)) {
    return;
  }
  // Build a short task description from the command body (first MAX_TASK_DESCRIPTION_LENGTH chars)
  const rawTask = commandBody.trim().slice(0, MAX_TASK_DESCRIPTION_LENGTH);
  const task = rawTask || "pending action";

  const pendingConfirmation = { task, sentAt: Date.now() };

  if (sessionEntry) {
    sessionEntry.pendingConfirmation = pendingConfirmation;
    sessionEntry.updatedAt = Date.now();
    if (sessionStore && sessionKey) {
      sessionStore[sessionKey] = sessionEntry;
    }
  }
  if (storePath && sessionKey) {
    await updateSessionStore(storePath, (store) => {
      const existing = store[sessionKey];
      if (existing) {
        store[sessionKey] = {
          ...existing,
          pendingConfirmation,
          updatedAt: Date.now(),
        };
      }
    });
  }
}
