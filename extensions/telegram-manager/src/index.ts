import os from "os";
import path from "path";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { TelegramPlugin } from "./src/TelegramPlugin";
import type { GatewayMessage, IGatewayContext } from "./src/types";

function resolveStateDir(): string {
  return process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
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

⚠️ SCHEDULING RULE — CRITICAL:
If the user asks to send a message IN N MINUTES / SECONDS / AT A SPECIFIC TIME (e.g. "напиши через 5 минут", "send in 1 minute", "write to him in 7 minutes"):
  - DO NOT use send_message from this tool.
  - DO NOT await inside the agent loop (causes DataCloneError: PromisedNetSockets could not be cloned).
  - INSTEAD: use the cron tool with action="add", sessionTarget="isolated", payload.kind="agentTurn",
    schedule.kind="every" with everyMs=<delay in ms>, deleteAfterRun=true,
    and in the agentTurn message include the full instruction to send the message via telegram_manager.
  - Example for "send hello in 5 minutes":
    cron.add job = {
      sessionTarget: "isolated",
      schedule: { kind: "every", everyMs: 300000 },
      payload: { kind: "agentTurn", message: "Use telegram_manager send_message to send 'hello' to <target> via agent <agentId>. Then stop." },
      deleteAfterRun: true
    }

Actions:
- list                  — list all agents with id, name, type, status, and stats
- get                   — get full details of one agent (requires agentId)
- start                 — start a stopped agent (requires agentId)
- stop                  — stop a running agent (requires agentId)
- restart               — restart an agent (requires agentId)
- send_message          — send a text message IMMEDIATELY through an agent (requires agentId, target, message). Use ONLY for instant sends, never for delayed sends.
- get_events            — get recent inbound/outbound events for an agent (requires agentId)
- assign_task           — assign a persistent task session so the agent holds an ongoing AI conversation with a specific Telegram chat on behalf of the main agent (requires agentId, chatId, task; optional: systemPrompt, openingMessage). chatId must be the FULL username (e.g. 'worker_297') or a full numeric Telegram user ID (9+ digits) — never just the numeric suffix of a username
- list_task_sessions    — list all task sessions for an agent (requires agentId)
- complete_task_session — mark a task session as completed (requires agentId, sessionId)`,
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
            ],
            description: "Action to perform. For delayed sends use the cron tool instead.",
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
            default:
              return jsonResult({
                error: `Unknown action: '${action}'. Valid actions: list, get, start, stop, restart, send_message, get_events, assign_task, list_task_sessions, complete_task_session`,
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
