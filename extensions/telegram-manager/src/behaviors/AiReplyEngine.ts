// plugins/telegram/src/behaviors/AiReplyEngine.ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const histories = new Map<string, { role: "user" | "assistant"; content: string }[]>();

export async function aiReply(
  text: string,
  chatKey: string, // agentId + chatId — unique per conversation
  systemPrompt = "You are a helpful Telegram assistant. Be concise and friendly.",
): Promise<string> {
  const hist = histories.get(chatKey) || [];
  hist.push({ role: "user", content: text });
  if (hist.length > 20) hist.splice(0, hist.length - 20);

  const res = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: systemPrompt,
    messages: hist,
  });

  const reply = res.content[0].type === "text" ? res.content[0].text : "…";
  hist.push({ role: "assistant", content: reply });
  histories.set(chatKey, hist);
  return reply;
}

export function clearHistory(chatKey: string) {
  histories.delete(chatKey);
}
