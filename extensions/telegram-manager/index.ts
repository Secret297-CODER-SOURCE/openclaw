import fs from "fs";
import os from "os";
import path from "path";
import type {
  AnyAgentTool,
  OpenClawConfig,
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
function configureGatewayAdapter(logger: IGatewayContext["logger"], token: string): void {
  const port = parseInt(process.env.OPENCLAW_GATEWAY_PORT?.trim() || "18789", 10);
  const model = process.env.TG_AI_MODEL?.trim() || "gpt-4o";
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  setModelAdapter(makeOpenAiCompatAdapter(baseUrl, token, model));
  // Also store gateway config so analyzeImageOnce() can make vision calls through it.
  setGatewayConfig({ baseUrl, token, model });
  if (!token) {
    logger.warn(
      "[TelegramPlugin] gateway token not found — AI calls will be unauthenticated. " +
        "Set OPENCLAW_GATEWAY_TOKEN or gateway.auth.token in openclaw.json.",
    );
  }
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
  // Conversation state tracking
  "telegram.scenario.getConversationStates",
  // Anthropic key management
  "telegram.config.checkAnthropicKey",
  "telegram.config.setAnthropicKey",
  // Leads
  "telegram.leads.list",
  "telegram.leads.save",
  "telegram.leads.delete",
  "telegram.agent.initLeadsGroup",
  "telegram.agent.runReEngagementNow",
  "telegram.agent.reEngagementHistory",
  "telegram.agent.deleteReEngagementHistoryItem",
  "telegram.agent.aiTraces",
  "telegram.agent.generateReEngagementTemplate",
  // Translation proxy (CSP bypass: server-side fetch to Google Translate)
  "telegram.translate.text",
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

    // Resolve the gateway auth token: prefer api.config (already loaded by the
    // plugin host — same source the gateway itself uses), fall back to env var /
    // direct file read for compat with standalone / non-plugin usage.
    const stateDir = resolveStateDir();
    const gatewayToken =
      process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
      (api.config as OpenClawConfig).gateway?.auth?.token?.trim() ||
      readGatewayToken(stateDir);

    // IGatewayContext adapter for TelegramPlugin
    const ctx: IGatewayContext = {
      gatewayToken,
      logger: api.logger,
      dataDir: stateDir,
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
      configureGatewayAdapter(ctx.logger, ctx.gatewayToken);
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
      label: "Telegram Менеджер",
      description: `Управление Telegram bot и userbot агентами, запущенными на этом шлюзе.

Действия:
- list                  — список всех агентов с id, именем, типом, статусом и статистикой
- get                   — получить полные данные одного агента (требуется agentId)
- create_agent          — создать нового агента (требуется name, agentType; для bot требуется botToken; для userbot требуется phoneNumber; опционально: behaviors)
- delete_agent          — удалить агента навсегда (требуется agentId)
- set_behaviors         — заменить все поведения агента (требуется agentId, behaviors). Используйте для включения master_control, auto_reply, monitor и т.д.
- start                 — запустить остановленного агента (требуется agentId)
- stop                  — остановить работающего агента (требуется agentId)
- restart               — перезапустить агента (требуется agentId)
- send_message          — отправить текстовое сообщение через агента (требуется agentId, target, message)
- get_events            — получить последние входящие/исходящие события агента (требуется agentId)
- assign_task           — назначить постоянную задачу, чтобы агент вёл непрерывный AI-диалог с конкретным Telegram-чатом от имени главного агента (требуется agentId, chatId, task; опционально: systemPrompt, openingMessage). chatId должен быть ПОЛНЫМ username (например 'worker_297') или полным числовым Telegram user ID (9+ цифр) — никогда не используйте только числовой суффикс username
- list_task_sessions    — список всех задач агента (требуется agentId)
- complete_task_session — отметить задачу как выполненную (требуется agentId, sessionId)
- create_mission        — создать миссию для нескольких агентов, где мастер-агент назначает цель подчинённым агентам (требуется masterAgentId, title, goal; опционально: participantIds, systemPrompt)
- list_missions         — список всех миссий агентов
- get_mission           — получить детали конкретной миссии (требуется missionId)
- complete_mission      — отметить миссию как завершённую (требуется missionId)
- get_mission_messages  — получить межагентские сообщения миссии (требуется missionId; опционально: limit)
- send_agent_message    — отправить сообщение от одного агента другому в рамках миссии (требуется fromAgentId, toAgentId, missionId, content)
- auth_start            — отправить OTP-код на номер телефона userbot для начала авторизации в Telegram (требуется agentId)
- auth_submit           — завершить авторизацию, отправив полученный OTP-код и пароль 2FA при наличии (требуется agentId, code; опционально: password)
- get_core_files        — список основных файлов рабочего пространства агента (требуется agentId)
- set_core_file         — записать основной файл рабочего пространства агента (требуется agentId, filename, content)
- get_core_file_content — прочитать содержимое основного файла рабочего пространства (требуется agentId, filename)

Типы поведений для set_behaviors / create_agent:
- master_control: { type: "master_control", enabled: true, allowedChatIds: ["<chatId>"], systemPrompt?: "..." } — агентский контрольный цикл; агент слушает авторизованные чаты и управляет пулом агентов через AI
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
            description: "Действие для выполнения",
          },
          agentId: {
            type: "string",
            description:
              "ID Telegram-агента — требуется для всех действий кроме 'list' и 'create_agent'",
          },
          agentType: {
            type: "string",
            description:
              "Тип агента для create_agent: 'bot' (использует botToken) или 'userbot' (использует phoneNumber)",
          },
          botToken: {
            type: "string",
            description: "Токен Telegram-бота для create_agent когда agentType равен 'bot'",
          },
          phoneNumber: {
            type: "string",
            description:
              "Номер телефона (международный формат, например +12345678900) для create_agent когда agentType равен 'userbot'",
          },
          name: {
            type: "string",
            description: "Читаемое имя агента для create_agent",
          },
          behaviors: {
            type: "array",
            items: { type: "object" },
            description:
              "Массив конфигурации поведений для create_agent или set_behaviors. Каждый элемент должен иметь поле 'type' (master_control, auto_reply, monitor, broadcast, parser, task_session, communication) и поле 'enabled'.",
          },
          target: {
            type: "string",
            description:
              "Адресат сообщения для send_message: @username, числовой ID чата, или номер телефона",
          },
          message: {
            type: "string",
            description: "Текст для отправки в send_message",
          },
          limit: {
            type: "number",
            description: "Макс. количество событий для get_events (по умолчанию 20)",
          },
          chatId: {
            type: "string",
            description:
              "Идентификатор Telegram-чата или пользователя для assign_task. " +
              "Передавайте ПОЛНЫЙ идентификатор точно как дан — НЕ извлекайте только числовой суффикс. " +
              "Примеры: 'worker_297' (username, передавать как есть), '@alice' (с @ или без), " +
              "или полный числовой Telegram user ID (обычно 9+ цифр, например '123456789'). " +
              "Короткое число вроде '297' НИКОГДА не является валидным самостоятельным Telegram user ID.",
          },
          task: {
            type: "string",
            description:
              "Описание задачи для assign_task — цель, которую агент должен преследовать в разговоре с чатом",
          },
          systemPrompt: {
            type: "string",
            description:
              "Опциональный кастомный системный промпт для AI в этой задаче (переопределяет стандартный промпт задачи)",
          },
          openingMessage: {
            type: "string",
            description:
              "Опциональное первое сообщение, которое агент отправляет сразу при назначении задачи",
          },
          sessionId: {
            type: "string",
            description: "ID сессии задачи — требуется для complete_task_session",
          },
          masterAgentId: {
            type: "string",
            description: "ID мастер-агента, владеющего миссией — требуется для create_mission",
          },
          title: {
            type: "string",
            description: "Название миссии — требуется для create_mission",
          },
          goal: {
            type: "string",
            description: "Цель/инструкции миссии — требуется для create_mission",
          },
          participantIds: {
            type: "array",
            items: { type: "string" },
            description: "ID агентов, участвующих в миссии — для create_mission",
          },
          missionId: {
            type: "string",
            description:
              "ID миссии — требуется для get_mission, complete_mission, get_mission_messages, send_agent_message",
          },
          fromAgentId: {
            type: "string",
            description: "ID агента-отправителя — требуется для send_agent_message",
          },
          toAgentId: {
            type: "string",
            description: "ID агента-получателя — требуется для send_agent_message",
          },
          content: {
            type: "string",
            description: "Содержимое сообщения — требуется для send_agent_message",
          },
          code: {
            type: "string",
            description:
              "OTP-код, полученный через SMS или приложение Telegram — требуется для auth_submit",
          },
          password: {
            type: "string",
            description:
              "Пароль двухфакторной аутентификации (2FA) — требуется для auth_submit когда на аккаунте включена 2FA",
          },
          filename: {
            type: "string",
            description: "Имя основного файла (например AGENTS.md) — требуется для set_core_file",
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
              if (!args.agentId) return jsonResult({ error: "agentId обязателен для 'get'" });
              const agent = await callPlugin("telegram.agent.get", { agentId: args.agentId });
              return jsonResult(agent);
            }
            case "create_agent": {
              if (!args.name) return jsonResult({ error: "name обязателен для 'create_agent'" });
              if (!args.agentType)
                return jsonResult({
                  error: "agentType ('bot' или 'userbot') обязателен для 'create_agent'",
                });
              let credentials: Record<string, unknown>;
              if (args.agentType === "bot") {
                if (!args.botToken)
                  return jsonResult({ error: "botToken обязателен для bot агентов" });
                credentials = { type: "bot", token: String(args.botToken) };
              } else if (args.agentType === "userbot") {
                if (!args.phoneNumber)
                  return jsonResult({ error: "phoneNumber обязателен для userbot агентов" });
                credentials = { type: "userbot", phoneNumber: String(args.phoneNumber) };
              } else {
                return jsonResult({
                  error: `Неизвестный agentType '${args.agentType}'. Используйте 'bot' или 'userbot'`,
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
                return jsonResult({ error: "agentId обязателен для 'delete_agent'" });
              await callPlugin("telegram.agent.delete", { agentId: args.agentId });
              return jsonResult({ ok: true, message: `Агент ${args.agentId} удалён` });
            }
            case "set_behaviors": {
              if (!args.agentId)
                return jsonResult({ error: "agentId обязателен для 'set_behaviors'" });
              if (!Array.isArray(args.behaviors))
                return jsonResult({ error: "behaviors должен быть массивом для 'set_behaviors'" });
              await callPlugin("telegram.agent.setBehaviors", {
                agentId: args.agentId,
                behaviors: args.behaviors,
              });
              return jsonResult({
                ok: true,
                message: `Поведения обновлены для агента ${args.agentId}`,
              });
            }
            case "start": {
              if (!args.agentId) return jsonResult({ error: "agentId обязателен для 'start'" });
              await callPlugin("telegram.agent.start", { agentId: args.agentId });
              return jsonResult({ ok: true, message: `Агент ${args.agentId} запущен` });
            }
            case "stop": {
              if (!args.agentId) return jsonResult({ error: "agentId обязателен для 'stop'" });
              await callPlugin("telegram.agent.stop", { agentId: args.agentId });
              return jsonResult({ ok: true, message: `Агент ${args.agentId} остановлен` });
            }
            case "restart": {
              if (!args.agentId) return jsonResult({ error: "agentId обязателен для 'restart'" });
              await callPlugin("telegram.agent.restart", { agentId: args.agentId });
              return jsonResult({ ok: true, message: `Агент ${args.agentId} перезапущен` });
            }
            case "send_message": {
              if (!args.agentId)
                return jsonResult({ error: "agentId обязателен для 'send_message'" });
              if (!args.target)
                return jsonResult({ error: "target обязателен для 'send_message'" });
              if (!args.message)
                return jsonResult({ error: "message обязателен для 'send_message'" });
              const result = await callPlugin("telegram.tool.call", {
                agentId: args.agentId,
                tool: "sendMessage",
                args: { target: args.target, message: args.message },
              });
              return jsonResult({ ok: true, result });
            }
            case "get_events": {
              if (!args.agentId)
                return jsonResult({ error: "agentId обязателен для 'get_events'" });
              const events = await callPlugin("telegram.events.get", {
                agentId: args.agentId,
                limit: typeof args.limit === "number" ? args.limit : 20,
              });
              return jsonResult({ events });
            }
            case "assign_task": {
              if (!args.agentId)
                return jsonResult({ error: "agentId обязателен для 'assign_task'" });
              if (!args.chatId) return jsonResult({ error: "chatId обязателен для 'assign_task'" });
              if (!args.task) return jsonResult({ error: "task обязателен для 'assign_task'" });
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
                return jsonResult({ error: "agentId обязателен для 'list_task_sessions'" });
              const sessions = await callPlugin("telegram.agent.listTaskSessions", {
                agentId: args.agentId,
              });
              return jsonResult({ sessions });
            }
            case "complete_task_session": {
              if (!args.agentId)
                return jsonResult({ error: "agentId обязателен для 'complete_task_session'" });
              if (!args.sessionId)
                return jsonResult({ error: "sessionId обязателен для 'complete_task_session'" });
              await callPlugin("telegram.agent.completeTaskSession", {
                agentId: args.agentId,
                sessionId: args.sessionId,
              });
              return jsonResult({ ok: true, message: `Сессия задачи ${args.sessionId} завершена` });
            }
            case "create_mission": {
              if (!args.masterAgentId)
                return jsonResult({ error: "masterAgentId обязателен для 'create_mission'" });
              if (!args.title)
                return jsonResult({ error: "title обязателен для 'create_mission'" });
              if (!args.goal) return jsonResult({ error: "goal обязателен для 'create_mission'" });
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
                return jsonResult({ error: "missionId обязателен для 'get_mission'" });
              const mission = await callPlugin("telegram.mission.get", {
                missionId: args.missionId,
              });
              return jsonResult(mission);
            }
            case "complete_mission": {
              if (!args.missionId)
                return jsonResult({ error: "missionId обязателен для 'complete_mission'" });
              await callPlugin("telegram.mission.complete", { missionId: args.missionId });
              return jsonResult({ ok: true, message: `Миссия ${args.missionId} завершена` });
            }
            case "get_mission_messages": {
              if (!args.missionId)
                return jsonResult({ error: "missionId обязателен для 'get_mission_messages'" });
              const messages = await callPlugin("telegram.mission.messages", {
                missionId: args.missionId,
                ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
              });
              return jsonResult({ messages });
            }
            case "send_agent_message": {
              if (!args.fromAgentId)
                return jsonResult({ error: "fromAgentId обязателен для 'send_agent_message'" });
              if (!args.toAgentId)
                return jsonResult({ error: "toAgentId обязателен для 'send_agent_message'" });
              if (!args.missionId)
                return jsonResult({ error: "missionId обязателен для 'send_agent_message'" });
              if (!args.content)
                return jsonResult({ error: "content обязателен для 'send_agent_message'" });
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
                return jsonResult({ error: "agentId обязателен для 'auth_start'" });
              await callPlugin("telegram.agent.authStart", { agentId: args.agentId });
              return jsonResult({
                ok: true,
                message:
                  "OTP-код отправлен на номер телефона. Вызовите auth_submit с полученным кодом (и паролем если включена 2FA).",
              });
            }
            case "auth_submit": {
              if (!args.agentId)
                return jsonResult({ error: "agentId обязателен для 'auth_submit'" });
              if (!args.code)
                return jsonResult({ error: "code (OTP) обязателен для 'auth_submit'" });
              await callPlugin("telegram.agent.authSubmit", {
                agentId: args.agentId,
                code: String(args.code),
                ...(args.password ? { password: String(args.password) } : {}),
              });
              return jsonResult({ ok: true, authenticated: true });
            }
            case "get_core_files": {
              if (!args.agentId)
                return jsonResult({ error: "agentId обязателен для 'get_core_files'" });
              const result = await callPlugin("telegram.agent.getCoreFiles", {
                agentId: args.agentId,
              });
              return jsonResult(result);
            }
            case "set_core_file": {
              if (!args.agentId)
                return jsonResult({ error: "agentId обязателен для 'set_core_file'" });
              if (!args.filename)
                return jsonResult({ error: "filename обязателен для 'set_core_file'" });
              if (args.content === undefined)
                return jsonResult({ error: "content обязателен для 'set_core_file'" });
              await callPlugin("telegram.agent.setCoreFile", {
                agentId: args.agentId,
                filename: args.filename,
                content: args.content,
              });
              return jsonResult({ ok: true });
            }
            case "get_core_file_content": {
              if (!args.agentId)
                return jsonResult({ error: "agentId обязателен для 'get_core_file_content'" });
              if (!args.filename)
                return jsonResult({ error: "filename обязателен для 'get_core_file_content'" });
              const result = await callPlugin("telegram.agent.getCoreFileContent", {
                agentId: args.agentId,
                filename: args.filename,
              });
              return jsonResult(result);
            }
            default:
              return jsonResult({
                error: `Неизвестное действие: '${action}'. Допустимые действия: list, get, create_agent, delete_agent, set_behaviors, start, stop, restart, send_message, get_events, assign_task, list_task_sessions, complete_task_session, create_mission, list_missions, get_mission, complete_mission, get_mission_messages, send_agent_message, auth_start, auth_submit, get_core_files, set_core_file, get_core_file_content`,
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
