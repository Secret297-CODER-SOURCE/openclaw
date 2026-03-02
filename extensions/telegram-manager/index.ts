import os from "os";
import path from "path";
import type { OpenClawPluginApi, GatewayRequestHandlerOptions } from "openclaw/plugin-sdk";
import { TelegramPlugin } from "./src/TelegramPlugin";
import type { IGatewayContext } from "./src/types";

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
  },
};

export default plugin;
