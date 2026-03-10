// plugins/telegram/src/behaviors/AiReplyEngine.ts
import Anthropic from "@anthropic-ai/sdk";
import {
  WorkspaceTools,
  workspaceToolDefs,
  ReadableFile,
  WritableFile,
} from "../tools/TelegramTools";

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

// ─── Workspace tool-calling loop (Anthropic only) ─────────────────────────────

/**
 * Run an agentic Anthropic call that allows the agent to read/write its own
 * workspace files. Loops up to 5 iterations while the model issues tool calls,
 * then returns the final text response.
 *
 * Only available when ANTHROPIC_API_KEY is set; callers must check this first.
 */
async function runAnthropicWithTools(
  messages: Anthropic.MessageParam[],
  systemPrompt: string,
  tools: WorkspaceTools,
): Promise<string> {
  const client = getAnthropicClient();
  const model = process.env.TG_AI_MODEL?.trim() || "claude-3-5-sonnet-20241022";
  // Work on a copy so we don't mutate the caller's history during the loop.
  const msgs: Anthropic.MessageParam[] = [...messages];

  for (let i = 0; i < 5; i++) {
    const res = await client.messages.create({
      model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: msgs,
      tools: workspaceToolDefs as unknown as Anthropic.Tool[],
    });

    if (res.stop_reason !== "tool_use") {
      // No tool calls — return the text content.
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      return text || "…";
    }

    // Append the assistant turn (includes both text and tool_use blocks).
    msgs.push({ role: "assistant", content: res.content });

    // Execute each tool call and collect results.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      let output: string;
      try {
        if (block.name === "read_workspace_file") {
          const { filename } = block.input as { filename: ReadableFile };
          output = (await tools.readFile(filename)) || "(empty)";
        } else if (block.name === "write_workspace_file") {
          const { filename, content } = block.input as { filename: WritableFile; content: string };
          await tools.writeFile(filename, content);
          output = `Updated ${filename}`;
        } else {
          output = `Unknown tool: ${block.name}`;
        }
      } catch (e) {
        output = `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }

    // Feed results back for the next iteration.
    msgs.push({ role: "user", content: toolResults });
  }

  return "…"; // fallback after max iterations
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
  workspaceTools?: WorkspaceTools,
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

  let reply: string;

  // Use the Anthropic tool-calling path when workspace tools are provided and
  // a direct Anthropic key is configured. Falls back to the generic adapter
  // (gateway / OpenAI-compatible) which does not support tool calling.
  if (workspaceTools && process.env.ANTHROPIC_API_KEY?.trim()) {
    const msgs: Anthropic.MessageParam[] = hist.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    reply = await runAnthropicWithTools(msgs, systemPrompt, workspaceTools);
  } else {
    const adapter = resolveAdapter();
    // Pass chatKey as sessionKey so adapters that support it (e.g. the gateway
    // adapter) can maintain per-conversation sessions on the server side.
    reply = await adapter(hist, systemPrompt, chatKey);
  }

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
