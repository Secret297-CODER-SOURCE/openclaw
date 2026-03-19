import fs from "fs";
import os from "os";
import path from "path";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import {
  makeOpenAiCompatAdapter,
  setModelAdapter,
  setGatewayConfig,
} from "./src/behaviors/AiReplyEngine.js";
import { TelegramPlugin } from "./src/TelegramPlugin";
import type { GatewayMessage, IGatewayContext } from "./src/types";

function resolveStateDir(): string {
  return process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
}

// ─── Gateway AI adapter ───────────────────────────────────────────────────────

/**
 * Read the gateway auth token from openclaw.json (gateway.auth.token).
 * Env var OPENCLAW_GATEWAY_TOKEN always takes priority.
 */
function readGatewayToken(stateDir: string): string {
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envToken) return envToken;
  try {
    const raw = fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf-8");
    const cfg = JSON.parse(raw) as { gateway?: { auth?: { token?: string } } };
    return cfg?.gateway?.auth?.token?.trim() || "";
  } catch {
    return "";
  }
}

/**
 * Configure the AI adapter to route through the local OpenClaw gateway
 * (/v1/chat/completions). This means the telegram-manager uses whatever AI
 * provider the main agent is configured with (GitHub Copilot, etc.) — no
 * separate keys required. The gateway maintains per-chat sessions via the
 * `user` field which is set to the telegram chatKey.
 */
function configureGatewayAdapter(logger: IGatewayContext["logger"]): void {
  const stateDir = resolveStateDir();
  const port = parseInt(process.env.OPENCLAW_GATEWAY_PORT?.trim() || "18789", 10);
  const model = process.env.TG_AI_MODEL?.trim() || "gpt-4o";
  const token = readGatewayToken(stateDir);
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  setModelAdapter(makeOpenAiCompatAdapter(baseUrl, token, model));
  // Also store gateway config so analyzeImageOnce() can make vision calls through it.
  setGatewayConfig({ baseUrl, token, model });
  logger.info(`[TelegramPlugin] AI adapter: via OpenClaw gateway (port=${port}, model=${model})`);
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
  "telegram.agent.getSettings",
  "telegram.agent.setSettings",
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
  // Scenario / Training
  "telegram.scenario.getChatNodes",
  "telegram.scenario.saveChatNode",
  "telegram.scenario.deleteChatNode",
  "telegram.scenario.clearChatNodes",
  "telegram.scenario.getFlowNodes",
  "telegram.scenario.saveFlowNode",
  "telegram.scenario.deleteFlowNode",
  "telegram.scenario.processTraining",
  "telegram.scenario.saveTrainingPairs",
  "telegram.scenario.getTrainingPairs",
  "telegram.scenario.saveTrainingSnapshot",
  "telegram.scenario.getTrainingSnapshot",
  "telegram.scenario.createNodesFromPairs",
  // Scenario / Visual Diagrams
  "telegram.scenario.getDiagram",
  "telegram.scenario.listDiagrams",
  "telegram.scenario.saveDiagram",
  "telegram.scenario.deleteDiagram",
  "telegram.scenario.renameDiagram",
  "telegram.scenario.diagramFromImage",
  "telegram.scenario.diagramFromText",
  // Coaching tips for training conversations
  "telegram.scenario.getCoachingTips",
  "telegram.scenario.loadCoachingTips",
  // Knowledge base (diagram ↔ training)
  "telegram.scenario.getKnowledgeBase",
  "telegram.scenario.saveKnowledgeBase",
  "telegram.scenario.distributeTrainingToNodes",
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
      // Route AI calls through the local OpenClaw gateway so all requests go
      // through the main agent's configured provider (GitHub Copilot, etc.).
      configureGatewayAdapter(ctx.logger);
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
            // Pass error as the ErrorShape third argument so the UI receives the
            // actual message (e.g. "Agent not running") instead of the generic
            // "request failed" fallback that comes from an empty error shape.
            respond(false, undefined, { code: "UNAVAILABLE", message: r.error } as Parameters<
              typeof respond
            >[2]);
          } else {
            respond(true, r.result);
          }
        });

        if (!replied) {
          respond(false, undefined, {
            code: "UNAVAILABLE",
            message: "telegram-manager: no reply from plugin",
          } as Parameters<typeof respond>[2]);
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
- create_agent          — create a new agent (requires name, agentType; bot requires botToken; userbot requires phoneNumber; optional: behaviors)
- delete_agent          — delete an agent permanently (requires agentId)
- set_behaviors         — replace all behaviors on an agent (requires agentId, behaviors). Use this to enable master_control, auto_reply, monitor, etc.
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
- auth_start            — send OTP code to a userbot's phone number to begin Telegram sign-in (requires agentId)
- auth_submit           — complete sign-in by submitting the received OTP code, and 2FA password if enabled (requires agentId, code; optional: password)
- get_core_files        — list core workspace files for an agent (requires agentId)
- set_core_file         — write a core workspace file for an agent (requires agentId, filename, content)
- get_core_file_content — read the content of a core workspace file (requires agentId, filename)

Behavior types for set_behaviors / create_agent:
- master_control: { type: "master_control", enabled: true, allowedChatIds: ["<chatId>"], systemPrompt?: "..." } — agentic control loop; the agent listens to authorized chats and manages the agent pool via AI
- auto_reply:     { type: "auto_reply", enabled: true, replyMode: "ai"|"template", goal?: "...", aiSystemPrompt?: "..." }
- monitor:        { type: "monitor", enabled: true, targets: ["<chatId>"], saveToDb?: true }
- broadcast:      { type: "broadcast", enabled: true, targets: ["<chatId>"], message: "...", schedule?: "* * * * *" }`,
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "list",
              "get",
              "create_agent",
              "delete_agent",
              "set_behaviors",
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
              "auth_start",
              "auth_submit",
              "get_core_files",
              "set_core_file",
              "get_core_file_content",
            ],
            description: "Action to perform",
          },
          agentId: {
            type: "string",
            description:
              "Telegram agent ID — required for all actions except 'list' and 'create_agent'",
          },
          agentType: {
            type: "string",
            description:
              "Agent type for create_agent: 'bot' (uses botToken) or 'userbot' (uses phoneNumber)",
          },
          botToken: {
            type: "string",
            description: "Telegram bot token for create_agent when agentType is 'bot'",
          },
          phoneNumber: {
            type: "string",
            description:
              "Phone number (international format, e.g. +12345678900) for create_agent when agentType is 'userbot'",
          },
          name: {
            type: "string",
            description: "Human-readable agent name for create_agent",
          },
          behaviors: {
            type: "array",
            items: { type: "object" },
            description:
              "Behavior config array for create_agent or set_behaviors. Each item must have a 'type' field (master_control, auto_reply, monitor, broadcast, parser, task_session, communication) and 'enabled' field.",
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
          code: {
            type: "string",
            description: "OTP code received via SMS or Telegram app — required for auth_submit",
          },
          password: {
            type: "string",
            description:
              "Two-factor authentication (2FA) password — required for auth_submit when the account has 2FA enabled",
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
            case "create_agent": {
              if (!args.name) return jsonResult({ error: "name is required for 'create_agent'" });
              if (!args.agentType)
                return jsonResult({
                  error: "agentType ('bot' or 'userbot') is required for 'create_agent'",
                });
              let credentials: Record<string, unknown>;
              if (args.agentType === "bot") {
                if (!args.botToken)
                  return jsonResult({ error: "botToken is required for bot agents" });
                credentials = { type: "bot", token: String(args.botToken) };
              } else if (args.agentType === "userbot") {
                if (!args.phoneNumber)
                  return jsonResult({ error: "phoneNumber is required for userbot agents" });
                credentials = { type: "userbot", phoneNumber: String(args.phoneNumber) };
              } else {
                return jsonResult({
                  error: `Unknown agentType '${args.agentType}'. Use 'bot' or 'userbot'`,
                });
              }
              const record = await callPlugin("telegram.agent.create", {
                name: String(args.name),
                credentials,
                behaviors: Array.isArray(args.behaviors) ? args.behaviors : [],
              });
              return jsonResult({ ok: true, agent: record });
            }
            case "delete_agent": {
              if (!args.agentId)
                return jsonResult({ error: "agentId is required for 'delete_agent'" });
              await callPlugin("telegram.agent.delete", { agentId: args.agentId });
              return jsonResult({ ok: true, message: `Agent ${args.agentId} deleted` });
            }
            case "set_behaviors": {
              if (!args.agentId)
                return jsonResult({ error: "agentId is required for 'set_behaviors'" });
              if (!Array.isArray(args.behaviors))
                return jsonResult({ error: "behaviors must be an array for 'set_behaviors'" });
              await callPlugin("telegram.agent.setBehaviors", {
                agentId: args.agentId,
                behaviors: args.behaviors,
              });
              return jsonResult({
                ok: true,
                message: `Behaviors updated for agent ${args.agentId}`,
              });
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
            case "auth_start": {
              if (!args.agentId)
                return jsonResult({ error: "agentId is required for 'auth_start'" });
              await callPlugin("telegram.agent.authStart", { agentId: args.agentId });
              return jsonResult({
                ok: true,
                message:
                  "OTP code sent to the phone number. Call auth_submit with the received code (and password if 2FA is enabled).",
              });
            }
            case "auth_submit": {
              if (!args.agentId)
                return jsonResult({ error: "agentId is required for 'auth_submit'" });
              if (!args.code)
                return jsonResult({ error: "code (OTP) is required for 'auth_submit'" });
              await callPlugin("telegram.agent.authSubmit", {
                agentId: args.agentId,
                code: String(args.code),
                ...(args.password ? { password: String(args.password) } : {}),
              });
              return jsonResult({ ok: true, authenticated: true });
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
                error: `Unknown action: '${action}'. Valid actions: list, get, create_agent, delete_agent, set_behaviors, start, stop, restart, send_message, get_events, assign_task, list_task_sessions, complete_task_session, create_mission, list_missions, get_mission, complete_mission, get_mission_messages, send_agent_message, auth_start, auth_submit, get_core_files, set_core_file, get_core_file_content`,
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
