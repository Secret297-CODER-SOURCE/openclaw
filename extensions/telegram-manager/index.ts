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

Actions:
- list          — list all agents with id, name, type, status, and stats
- get           — get full details of one agent (requires agentId)
- start         — start a stopped agent (requires agentId)
- stop          — stop a running agent (requires agentId)
- restart       — restart an agent (requires agentId)
- send_message  — send a text message through a bot agent (requires agentId, target, message)
- get_events    — get recent inbound/outbound events for an agent (requires agentId)`,
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "get", "start", "stop", "restart", "send_message", "get_events"],
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
            default:
              return jsonResult({
                error: `Unknown action: '${action}'. Valid actions: list, get, start, stop, restart, send_message, get_events`,
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
