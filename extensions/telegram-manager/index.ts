import fs from "fs";
import os from "os";
import path from "path";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { makeOpenAiCompatAdapter, setModelAdapter } from "./src/behaviors/AiReplyEngine.js";
import { TelegramPlugin } from "./src/TelegramPlugin";
import type { GatewayMessage, IGatewayContext, ILogger } from "./src/types";

function resolveStateDir(): string {
  return process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
}

// ─── GitHub Copilot adapter auto-detection ────────────────────────────────────

/** Cached Copilot token file shape (written by OpenClaw core). */
type CachedCopilotToken = {
  token: string;
  /** milliseconds since epoch */
  expiresAt: number;
};

function deriveCopilotBase(token: string): string {
  const match = token.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
  const proxyEp = match?.[1]?.trim();
  if (proxyEp) {
    const host = proxyEp.replace(/^https?:\/\//, "").replace(/^proxy\./i, "api.");
    if (host) return `https://${host}`;
  }
  return "https://api.individual.githubcopilot.com";
}

async function exchangeCopilotToken(githubToken: string): Promise<CachedCopilotToken | null> {
  try {
    const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
      headers: { Authorization: `Bearer ${githubToken}`, "User-Agent": "openclaw-telegram" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { token?: string; expires_at?: number | string };
    const token = data.token?.trim();
    if (!token) return null;
    const raw = data.expires_at;
    let expiresAt: number;
    if (typeof raw === "number") {
      expiresAt = raw > 10_000_000_000 ? raw : raw * 1000;
    } else if (typeof raw === "string") {
      const n = parseInt(raw, 10);
      expiresAt = Number.isFinite(n)
        ? n > 10_000_000_000
          ? n
          : n * 1000
        : Date.now() + 25 * 60 * 1000;
    } else {
      expiresAt = Date.now() + 25 * 60 * 1000;
    }
    return { token, expiresAt };
  } catch {
    return null;
  }
}

/**
 * Read the GitHub token stored by OpenClaw's auth profile system.
 * Stored at: <stateDir>/agents/main/agent/auth-profiles.json
 * under profiles["github-copilot:github"].token
 */
function readStoredGithubToken(stateDir: string): string | null {
  const authProfilePath = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
  try {
    const raw = fs.readFileSync(authProfilePath, "utf-8");
    const store = JSON.parse(raw) as {
      profiles?: Record<string, { type?: string; token?: string }>;
    };
    const profile = store.profiles?.["github-copilot:github"];
    const token = profile?.token?.trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Try to set up the GitHub Copilot adapter by:
 * 1. Using the cached short-lived Copilot token (valid for ~30 min)
 * 2. Exchanging a fresh token via the stored GitHub auth profile
 * 3. Exchanging via env vars as last resort
 * Returns true when the adapter was configured successfully.
 */
async function trySetCopilotAdapter(logger: ILogger): Promise<boolean> {
  const stateDir = resolveStateDir();
  const tokenCachePath = path.join(stateDir, "credentials", "github-copilot.token.json");
  const model = process.env.TG_AI_MODEL?.trim() || "gpt-4o";
  const safetyMarginMs = 5 * 60 * 1000;

  // 1. Try the cached short-lived Copilot API token (written by OpenClaw core
  //    after the last successful API call). Only use if still has 5+ min left.
  try {
    const raw = fs.readFileSync(tokenCachePath, "utf-8");
    const cached = JSON.parse(raw) as CachedCopilotToken;
    if (cached.token && cached.expiresAt - Date.now() > safetyMarginMs) {
      const base = deriveCopilotBase(cached.token);
      setModelAdapter(makeOpenAiCompatAdapter(`${base}/v1`, cached.token, model));
      logger.info(`[TelegramPlugin] AI adapter: GitHub Copilot (cached token, model=${model})`);
      return true;
    }
  } catch {
    // No valid cached token — fall through to token exchange.
  }

  // 2. Resolve GitHub token: prefer stored auth profile (set by OpenClaw login),
  //    fall back to environment variables.
  const githubToken =
    readStoredGithubToken(stateDir) ||
    process.env.COPILOT_GITHUB_TOKEN?.trim() ||
    process.env.GH_TOKEN?.trim() ||
    process.env.GITHUB_TOKEN?.trim();

  if (!githubToken) {
    return false;
  }

  // 3. Exchange GitHub token for a short-lived Copilot API token.
  const fresh = await exchangeCopilotToken(githubToken);
  if (fresh) {
    // Best-effort cache the new token so the next restart is instant.
    try {
      fs.mkdirSync(path.dirname(tokenCachePath), { recursive: true });
      fs.writeFileSync(tokenCachePath, JSON.stringify({ ...fresh, updatedAt: Date.now() }));
    } catch {
      // Non-fatal — token caching is optional.
    }
    const base = deriveCopilotBase(fresh.token);
    setModelAdapter(makeOpenAiCompatAdapter(`${base}/v1`, fresh.token, model));
    logger.info(`[TelegramPlugin] AI adapter: GitHub Copilot (fresh token, model=${model})`);
    return true;
  }

  logger.warn("[TelegramPlugin] GitHub token found but Copilot token exchange failed");
  return false;
}

/**
 * Auto-detect the best available AI adapter and configure it once at startup.
 * Falls back gracefully so the plugin still starts even when no AI is configured
 * (agents will log a warning on the first AI reply attempt).
 */
async function autoConfigureAiAdapter(logger: ILogger): Promise<void> {
  // If an explicit env-var provider is set, AiReplyEngine will use it automatically.
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    logger.info("[TelegramPlugin] AI adapter: Anthropic (ANTHROPIC_API_KEY)");
    return;
  }
  if (process.env.OPENAI_API_KEY?.trim() || process.env.OPENAI_BASE_URL?.trim()) {
    const model = process.env.TG_AI_MODEL?.trim() || "gpt-4o";
    logger.info(`[TelegramPlugin] AI adapter: OpenAI-compatible (model=${model})`);
    return;
  }

  // Try GitHub Copilot (uses OpenClaw's own cached credentials).
  const configured = await trySetCopilotAdapter(logger);
  if (!configured) {
    logger.warn(
      "[TelegramPlugin] No AI provider detected. " +
        "Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or configure GitHub Copilot in OpenClaw. " +
        "AI replies will fail until a provider is available.",
    );
  }
}

const TELEGRAM_METHODS = [
  "telegram.agent.list",
  "telegram.agent.get",
  "telegram.agent.create",
  "telegram.agent.delete",
  "telegram.agent.start",
  "telegram.agent.stop",
  "telegram.agent.restart",
  "telegram.agent.setBehaviors",
  "telegram.agent.authStart",
  "telegram.agent.authSubmit",
  "telegram.tool.call",
  "telegram.events.get",
  "telegram.parsed.get",
  "telegram.config.get",
  "telegram.config.set",
  "telegram.config.setProxy",
  "telegram.agent.assignTask",
  "telegram.agent.listTaskSessions",
  "telegram.agent.completeTaskSession",
  "telegram.agent.getCoreFiles",
  "telegram.agent.setCoreFile",
  "telegram.agent.getCoreFileContent",
  "telegram.agent.sendMessage_to_agent",
  "telegram.mission.create",
  "telegram.mission.list",
  "telegram.mission.get",
  "telegram.mission.complete",
  "telegram.mission.messages",
] as const;

const plugin = {
  id: "telegram-manager",
  name: "Telegram Manager",
  description: "Manage Telegram userbot and bot agents, behaviors, and auth",

  register(api: OpenClawPluginApi) {
    const telegramPlugin = new TelegramPlugin();

    // Deferred broadcast: captured from the first gateway method handler invocation.
    // The plugin emits events before any WS client calls a method, so we queue them
    // until the function is available.
    let broadcastFn: ((event: string, payload: unknown) => void) | null = null;
    const pendingBroadcasts: Array<{ event: string; payload: unknown }> = [];

    function flushPending() {
      if (!broadcastFn) return;
      let item;
      while ((item = pendingBroadcasts.shift())) {
        broadcastFn(item.event, item.payload);
      }
    }

    // IGatewayContext adapter for TelegramPlugin
    const ctx: IGatewayContext = {
      gatewayToken: "",
      logger: api.logger,
      dataDir: resolveStateDir(),
      broadcast(msg) {
        const event = msg.method;
        const payload = msg.params ?? {};
        if (broadcastFn) {
          broadcastFn(event, payload);
        } else {
          pendingBroadcasts.push({ event, payload });
        }
      },
    };

    // Initialize TelegramPlugin when the gateway is ready
    api.on("gateway_start", async () => {
      // Auto-detect and configure the AI adapter before agents start accepting
      // messages — ensures aiReply() has a working backend from the first turn.
      await autoConfigureAiAdapter(ctx.logger);
      await telegramPlugin.init(ctx);
    });

    api.on("gateway_stop", async () => {
      await telegramPlugin.destroy();
    });

    // Wire each telegram.* WebSocket method through the plugin's handleMessage dispatcher
    function makeHandler(method: string) {
      return async function handler({ params, respond, context }: GatewayRequestHandlerOptions) {
        // Capture broadcast on the first call and flush any queued events
        if (!broadcastFn) {
          broadcastFn = context.broadcast;
          flushPending();
        }

        let replied = false;
        await telegramPlugin.handleMessage({ method, id: undefined, params: params ?? {} }, (r) => {
          replied = true;
          if (r.error) {
            respond(false, { error: r.error });
          } else {
            respond(true, r.result);
          }
        });

        if (!replied) {
          respond(false, { error: "telegram-manager: no reply from plugin" });
        }
      };
    }

    for (const method of TELEGRAM_METHODS) {
      api.registerGatewayMethod(method, makeHandler(method));
    }

    // ─── Agent tool: telegram_manager ────────────────────────────────────────
    //
    // Exposes Telegram agent management to the main OpenClaw agent so it can
    // list agents, check their status, start/stop/restart them, send messages,
    // and read recent events — all without going through the WebSocket layer.

    /** Call a telegram plugin method and return the result (or throw on error). */
    function callPlugin(method: string, params: Record<string, unknown>): Promise<unknown> {
      return new Promise<unknown>((resolve, reject) => {
        const msg: GatewayMessage = { method, id: undefined, params };
        telegramPlugin
          .handleMessage(msg, (r: GatewayMessage) => {
            if (r.error) {
              reject(new Error(String(r.error)));
            } else {
              resolve(r.result);
            }
          })
          .catch(reject);
      });
    }

    const telegramManagerTool: AnyAgentTool = {
      name: "telegram_manager",
      label: "Telegram Manager",
      description: `Manage Telegram bot and userbot agents running on this gateway.

Actions:
- list                  — list all agents with id, name, type, status, and stats
- get                   — get full details of one agent (requires agentId)
- start                 — start a stopped agent (requires agentId)
- stop                  — stop a running agent (requires agentId)
- restart               — restart an agent (requires agentId)
- send_message          — send a text message through an agent (requires agentId, target, message)
- get_events            — get recent inbound/outbound events for an agent (requires agentId)
- assign_task           — assign a persistent task session so the agent holds an ongoing AI conversation with a specific Telegram chat on behalf of the main agent (requires agentId, chatId, task; optional: systemPrompt, openingMessage). chatId must be the FULL username (e.g. 'worker_297') or a full numeric Telegram user ID (9+ digits) — never just the numeric suffix of a username
- list_task_sessions    — list all task sessions for an agent (requires agentId)
- complete_task_session — mark a task session as completed (requires agentId, sessionId)
- create_mission        — create a multi-agent mission where a master agent assigns a goal to sub-agents (requires masterAgentId, title, goal; optional: participantIds, systemPrompt)
- list_missions         — list all agent missions
- get_mission           — get details of a specific mission (requires missionId)
- complete_mission      — mark a mission as completed (requires missionId)
- get_mission_messages  — get inter-agent messages for a mission (requires missionId; optional: limit)
- send_agent_message    — send a message from one agent to another within a mission (requires fromAgentId, toAgentId, missionId, content)
- get_core_files        — list core workspace files for an agent (requires agentId)
- set_core_file         — write a core workspace file for an agent (requires agentId, filename, content)
- get_core_file_content — read the content of a core workspace file (requires agentId, filename)`,
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "list",
              "get",
              "start",
              "stop",
              "restart",
              "send_message",
              "get_events",
              "assign_task",
              "list_task_sessions",
              "complete_task_session",
              "create_mission",
              "list_missions",
              "get_mission",
              "complete_mission",
              "get_mission_messages",
              "send_agent_message",
              "get_core_files",
              "set_core_file",
              "get_core_file_content",
            ],
            description: "Action to perform",
          },
          agentId: {
            type: "string",
            description: "Telegram agent ID — required for all actions except 'list'",
          },
          target: {
            type: "string",
            description:
              "Message target for send_message: @username, numeric chat ID, or phone number",
          },
          message: {
            type: "string",
            description: "Text to send for send_message",
          },
          limit: {
            type: "number",
            description: "Max events to return for get_events (default 20)",
          },
          chatId: {
            type: "string",
            description:
              "Telegram chat or user identifier for assign_task. " +
              "Pass the FULL identifier exactly as given — do NOT extract just a numeric suffix. " +
              "Examples: 'worker_297' (username, pass as-is), '@alice' (with or without @), " +
              "or a full numeric Telegram user ID (typically 9+ digits like '123456789'). " +
              "A short number like '297' is NEVER a valid standalone Telegram user ID.",
          },
          task: {
            type: "string",
            description:
              "Task description for assign_task — the goal the agent should pursue in conversation with the chat",
          },
          systemPrompt: {
            type: "string",
            description:
              "Optional custom system prompt for the AI in this task session (overrides default task prompt)",
          },
          openingMessage: {
            type: "string",
            description:
              "Optional first message the agent sends immediately when the task session is assigned",
          },
          sessionId: {
            type: "string",
            description: "Task session ID — required for complete_task_session",
          },
          masterAgentId: {
            type: "string",
            description:
              "ID of the master agent that owns the mission — required for create_mission",
          },
          title: {
            type: "string",
            description: "Mission title — required for create_mission",
          },
          goal: {
            type: "string",
            description: "Mission goal/instructions — required for create_mission",
          },
          participantIds: {
            type: "array",
            items: { type: "string" },
            description: "Agent IDs participating in the mission — for create_mission",
          },
          missionId: {
            type: "string",
            description:
              "Mission ID — required for get_mission, complete_mission, get_mission_messages, send_agent_message",
          },
          fromAgentId: {
            type: "string",
            description: "Sending agent ID — required for send_agent_message",
          },
          toAgentId: {
            type: "string",
            description: "Receiving agent ID — required for send_agent_message",
          },
          content: {
            type: "string",
            description: "Message content — required for send_agent_message",
          },
          filename: {
            type: "string",
            description: "Core file name (e.g. AGENTS.md) — required for set_core_file",
          },
        },
        required: ["action"],
      },
      async execute(_toolCallId, rawArgs) {
        const args = rawArgs as Record<string, unknown>;
        const action = String(args.action ?? "");
        try {
          switch (action) {
            case "list": {
              const agents = await callPlugin("telegram.agent.list", {});
              return jsonResult({ agents });
            }
            case "get": {
              if (!args.agentId) return jsonResult({ error: "agentId is required for 'get'" });
              const agent = await callPlugin("telegram.agent.get", { agentId: args.agentId });
              return jsonResult(agent);
            }
            case "start": {
              if (!args.agentId) return jsonResult({ error: "agentId is required for 'start'" });
              await callPlugin("telegram.agent.start", { agentId: args.agentId });
              return jsonResult({ ok: true, message: `Agent ${args.agentId} started` });
            }
            case "stop": {
              if (!args.agentId) return jsonResult({ error: "agentId is required for 'stop'" });
              await callPlugin("telegram.agent.stop", { agentId: args.agentId });
              return jsonResult({ ok: true, message: `Agent ${args.agentId} stopped` });
            }
            case "restart": {
              if (!args.agentId) return jsonResult({ error: "agentId is required for 'restart'" });
              await callPlugin("telegram.agent.restart", { agentId: args.agentId });
              return jsonResult({ ok: true, message: `Agent ${args.agentId} restarted` });
            }
            case "send_message": {
              if (!args.agentId)
                return jsonResult({ error: "agentId is required for 'send_message'" });
              if (!args.target)
                return jsonResult({ error: "target is required for 'send_message'" });
              if (!args.message)
                return jsonResult({ error: "message is required for 'send_message'" });
              const result = await callPlugin("telegram.tool.call", {
                agentId: args.agentId,
                tool: "sendMessage",
                args: { target: args.target, message: args.message },
              });
              return jsonResult({ ok: true, result });
            }
            case "get_events": {
              if (!args.agentId)
                return jsonResult({ error: "agentId is required for 'get_events'" });
              const events = await callPlugin("telegram.events.get", {
                agentId: args.agentId,
                limit: typeof args.limit === "number" ? args.limit : 20,
              });
              return jsonResult({ events });
            }
            case "assign_task": {
              if (!args.agentId)
                return jsonResult({ error: "agentId is required for 'assign_task'" });
              if (!args.chatId)
                return jsonResult({ error: "chatId is required for 'assign_task'" });
              if (!args.task) return jsonResult({ error: "task is required for 'assign_task'" });
              const result = await callPlugin("telegram.agent.assignTask", {
                agentId: args.agentId,
                chatId: args.chatId,
                task: args.task,
                ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
                ...(args.openingMessage ? { openingMessage: args.openingMessage } : {}),
              });
              return jsonResult(result);
            }
            case "list_task_sessions": {
              if (!args.agentId)
                return jsonResult({ error: "agentId is required for 'list_task_sessions'" });
              const sessions = await callPlugin("telegram.agent.listTaskSessions", {
                agentId: args.agentId,
              });
              return jsonResult({ sessions });
            }
            case "complete_task_session": {
              if (!args.agentId)
                return jsonResult({ error: "agentId is required for 'complete_task_session'" });
              if (!args.sessionId)
                return jsonResult({ error: "sessionId is required for 'complete_task_session'" });
              await callPlugin("telegram.agent.completeTaskSession", {
                agentId: args.agentId,
                sessionId: args.sessionId,
              });
              return jsonResult({ ok: true, message: `Task session ${args.sessionId} completed` });
            }
            case "create_mission": {
              if (!args.masterAgentId)
                return jsonResult({ error: "masterAgentId is required for 'create_mission'" });
              if (!args.title)
                return jsonResult({ error: "title is required for 'create_mission'" });
              if (!args.goal) return jsonResult({ error: "goal is required for 'create_mission'" });
              const mission = await callPlugin("telegram.mission.create", {
                masterAgentId: args.masterAgentId,
                title: args.title,
                goal: args.goal,
                participantIds: Array.isArray(args.participantIds) ? args.participantIds : [],
                ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
              });
              return jsonResult(mission);
            }
            case "list_missions": {
              const missions = await callPlugin("telegram.mission.list", {});
              return jsonResult({ missions });
            }
            case "get_mission": {
              if (!args.missionId)
                return jsonResult({ error: "missionId is required for 'get_mission'" });
              const mission = await callPlugin("telegram.mission.get", {
                missionId: args.missionId,
              });
              return jsonResult(mission);
            }
            case "complete_mission": {
              if (!args.missionId)
                return jsonResult({ error: "missionId is required for 'complete_mission'" });
              await callPlugin("telegram.mission.complete", { missionId: args.missionId });
              return jsonResult({ ok: true, message: `Mission ${args.missionId} completed` });
            }
            case "get_mission_messages": {
              if (!args.missionId)
                return jsonResult({ error: "missionId is required for 'get_mission_messages'" });
              const messages = await callPlugin("telegram.mission.messages", {
                missionId: args.missionId,
                ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
              });
              return jsonResult({ messages });
            }
            case "send_agent_message": {
              if (!args.fromAgentId)
                return jsonResult({ error: "fromAgentId is required for 'send_agent_message'" });
              if (!args.toAgentId)
                return jsonResult({ error: "toAgentId is required for 'send_agent_message'" });
              if (!args.missionId)
                return jsonResult({ error: "missionId is required for 'send_agent_message'" });
              if (!args.content)
                return jsonResult({ error: "content is required for 'send_agent_message'" });
              const msg = await callPlugin("telegram.agent.sendMessage_to_agent", {
                fromAgentId: args.fromAgentId,
                toAgentId: args.toAgentId,
                missionId: args.missionId,
                content: args.content,
              });
              return jsonResult(msg);
            }
            case "get_core_files": {
              if (!args.agentId)
                return jsonResult({ error: "agentId is required for 'get_core_files'" });
              const result = await callPlugin("telegram.agent.getCoreFiles", {
                agentId: args.agentId,
              });
              return jsonResult(result);
            }
            case "set_core_file": {
              if (!args.agentId)
                return jsonResult({ error: "agentId is required for 'set_core_file'" });
              if (!args.filename)
                return jsonResult({ error: "filename is required for 'set_core_file'" });
              if (args.content === undefined)
                return jsonResult({ error: "content is required for 'set_core_file'" });
              await callPlugin("telegram.agent.setCoreFile", {
                agentId: args.agentId,
                filename: args.filename,
                content: args.content,
              });
              return jsonResult({ ok: true });
            }
            case "get_core_file_content": {
              if (!args.agentId)
                return jsonResult({ error: "agentId is required for 'get_core_file_content'" });
              if (!args.filename)
                return jsonResult({ error: "filename is required for 'get_core_file_content'" });
              const result = await callPlugin("telegram.agent.getCoreFileContent", {
                agentId: args.agentId,
                filename: args.filename,
              });
              return jsonResult(result);
            }
            default:
              return jsonResult({
                error: `Unknown action: '${action}'. Valid actions: list, get, start, stop, restart, send_message, get_events, assign_task, list_task_sessions, complete_task_session, create_mission, list_missions, get_mission, complete_mission, get_mission_messages, send_agent_message, get_core_files, set_core_file, get_core_file_content`,
              });
          }
        } catch (err) {
          return jsonResult({ error: String(err) });
        }
      },
    };

    api.registerTool(telegramManagerTool);
  },
};

export default plugin;
