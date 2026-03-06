// plugins/telegram/src/behaviors/AiReplyEngine.ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// In-memory cache for fast access; backed by optional persistent storage.
const histories = new Map<string, { role: "user" | "assistant"; content: string }[]>();

/** Minimal storage interface for conversation persistence. */
export interface ConversationStorage {
  loadConversationHistory(chatKey: string): { role: "user" | "assistant"; content: string }[];
  saveConversationHistory(
    chatKey: string,
    messages: { role: "user" | "assistant"; content: string }[],
  ): void;
}

/** Maximum number of messages kept per conversation (user + assistant turns). */
const MAX_HISTORY = 50;

export async function aiReply(
  text: string,
  chatKey: string, // agentId + chatId — unique per conversation
  systemPrompt = "You are a helpful Telegram assistant. Be concise and friendly.",
  storage?: ConversationStorage,
): Promise<string> {
  // Warm the in-memory cache from persistent storage on the first message
  // for this chat key (e.g. after an agent restart).
  let hist = histories.get(chatKey);
  if (hist === undefined) {
    // Cache is cold — load from storage (even an empty array is cached so we
    // don't hit the DB again on subsequent messages in the same session).
    hist = storage ? storage.loadConversationHistory(chatKey) : [];
    histories.set(chatKey, hist);
  }

  hist.push({ role: "user", content: text });
  if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);

  const res = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    system: systemPrompt,
    messages: hist,
  });

  const reply = res.content[0].type === "text" ? res.content[0].text : "…";
  hist.push({ role: "assistant", content: reply });
  histories.set(chatKey, hist);
  // Persist after every turn so history survives agent restarts.
  if (storage) storage.saveConversationHistory(chatKey, hist);
  return reply;
}

export function clearHistory(chatKey: string, storage?: ConversationStorage) {
  histories.delete(chatKey);
  if (storage) storage.saveConversationHistory(chatKey, []);
}
