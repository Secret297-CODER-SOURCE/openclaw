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
// Separate cache for the direct (non-gateway) adapter used in batch analysis.
// Not cleared by setModelAdapter() so it survives gateway adapter registration.
let _cachedDirectAdapter: ModelAdapter | null = null;

/**
 * Clear the direct-adapter cache so the next call re-reads ANTHROPIC_API_KEY
 * from process.env. Call this after programmatically setting the key at runtime.
 */
export function resetDirectAdapter(): void {
  _cachedDirectAdapter = null;
  cachedAnthropicClient = null;
}

// Gateway connection info stored separately so vision calls can use it directly.
let _gatewayConfig: { baseUrl: string; token: string; model: string } | null = null;

/**
 * Set the model adapter used by aiReply().
 * Called once from the plugin host during initialisation so the extension can
 * use OpenClaw's configured AI provider without needing a separate API key.
 */
export function setModelAdapter(adapter: ModelAdapter): void {
  _adapter = adapter;
  _cachedEnvAdapter = null;
  cachedAnthropicClient = null;
  // NOTE: _cachedDirectAdapter is intentionally NOT cleared here so that
  // direct env-var adapters (for batch analysis) remain available even after
  // the gateway adapter is registered.
}

/**
 * Store gateway connection details so analyzeImageOnce() can make vision calls
 * through the gateway's OpenAI-compatible endpoint.
 * Call this from the plugin host alongside setModelAdapter().
 */
export function setGatewayConfig(cfg: { baseUrl: string; token: string; model: string }): void {
  _gatewayConfig = cfg;
}

/**
 * Returns true if a direct AI adapter (Anthropic or OpenAI-compatible env vars)
 * is available. When true, analyzeOnceDirect() bypasses the gateway lane and
 * can run many calls in parallel without causing lane congestion.
 */
export function isDirectAdapterAvailable(): boolean {
  return !!(
    process.env.ANTHROPIC_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.OPENAI_BASE_URL?.trim()
  );
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

// ─── One-shot analysis calls ──────────────────────────────────────────────────

const ANALYSIS_SYSTEM_PROMPT =
  "You are a helpful assistant. When asked for JSON output, respond ONLY with valid JSON — no markdown fences, no prose explanation.";

/**
 * Resolve a direct (non-gateway) adapter using env-var API keys.
 * Returns null if no direct key is configured.
 */
function resolveAdapterDirect(): ModelAdapter | null {
  if (_cachedDirectAdapter) return _cachedDirectAdapter;

  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (anthropicKey) {
    _cachedDirectAdapter = makeAnthropicAdapter();
    return _cachedDirectAdapter;
  }

  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  const openaiBase = process.env.OPENAI_BASE_URL?.trim();
  if (openaiKey || openaiBase) {
    const baseUrl = (openaiBase ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const model = process.env.TG_AI_MODEL?.trim() || "gpt-4o";
    _cachedDirectAdapter = makeOpenAiCompatAdapter(baseUrl, openaiKey ?? "", model);
    return _cachedDirectAdapter;
  }

  return null; // no direct adapter available
}

/**
 * Make a single stateless AI call via the gateway adapter.
 * Uses the main lane — limit concurrency to avoid lane congestion.
 */
export async function analyzeOnce(userMessage: string): Promise<string> {
  const adapter = resolveAdapter();
  return adapter([{ role: "user", content: userMessage }], ANALYSIS_SYSTEM_PROMPT);
}

/**
 * Make a single stateless AI call, preferring a DIRECT API adapter
 * (ANTHROPIC_API_KEY / OPENAI_API_KEY) over the gateway adapter.
 *
 * Direct calls bypass the gateway main lane entirely, so many of these can
 * run in parallel without queueAhead warnings. Falls back to analyzeOnce()
 * (gateway lane) when no direct key is configured.
 */
export async function analyzeOnceDirect(userMessage: string): Promise<string> {
  const direct = resolveAdapterDirect();
  if (direct) {
    return direct([{ role: "user", content: userMessage }], ANALYSIS_SYSTEM_PROMPT);
  }
  // No direct key — use the gateway adapter (lane-limited, caller should limit concurrency)
  return analyzeOnce(userMessage);
}

// ─── Vision / image analysis ─────────────────────────────────────────────────

/**
 * Analyze an image using the best available AI provider:
 *   1. ANTHROPIC_API_KEY  → Anthropic SDK vision (direct)
 *   2. OPENAI_API_KEY / OPENAI_BASE_URL → OpenAI-compatible vision (direct)
 *   3. Gateway (configured via setGatewayConfig) → OpenAI-compatible vision via local gateway
 * Throws if no provider is configured.
 */
export async function analyzeImageOnce(
  imageBase64: string,
  mediaType: string,
  textPrompt: string,
  systemPrompt: string,
): Promise<string> {
  // 1. Direct Anthropic vision
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (anthropicKey) {
    const client = getAnthropicClient();
    const model = process.env.TG_AI_MODEL?.trim() || "claude-3-5-sonnet-20241022";
    const res = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                data: imageBase64,
              },
            },
            { type: "text", text: textPrompt },
          ],
        },
      ],
    });
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }

  // 2. OpenAI-compatible vision (env key or gateway)
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  const openaiBase = process.env.OPENAI_BASE_URL?.trim();
  let visionBaseUrl: string;
  let visionToken: string;
  let visionModel: string;

  if (openaiKey || openaiBase) {
    visionBaseUrl = (openaiBase ?? "https://api.openai.com/v1").replace(/\/$/, "");
    visionToken = openaiKey ?? "";
    visionModel = process.env.TG_AI_MODEL?.trim() || "gpt-4o";
  } else if (_gatewayConfig) {
    // Fall back to the local OpenClaw gateway
    visionBaseUrl = _gatewayConfig.baseUrl.replace(/\/$/, "");
    visionToken = _gatewayConfig.token;
    visionModel = _gatewayConfig.model;
  } else {
    throw new Error(
      "No AI provider configured for image analysis. " +
        "Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or ensure the OpenClaw gateway is running.",
    );
  }

  const response = await fetch(`${visionBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(visionToken ? { Authorization: `Bearer ${visionToken}` } : {}),
    },
    body: JSON.stringify({
      model: visionModel,
      max_tokens: 4096,
      messages: [
        ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mediaType};base64,${imageBase64}` },
            },
            { type: "text", text: textPrompt },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Vision AI request failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
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
    reply = await withTimeout(
      runAnthropicWithTools(msgs, systemPrompt, workspaceTools),
      AI_REPLY_TIMEOUT_MS,
      "aiReply+tools",
    );
  } else {
    const adapter = resolveAdapter();
    reply = await withTimeout(adapter(hist, systemPrompt, chatKey), AI_REPLY_TIMEOUT_MS, "aiReply");
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

/**
 * Invalidate the in-memory history cache for a chat key WITHOUT clearing storage.
 * Call this after writing history directly to storage (e.g. via persistHistory in
 * schema KB path) so the next aiReply() call reloads the freshly written history.
 */
export function invalidateHistoryCache(chatKey: string): void {
  histories.delete(chatKey);
}

/**
 * Patch the last assistant entry in the in-memory history cache and persist it.
 * Used to replace rawReply (saved by aiReply) with the actual sent reply after
 * BRANCH-stripping, strict rebuild, or enforceWorkingHours post-processing.
 */
export function updateLastAssistantReply(
  chatKey: string,
  finalReply: string,
  storage?: ConversationStorage,
): void {
  const hist = histories.get(chatKey);
  if (!hist) return;
  // Walk backwards to find the most recent assistant turn.
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].role === "assistant") {
      hist[i] = { role: "assistant", content: finalReply };
      if (storage) storage.saveConversationHistory(chatKey, hist);
      return;
    }
  }
}

/** Race a promise against a timeout. Rejects with a clear error on expiry. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`AI timeout (${ms}ms): ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Default timeout for single AI calls (60 s). */
const AI_CALL_TIMEOUT_MS = 60_000;
/** Default timeout for conversational AI replies (90 s, longer for tool-use). */
const AI_REPLY_TIMEOUT_MS = 90_000;

/**
 * One-shot text completion using the configured model adapter.
 * Does NOT maintain conversation history — use for single prompts such as AI-driven
 * classification, distribution or summarisation tasks.
 */
export async function callAdapterOnce(userPrompt: string, systemPrompt: string): Promise<string> {
  const adapter = resolveAdapter();
  const msgs: ModelMessage[] = [{ role: "user", content: userPrompt }];
  return withTimeout(adapter(msgs, systemPrompt), AI_CALL_TIMEOUT_MS, "callAdapterOnce");
}

/**
 * Like `callAdapterOnce` but enforces a JSON response.
 * If the first attempt returns no JSON object/array, retries once with an
 * explicit correction message so the model understands it must output pure JSON.
 */
export async function callAdapterOnceJson(
  userPrompt: string,
  systemPrompt: string,
): Promise<string> {
  // Reinforce the JSON-only requirement in both the system prompt and user message
  const jsonSystem =
    systemPrompt +
    "\n\nCRITICAL: Your ENTIRE response must be a single valid JSON object. " +
    "Do NOT write any explanations, greetings, questions or prose. " +
    "Start your response with { and end with }. Nothing else.";

  const jsonUser =
    userPrompt +
    "\n\n⚠️ IMPORTANT: Respond with ONLY a raw JSON object. No text before or after it. No markdown.";

  const adapter = resolveAdapter();
  const firstReply = await withTimeout(
    adapter([{ role: "user", content: jsonUser }], jsonSystem),
    AI_CALL_TIMEOUT_MS,
    "callAdapterOnceJson",
  );

  // Check if there is a JSON object or array in the response
  const hasJson = firstReply.includes("{") || firstReply.includes("[");
  if (hasJson) return firstReply;

  // Retry: show the model what it did wrong and demand JSON
  const retryMsgs: ModelMessage[] = [
    { role: "user", content: jsonUser },
    { role: "assistant", content: firstReply },
    {
      role: "user",
      content:
        "Your previous response was plain text, not JSON. " +
        "You MUST respond with ONLY a valid JSON object starting with { and ending with }. " +
        "No explanations. No questions. ONLY the JSON.",
    },
  ];
  return withTimeout(
    adapter(retryMsgs, jsonSystem),
    AI_CALL_TIMEOUT_MS,
    "callAdapterOnceJson-retry",
  );
}
