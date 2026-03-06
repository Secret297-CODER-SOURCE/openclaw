// plugins/telegram/src/behaviors/AiReplyEngine.ts
import Anthropic from "@anthropic-ai/sdk";

export type ModelMessage = { role: "user" | "assistant"; content: string };

/**
 * Adapter interface for generating AI replies.
 * Receives the full conversation history, system prompt, and an optional
 * session key (used by the gateway adapter to identify the conversation).
 */
export type ModelAdapter = (
  messages: ModelMessage[],
  systemPrompt: string,
  sessionKey?: string,
) => Promise<string>;

// ─── Module-level configured adapter ─────────────────────────────────────────

// Set once by the plugin host (index.ts) during gateway_start.
// Falls back to env-var auto-detection when not set.
let _adapter: ModelAdapter | null = null;
// Cached env-resolved adapter so we don't re-create adapters on every call.
let _cachedEnvAdapter: ModelAdapter | null = null;

/**
 * Set the model adapter used by aiReply().
 * Called once from the plugin host during initialisation so the extension can
 * use OpenClaw's configured AI provider without needing a separate API key.
 */
export function setModelAdapter(adapter: ModelAdapter): void {
  _adapter = adapter;
  _cachedEnvAdapter = null;
  cachedAnthropicClient = null;
}

// ─── Anthropic adapter (env-var fallback) ─────────────────────────────────────

// Lazy Anthropic client — created on the first AI call.
let cachedAnthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!cachedAnthropicClient) {
    cachedAnthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  }
  return cachedAnthropicClient;
}

function makeAnthropicAdapter(): ModelAdapter {
  const model = process.env.TG_AI_MODEL?.trim() || "claude-3-5-sonnet-20241022";
  return async (messages, systemPrompt) => {
    const res = await getAnthropicClient().messages.create({
      model,
      max_tokens: 2048,
      system: systemPrompt,
      messages,
    });
    return res.content[0].type === "text" ? res.content[0].text : "…";
  };
}

// ─── OpenAI-compatible adapter ────────────────────────────────────────────────

/**
 * Build an adapter that calls any OpenAI-compatible chat completions endpoint.
 * Uses the global fetch available in Node 18+.
 * When sessionKey is provided it is forwarded as the `user` field so the server
 * can maintain per-conversation sessions (used by the OpenClaw gateway).
 */
export function makeOpenAiCompatAdapter(
  baseUrl: string,
  apiKey: string,
  model: string,
): ModelAdapter {
  const base = baseUrl.replace(/\/$/, "");
  return async (messages, systemPrompt, sessionKey) => {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        max_tokens: 2048,
        // Pass chatKey as `user` so the gateway creates a per-conversation session.
        ...(sessionKey ? { user: sessionKey } : {}),
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`AI request failed (${response.status}): ${body.slice(0, 200)}`);
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content?.trim() ?? "…";
  };
}

// ─── Adapter resolution ────────────────────────────────────────────────────────

/**
 * Resolve the adapter to use for AI replies.
 * Priority:
 *   1. Explicitly configured via setModelAdapter() — gateway adapter is set here
 *      during plugin initialisation (routes through the main OpenClaw agent).
 *   2. ANTHROPIC_API_KEY env var — direct Anthropic SDK.
 *   3. OPENAI_API_KEY / OPENAI_BASE_URL env vars — any OpenAI-compatible API.
 *   4. Throws with setup instructions if nothing is configured.
 */
function resolveAdapter(): ModelAdapter {
  if (_adapter) return _adapter;
  if (_cachedEnvAdapter) return _cachedEnvAdapter;

  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (anthropicKey) {
    _cachedEnvAdapter = makeAnthropicAdapter();
    return _cachedEnvAdapter;
  }

  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  const openaiBase = process.env.OPENAI_BASE_URL?.trim();
  if (openaiKey || openaiBase) {
    const baseUrl = (openaiBase ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const model = process.env.TG_AI_MODEL?.trim() || "gpt-4o";
    _cachedEnvAdapter = makeOpenAiCompatAdapter(baseUrl, openaiKey ?? "", model);
    return _cachedEnvAdapter;
  }

  throw new Error(
    "No AI provider configured for Telegram Manager. " +
      "Either set ANTHROPIC_API_KEY, OPENAI_API_KEY, or ensure the OpenClaw gateway " +
      "is running with a configured AI provider (e.g. GitHub Copilot).",
  );
}

// ─── Conversation history ──────────────────────────────────────────────────────

// In-memory cache for fast access; backed by optional persistent storage.
const histories = new Map<string, ModelMessage[]>();

/** Minimal storage interface for conversation persistence. */
export interface ConversationStorage {
  loadConversationHistory(chatKey: string): ModelMessage[];
  saveConversationHistory(chatKey: string, messages: ModelMessage[]): void;
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

  const adapter = resolveAdapter();
  // Pass chatKey as sessionKey so adapters that support it (e.g. the gateway
  // adapter) can maintain per-conversation sessions on the server side.
  const reply = await adapter(hist, systemPrompt, chatKey);

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
