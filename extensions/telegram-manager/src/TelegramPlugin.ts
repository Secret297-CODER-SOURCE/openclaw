// plugins/telegram/src/TelegramPlugin.ts
//
// This is the entry point for the OpenClaw plugin system.
// It implements GatewayPlugin and integrates with the Gateway's:
//   - Auth (same OPENCLAW_GATEWAY_TOKEN)
//   - WebSocket message routing (method: "telegram.*")
//   - HTTP routes (REST fallback / polling clients)
//   - Broadcast (push events to all connected WS clients)

import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { AgentManager } from "./agents/AgentManager";
import {
  analyzeImageOnce,
  callAdapterOnce,
  callAdapterOnceJson,
  resetDirectAdapter,
} from "./behaviors/AiReplyEngine";
import { TelegramStorage } from "./storage/TelegramStorage";
import type { ProxyConfig } from "./storage/TelegramStorage";
import {
  AgentSettings,
  DiagramEdge,
  DiagramGroup,
  DiagramNode,
  GatewayPlugin,
  IGatewayContext,
  GatewayMessage,
  HttpRoute,
  TelegramEvent,
  TaskSession,
  ChatNode,
  FlowNode,
  TrainingPair,
  TelegramExportChat,
  TelegramExportMessage,
} from "./types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns true if `id` is a pure numeric Telegram peer ID (possibly negative for groups/channels). */
function isNumericTelegramId(id: string): boolean {
  return /^-?\d+$/.test(id.replace(/^@/, ""));
}

/**
 * Extract a JSON object or array from an AI reply that may include markdown fences,
 * preamble text, or trailing commentary.
 * Strategy:
 *   1. Strip ``` / ```json fences (multiline-safe).
 *   2. Try parsing the whole cleaned string.
 *   3. If that fails, find the first `{` or `[` and the matching last `}` or `]`
 *      and parse just that slice.
 * Returns the parsed value or throws with the original raw text in the message.
 */
function extractJsonFromAiReply(raw: string): unknown {
  // Step 1: strip markdown code fences (handles ```json\n...\n``` and inline ```)
  let cleaned = raw
    .replace(/^```(?:json)?\s*/im, "")
    .replace(/\s*```\s*$/im, "")
    .trim();

  // Step 2: try direct parse
  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through
  }

  // Step 3: find outermost JSON object or array
  const objStart = cleaned.indexOf("{");
  const arrStart = cleaned.indexOf("[");
  const start =
    objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);
  if (start !== -1) {
    const openChar = cleaned[start];
    const closeChar = openChar === "{" ? "}" : "]";
    const end = cleaned.lastIndexOf(closeChar);
    if (end > start) {
      const slice = cleaned.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch {
        // fall through to error
      }
    }
  }

  throw new Error(`ИИ вернул некорректный JSON: ${raw.slice(0, 300)}`);
}

/** Shape returned by the `resolveEntityId` tool. */
interface ResolveEntityResult {
  id: string | null;
}

export class TelegramPlugin implements GatewayPlugin {
  readonly namespace = "telegram";

  private ctx!: IGatewayContext;
  private storage!: TelegramStorage;
  private manager!: AgentManager;

  /** Allowed core file names — validated before any file I/O */
  private static readonly CORE_FILE_NAMES = [
    "AGENTS.md",
    "SOUL.md",
    "TOOLS.md",
    "IDENTITY.md",
    "USER.md",
    "HEARTBEAT.md",
    "BOOTSTRAP.md",
    "MEMORY.md",
  ] as const;

  // ─── Plugin lifecycle ─────────────────────────────────────────────────────

  async init(ctx: IGatewayContext): Promise<void> {
    this.ctx = ctx;
    this.storage = new TelegramStorage(path.join(ctx.dataDir, "telegram"));
    this.manager = new AgentManager(this.storage, ctx.logger);
    await this.manager.init();

    // Restore saved Anthropic key into the environment so vision features work
    // after a gateway restart without the user having to re-enter the key.
    if (!process.env.ANTHROPIC_API_KEY?.trim()) {
      const savedCfg = this.storage.loadPluginConfig();
      if (savedCfg?.anthropicApiKey) {
        process.env.ANTHROPIC_API_KEY = savedCfg.anthropicApiKey;
        ctx.logger.info("[TelegramPlugin] restored ANTHROPIC_API_KEY from saved config");
      }
    }

    // Forward all agent events to every connected WS client
    this.manager.onEvent((event: TelegramEvent) => {
      ctx.broadcast({ method: "telegram.event", params: event });
    });

    ctx.logger.info("[TelegramPlugin] initialized");
  }

  async destroy(): Promise<void> {
    await this.manager.shutdown();
  }

  // ─── WebSocket message handler ────────────────────────────────────────────
  //
  // All messages with method starting with "telegram." land here.
  // reply() sends a response back to the single client that sent the message.

  async handleMessage(msg: GatewayMessage, reply: (r: GatewayMessage) => void): Promise<boolean> {
    if (!msg.method.startsWith("telegram.")) return false; // not ours

    const respond = (result: unknown) =>
      reply({ id: msg.id, method: msg.method, result: safeSerialize(result) });

    const fail = (error: string) => reply({ id: msg.id, method: msg.method, error });

    // Guard against requests arriving before init() completes (race on startup).
    if (!this.storage || !this.manager) {
      fail("Plugin still initializing — please retry in a moment");
      return true;
    }

    const p = (msg.params ?? {}) as Record<string, any>;

    try {
      switch (msg.method) {
        // ── Agents ──────────────────────────��──────────────────────────────

        case "telegram.agent.list":
          respond(this.manager.list().map(safeRecord));
          break;

        case "telegram.agent.get":
          respond(safeRecord(this.manager.get(p.agentId)));
          break;

        case "telegram.agent.create": {
          const record = this.manager.create(p.name, p.credentials, p.behaviors ?? []);
          respond(safeRecord(record));
          break;
        }

        case "telegram.agent.delete":
          await this.manager.delete(p.agentId);
          respond({ deleted: true });
          break;

        // ── Lifecycle ──────────────────────────────────────────────────────

        case "telegram.agent.start":
          await this.manager.start(p.agentId);
          respond({ status: "started" });
          break;

        case "telegram.agent.stop":
          await this.manager.stop(p.agentId);
          respond({ status: "stopped" });
          break;

        case "telegram.agent.restart":
          await this.manager.restart(p.agentId);
          respond({ status: "restarted" });
          break;

        // ── Behaviors ──────────────────────────────────────────────────────

        case "telegram.agent.setBehaviors":
          await this.manager.setBehaviors(p.agentId, p.behaviors);
          respond({ ok: true });
          break;

        // ── Agent settings (work mode, schedule, active diagram) ───────────

        case "telegram.agent.getSettings": {
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          const settings = this.storage.getAgentSettings(String(p.agentId));
          respond(settings);
          break;
        }

        case "telegram.agent.getPromptSummary": {
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          const s = this.storage.getAgentSettings(String(p.agentId));
          const workHours =
            s.managerWorkFrom && s.managerWorkTo ? `${s.managerWorkFrom}–${s.managerWorkTo}` : null;
          respond({
            guards: [
              {
                id: "enforceWorkingHours",
                name: "🕐 Рабочие часы",
                active: !!(s.managerWorkFrom && s.managerWorkTo),
                description:
                  "Перехватывает нерабочее время в ответах ИИ и предлагает ближайший доступный слот",
                details: workHours ?? "не настроены — guard отключён",
              },
              {
                id: "enforceNoAssumptiveClaims",
                name: "🚫 Без предположений о клиенте",
                active: true,
                description:
                  "Удаляет/переписывает фразы, приписывающие клиенту слова или профессию",
                details:
                  "«ты говорил» → «я думаю тебе будет интересно» | «из айти сферы» → удалено",
              },
              {
                id: "enforceFirstPerson",
                name: "👤 Первое лицо единственного числа",
                active: true,
                description:
                  "Заменяет корпоративное «мы» на личное «я» в реактивационных сообщениях",
                details: "мы→я | можем→могу | sunabiliriz→sunabilirim | we→I",
              },
              {
                id: "stripPhoneNumbers",
                name: "📵 Блокировка телефонных номеров",
                active: true,
                description: "Удаляет все телефонные номера из ответов ИИ",
                details: "regex: +7, 8-xxx, международные форматы",
              },
              {
                id: "openEndedTimeGuard",
                name: "📅 Блокировка «в любое время»",
                active: !!(s.managerWorkFrom && s.managerWorkTo),
                description:
                  "Заменяет открытые предложения времени на конкретный слот в рабочем окне",
                details: "«подстроюсь под любое» → «давай в HH:MM»",
              },
            ],
            aiSettings: {
              aiEnabled: s.aiEnabled !== false,
              autoStartEnabled: s.autoStartEnabled !== false,
              mode: s.aiEnabled === false ? "disabled" : s.useSchema ? "schema" : "free",
              activeDiagramId: s.activeDiagramId ?? null,
              schemaStrict: s.schemaStrictMode ?? false,
              buyerMode: s.schemaDeliveryStyle === "buyer",
              buyerAggression: s.buyerAggressionLevel ?? "balanced",
              buyerCloseStyle: s.buyerCloseStyle ?? "alternative",
              buyerProductContext: (s as any).buyerProductContext ?? null,
              scheduleMode: s.scheduleMode,
              scheduleFrom: s.scheduleFrom ?? null,
              scheduleTo: s.scheduleTo ?? null,
              workingHours: workHours,
              managerWorkFrom: s.managerWorkFrom ?? null,
              managerWorkTo: s.managerWorkTo ?? null,
              offlineReplyEnabled: s.offlineReplyEnabled ?? false,
              offlineReplyTemplate: s.offlineReplyTemplate ?? null,
              replyDelayMin: s.replyDelayMin ?? null,
              replyDelayMax: s.replyDelayMax ?? null,
              replyTo: s.replyTo,
              leadsGroupLink: s.leadsGroupLink ?? null,
            },
            reEngagement: {
              enabled: s.reEngagementEnabled ?? false,
              aiMode: s.reEngagementAiMode ?? "template",
              delays: s.reEngagementDelays ?? [],
              delayFrom: s.reEngagementDelayFrom ?? null,
              delayTo: s.reEngagementDelayTo ?? null,
              delayMore: s.reEngagementDelayMore ?? false,
              pauseMin: s.reEngagementPauseMin ?? 0,
              pauseMax: s.reEngagementPauseMax ?? 0,
              nameOnly: s.reEngagementNameOnly ?? false,
              tone: s.reEngagementTone ?? "balanced",
              aiContinue: s.reEngagementAiContinue ?? false,
              template: s.reEngagementTemplate ? s.reEngagementTemplate.slice(0, 200) : null,
            },
            forbiddenPhrases: [
              {
                category: "Сомнения клиента",
                phrases: ["ты сомневался", "ты не был уверен", "колебался"],
              },
              {
                category: "Предположения о сфере деятельности",
                phrases: ["из айти сферы", "в IT сфере", "как айтишник", "для бизнеса"],
              },
              {
                category: "Нарратив о клиенте",
                phrases: [
                  "ты говорил",
                  "ты писал",
                  "ты упоминал",
                  "ты говоришь, что",
                  "ты хочешь найти",
                ],
              },
              {
                category: "Открытые предложения времени",
                phrases: ["подстроюсь под любое", "в любое время", "когда тебе удобно/комфортнее"],
              },
              {
                category: "Корпоративный стиль (мы→я)",
                phrases: ["мы можем", "мы предлагаем", "sunabiliriz", "we can offer", "we offer"],
              },
              {
                category: "Клише и пустые фразы",
                phrases: [
                  "рад помочь",
                  "отличный вопрос",
                  "конечно!",
                  "как дела?",
                  "чем могу помочь?",
                  "надеюсь",
                ],
              },
            ],
          });
          break;
        }

        case "telegram.agent.setSettings": {
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          const incoming = (p.settings ?? {}) as Record<string, unknown>;
          const scheduleMode = incoming.scheduleMode;
          if (scheduleMode !== "always" && scheduleMode !== "schedule") {
            fail("invalid scheduleMode");
            break;
          }
          const replyTo = incoming.replyTo;
          if (replyTo !== "all" && replyTo !== "tasks") {
            fail("invalid replyTo");
            break;
          }
          // Merge with existing settings — preserves all fields including new ones
          const existing = this.storage.getAgentSettings(String(p.agentId));
          const settings: AgentSettings = {
            ...existing,
            ...(incoming as Partial<AgentSettings>),
            scheduleMode,
            replyTo,
          };
          this.storage.saveAgentSettings(String(p.agentId), settings);
          respond({ ok: true, settings });
          break;
        }

        case "telegram.agent.initLeadsGroup": {
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          const agent = (this.manager as any).pool?.get(String(p.agentId));
          if (!agent) {
            fail("agent not found or not running");
            break;
          }
          await (agent as any).initLeadsGroup();
          respond({ ok: true });
          break;
        }

        case "telegram.agent.generateReEngagementTemplate": {
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          const agentRecord = this.manager.get(String(p.agentId));
          const agentName = agentRecord?.name ?? "AI-менеджер";

          // Adapt template generation to buyer mode if active.
          // Note: no chat history here — this is a generic skeleton.
          // The enhance step (sendReEngagement → enhanceReEngagementMessage) will
          // later personalise it using the actual conversation history.
          const rtSettings = this.storage.getAgentSettings(String(p.agentId));
          const rtIsBuyer = rtSettings.schemaDeliveryStyle === "buyer";
          const rtAggression = rtSettings.buyerAggressionLevel ?? "balanced";

          const systemPrompt = rtIsBuyer
            ? "Ты баер-копирайтер. Создай реактивационный шаблон-скелет — уверенный, без воды. " +
              "Шаблон будет персонализирован под конкретного клиента позже, " +
              "поэтому он должен легко адаптироваться под любую нишу и ситуацию. " +
              "Никакого 'как дела', 'давно не виделись', пустых вопросов. " +
              (rtAggression === "hard"
                ? "Тон прямой, без сантиментов. "
                : rtAggression === "soft"
                  ? "Тон мягкий: пробуди интерес, не дави. "
                  : "Тон уверенный, не давящий. ") +
              "1–2 предложения. Плейсхолдер {имя}. Только текст — без кавычек, пояснений, markdown."
            : "Ты эксперт по продажам и копирайтингу. Создай короткий, живой и цепляющий шаблон " +
              "сообщения для реактивации клиента, который давно молчал. " +
              "Шаблон должен: быть персонализированным (используй плейсхолдер {имя}), " +
              "создавать срочность или интерес, быть 1-2 предложения максимум, " +
              "содержать эмодзи для оживления. " +
              "Отвечай ТОЛЬКО текстом шаблона, без кавычек, без пояснений, без markdown.";

          const userPrompt = rtIsBuyer
            ? `Агент: ${agentName}\n` +
              `Напиши реактивационный шаблон в баер-стиле. Плейсхолдер {имя} в начале.\n` +
              `Шаблон должен звучать как начало конкретного разговора, не как напоминалка.\n` +
              `Примеры правильного духа:\n` +
              `- "{имя}, вопрос: ты ещё в теме или уже нет? Потому что ситуация изменилась 📌"\n` +
              `- "{имя} — помнишь о чём говорили? Есть конкретика, отвечу сразу"\n` +
              `- "{имя}, смотри — пока думал, расклад поменялся 🔥 Актуально?"`
            : `Агент называется: ${agentName}\n` +
              `Создай цепляющий шаблон реактивации. Используй плейсхолдер {имя} в начале.\n` +
              `Примеры хороших шаблонов:\n` +
              `- "Привет {имя}! 🔥 Горит сделка с профитом 37%, последние места — ты с нами?"\n` +
              `- "{имя}, привет! Помнишь наш разговор? Сегодня особые условия — только сегодня 🎯"\n` +
              `- "Эй {имя}! Пока ты думал, 5 человек уже зашли 💸 Успеваешь?"`;

          try {
            const template = await callAdapterOnce(userPrompt, systemPrompt);
            const cleaned = template.replace(/^["«»']+|["«»']+$/g, "").trim();
            respond({ template: cleaned });
          } catch (e) {
            fail(`AI generation failed: ${String(e)}`);
          }
          break;
        }

        // ── Auth (userbot) ─────────────────────────────────────────────────

        case "telegram.agent.authStart":
          await this.manager.authStart(p.agentId);
          respond({ step: "code_sent" });
          break;

        case "telegram.agent.authSubmit":
          await this.manager.authSubmit(p.agentId, p.code, p.password);
          respond({ authenticated: true });
          break;

        // ── Tools (imperative calls) ───────────────────────────────────────
        // These mirror CDP "forwardCDPCommand" but for Telegram.
        // e.g.: { method: "telegram.tool.call", params: { agentId, tool: "sendMessage", args: { target: "@user", message: "hi" } } }
        //
        // IMPORTANT: the result from callTool (e.g. gramjs Message objects) must be
        // sanitized via safeSerialize before being placed in the respond payload.
        // gramjs objects contain live PromisedNetSockets which cannot be cloned by
        // structuredClone. If a non-serializable object leaks into a tool result, it
        // gets stored in the agent's message history and causes DataCloneError on every
        // subsequent call to transformContext → emitContext in the pi-agent framework.

        case "telegram.tool.call": {
          const result = await this.manager.callTool(p.agentId, p.tool, p.args ?? {});
          respond({ ok: true, data: result });
          break;
        }

        // ── Task sessions ──────────────────────────────────────────────────

        case "telegram.agent.assignTask": {
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          if (!p.chatId) {
            fail("chatId is required");
            break;
          }
          if (!p.task) {
            fail("task is required");
            break;
          }

          // Resolve username-style chatIds to numeric peer IDs so that the task
          // session handler can match incoming messages (which always carry a
          // numeric Telegram peer ID) against the stored session.
          // A pure numeric string (e.g. "123456789") is already resolved.
          let resolvedChatId = String(p.chatId);
          if (!isNumericTelegramId(resolvedChatId)) {
            try {
              const entityResult = (await this.manager.callTool(p.agentId, "resolveEntityId", {
                target: resolvedChatId,
              })) as ResolveEntityResult;
              if (entityResult?.id && isNumericTelegramId(entityResult.id)) {
                resolvedChatId = entityResult.id;
              }
            } catch {
              // Resolution failed (e.g. bot doesn't support getChat for this user);
              // fall through with original chatId. The opening-message fallback below
              // will still attempt to update it.
            }
          }

          const session: TaskSession = {
            id: randomUUID(),
            chatId: resolvedChatId,
            task: String(p.task),
            ...(p.systemPrompt ? { systemPrompt: String(p.systemPrompt) } : {}),
            status: "active",
            startedAt: new Date().toISOString(),
            ...(p.initiatedBy ? { initiatedBy: String(p.initiatedBy) } : {}),
          };
          await this.manager.assignTaskSession(p.agentId, session);

          // Optionally send an opening message right away.
          // As a fallback for agents that cannot resolve usernames directly (e.g.
          // BotAgent/grammy), extract the resolved numeric chatId from the sent
          // message result and update the session so subsequent replies can be matched.
          let openingMessageError: string | undefined;
          if (p.openingMessage) {
            try {
              const msgResult = await this.manager.callTool(p.agentId, "sendMessage", {
                target: p.chatId,
                message: p.openingMessage,
              });
              // Attempt to extract the resolved numeric peer ID from the result:
              //   BotAgent (grammy): result.chat.id (number)
              //   UserBotAgent (gramjs): result.peerId.userId / result.peerId.chatId (BigInt)
              // Both are cast through unknown to avoid "any" — we read optional fields.
              const raw = msgResult as {
                chat?: { id?: number };
                peerId?: { userId?: bigint; chatId?: bigint };
              };
              const numericFromResult = raw?.chat?.id ?? raw?.peerId?.userId ?? raw?.peerId?.chatId;
              if (numericFromResult != null) {
                const resolvedFromMsg = String(numericFromResult);
                if (isNumericTelegramId(resolvedFromMsg) && resolvedFromMsg !== session.chatId) {
                  // Update the persisted session with the numeric peer ID
                  await this.manager.assignTaskSession(p.agentId, {
                    ...session,
                    chatId: resolvedFromMsg,
                  });
                }
              }
            } catch (e) {
              openingMessageError = String(e);
              // Log the actual reason (not just metadata) so it appears in the gateway log
              this.ctx.logger.warn(
                `[TelegramPlugin] opening message to ${p.chatId} failed: ${openingMessageError}`,
              );
            }
          }
          // Always respond ok (session is active); include warning if message failed
          respond({
            ok: true,
            sessionId: session.id,
            ...(openingMessageError ? { openingMessageWarning: openingMessageError } : {}),
          });
          break;
        }

        case "telegram.agent.listTaskSessions":
          respond(this.manager.listTaskSessions(p.agentId));
          break;

        case "telegram.agent.completeTaskSession":
          await this.manager.completeTaskSession(p.agentId, p.sessionId);
          respond({ ok: true });
          break;

        // ── Core files ─────────────────────────────────────────────────────

        case "telegram.agent.getCoreFiles": {
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          const workspaceDir = this.agentWorkspaceDir(String(p.agentId));
          const files = TelegramPlugin.CORE_FILE_NAMES.map((name) => {
            const filePath = path.join(workspaceDir, name);
            try {
              const stat = fs.statSync(filePath);
              return {
                name,
                sizeBytes: stat.size,
                updatedAt: stat.mtime.toISOString(),
                missing: false,
              };
            } catch {
              return { name, missing: true };
            }
          });
          respond({ files, workspacePath: workspaceDir });
          break;
        }

        case "telegram.agent.setCoreFile": {
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          const filename = String(p.filename ?? "");
          if (!(TelegramPlugin.CORE_FILE_NAMES as readonly string[]).includes(filename)) {
            fail(`Invalid filename. Allowed: ${TelegramPlugin.CORE_FILE_NAMES.join(", ")}`);
            break;
          }
          const workspaceDir = this.agentWorkspaceDir(String(p.agentId));
          fs.mkdirSync(workspaceDir, { recursive: true });
          fs.writeFileSync(path.join(workspaceDir, filename), String(p.content ?? ""), "utf-8");
          respond({ ok: true });
          break;
        }

        case "telegram.agent.getCoreFileContent": {
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          const filename = String(p.filename ?? "");
          if (!(TelegramPlugin.CORE_FILE_NAMES as readonly string[]).includes(filename)) {
            fail(`Invalid filename. Allowed: ${TelegramPlugin.CORE_FILE_NAMES.join(", ")}`);
            break;
          }
          const filePath = path.join(this.agentWorkspaceDir(String(p.agentId)), filename);
          try {
            const content = fs.readFileSync(filePath, "utf-8");
            respond({ filename, content });
          } catch {
            // File doesn't exist — return empty string so the editor can start fresh
            respond({ filename, content: "" });
          }
          break;
        }

        // ── Missions ───────────────────────────────────────────────────────

        case "telegram.mission.create": {
          if (!p.masterAgentId) {
            fail("masterAgentId is required");
            break;
          }
          if (!p.title) {
            fail("title is required");
            break;
          }
          if (!p.goal) {
            fail("goal is required");
            break;
          }
          const mission = this.manager.createMission(
            String(p.masterAgentId),
            String(p.title),
            String(p.goal),
            Array.isArray(p.participantIds) ? p.participantIds.map(String) : [],
            p.systemPrompt ? String(p.systemPrompt) : undefined,
          );
          respond(mission);
          break;
        }

        case "telegram.mission.list":
          respond(this.manager.getMissions());
          break;

        case "telegram.mission.get": {
          if (!p.missionId) {
            fail("missionId is required");
            break;
          }
          const mission = this.manager.getMission(String(p.missionId));
          if (!mission) {
            fail(`Mission not found: ${p.missionId}`);
            break;
          }
          respond(mission);
          break;
        }

        case "telegram.mission.complete": {
          if (!p.missionId) {
            fail("missionId is required");
            break;
          }
          this.manager.completeMission(String(p.missionId));
          respond({ ok: true });
          break;
        }

        case "telegram.mission.messages": {
          if (!p.missionId) {
            fail("missionId is required");
            break;
          }
          const messages = this.manager.getMissionMessages(
            String(p.missionId),
            typeof p.limit === "number" ? p.limit : undefined,
          );
          respond(messages);
          break;
        }

        case "telegram.agent.sendMessage_to_agent": {
          if (!p.fromAgentId) {
            fail("fromAgentId is required");
            break;
          }
          if (!p.toAgentId) {
            fail("toAgentId is required");
            break;
          }
          if (!p.missionId) {
            fail("missionId is required");
            break;
          }
          if (!p.content) {
            fail("content is required");
            break;
          }
          const msg = await this.manager.sendAgentMessage(
            String(p.fromAgentId),
            String(p.toAgentId),
            String(p.missionId),
            String(p.content),
          );
          respond(msg);
          break;
        }

        // ── Data ───────────────────────────────────────────────────────────

        case "telegram.events.get":
          respond(this.manager.getEvents(p.agentId, p.limit));
          break;

        case "telegram.parsed.get":
          respond(this.manager.getParsed(p.agentId, p.limit));
          break;

        // ── Plugin credentials config ──────────────────────────────────────

        case "telegram.config.get": {
          const cfg = this.storage.loadPluginConfig();
          respond({
            configured: cfg !== null,
            apiId: cfg?.apiId ?? null,
            // Never return the hash in plaintext; only signal whether it's set
            apiHashSet: !!cfg?.apiHash,
            // Proxy info (password never returned)
            proxyConfigured: !!(cfg?.proxy?.ip && cfg?.proxy?.port),
            proxyIp: cfg?.proxy?.ip ?? null,
            proxyPort: cfg?.proxy?.port ?? null,
            proxyUsername: cfg?.proxy?.username ?? null,
          });
          break;
        }

        // ── Anthropic API key management ───────────────────────────────────

        case "telegram.config.checkAnthropicKey": {
          // Returns whether ANTHROPIC_API_KEY is currently set (env OR saved config).
          const hasKey = !!process.env.ANTHROPIC_API_KEY?.trim();
          respond({ hasKey });
          break;
        }

        case "telegram.config.setAnthropicKey": {
          const newKey = String(p.key ?? "").trim();
          if (!newKey) {
            fail("key is required");
            break;
          }
          // Basic format sanity check — Anthropic keys start with "sk-ant-"
          if (!newKey.startsWith("sk-ant-")) {
            fail("Неверный формат ключа. Anthropic API ключ должен начинаться с «sk-ant-»");
            break;
          }
          // Apply immediately so the next image call picks it up
          process.env.ANTHROPIC_API_KEY = newKey;
          resetDirectAdapter();
          // Persist to plugin-config.json alongside apiId/apiHash
          const existingCfg = this.storage.loadPluginConfig() ?? { apiId: 0, apiHash: "" };
          this.storage.savePluginConfig({ ...existingCfg, anthropicApiKey: newKey });
          respond({ ok: true });
          break;
        }

        case "telegram.config.set": {
          const apiId = parseInt(String(p.apiId ?? "0"), 10);
          const apiHash = String(p.apiHash ?? "").trim();
          if (!apiId || !apiHash) {
            fail("apiId and apiHash are required");
            break;
          }
          // Optional proxy fields
          const proxyIp = String(p.proxyIp ?? "").trim();
          const proxyPort = parseInt(String(p.proxyPort ?? "0"), 10);
          const proxy: ProxyConfig | undefined =
            proxyIp && proxyPort
              ? {
                  socksType: 5,
                  ip: proxyIp,
                  port: proxyPort,
                  ...(p.proxyUsername ? { username: String(p.proxyUsername) } : {}),
                  ...(p.proxyPassword ? { password: String(p.proxyPassword) } : {}),
                }
              : undefined;
          this.storage.savePluginConfig({ apiId, apiHash, ...(proxy ? { proxy } : {}) });
          respond({ ok: true });
          break;
        }

        // Proxy-only update — preserves existing apiId/apiHash, only modifies proxy
        case "telegram.config.setProxy": {
          const existing = this.storage.loadPluginConfig();
          if (!existing) {
            fail("API credentials not configured yet");
            break;
          }
          const proxyIp = String(p.proxyIp ?? "").trim();
          const proxyPort = parseInt(String(p.proxyPort ?? "0"), 10);
          // Pass clear:true to remove proxy without changing credentials
          if (p.clear) {
            this.storage.savePluginConfig({ ...existing, proxy: undefined });
            respond({ ok: true, cleared: true });
            break;
          }
          if (!proxyIp || !proxyPort) {
            fail("proxyIp and proxyPort are required (or pass clear:true to remove proxy)");
            break;
          }
          const proxy: ProxyConfig = {
            socksType: 5,
            ip: proxyIp,
            port: proxyPort,
            ...(p.proxyUsername ? { username: String(p.proxyUsername) } : {}),
            ...(p.proxyPassword ? { password: String(p.proxyPassword) } : {}),
          };
          this.storage.savePluginConfig({ ...existing, proxy });
          respond({ ok: true });
          break;
        }

        // ── Scenario: Conversation States ─────────────────────────────────

        case "telegram.scenario.getConversationStates": {
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          // Returns array of {chatId, nodeId} for all chats tracked for this agent.
          // nodeId == "__done__" means schema completed → free continuation mode.
          respond(this.storage.getAllConversationStates(String(p.agentId)));
          break;
        }

        // ── Leads ─────────────────────────────────────────────────────────

        case "telegram.leads.list": {
          if (!p.agentId) {
            fail("agentId required");
            break;
          }
          respond({ leads: this.storage.getLeads(String(p.agentId)) });
          break;
        }

        case "telegram.leads.save": {
          if (!p.lead || typeof p.lead !== "object") {
            fail("lead required");
            break;
          }
          this.storage.saveLead(p.lead as import("./types.js").TelegramLead);
          respond({ ok: true });
          break;
        }

        case "telegram.leads.delete": {
          if (!p.leadId) {
            fail("leadId required");
            break;
          }
          this.storage.deleteLead(String(p.leadId));
          respond({ ok: true });
          break;
        }

        // ── Scenario: Chat Nodes ───────────────────────────────────────────

        case "telegram.scenario.getChatNodes": {
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          respond(this.storage.getChatNodes(String(p.agentId)));
          break;
        }

        case "telegram.scenario.saveChatNode": {
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          if (!p.node || typeof p.node !== "object") {
            fail("node is required");
            break;
          }
          const n = p.node as Partial<ChatNode>;
          const now = new Date().toISOString();
          const node: ChatNode = {
            id: n.id ?? randomUUID(),
            agentId: String(p.agentId),
            role: n.role === "manager" || n.role === "client" ? n.role : "manager",
            text: String(n.text ?? ""),
            nextNodeId: n.nextNodeId ?? undefined,
            branches: Array.isArray(n.branches) ? n.branches : [],
            position: n.position ?? undefined,
            createdAt: n.createdAt ?? now,
          };
          this.storage.saveChatNode(node);
          respond(node);
          break;
        }

        case "telegram.scenario.deleteChatNode": {
          if (!p.nodeId) {
            fail("nodeId is required");
            break;
          }
          this.storage.deleteChatNode(String(p.nodeId));
          respond({ ok: true });
          break;
        }

        case "telegram.scenario.clearChatNodes": {
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          this.storage.clearChatNodes(String(p.agentId));
          respond({ ok: true });
          break;
        }

        // ── Scenario: Flow Nodes ───────────────────────────────────────────

        case "telegram.scenario.getFlowNodes": {
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          const fnScope = p.scope === "shared" ? "shared" : "personal";
          respond(this.storage.getFlowNodes(String(p.agentId), fnScope));
          break;
        }

        case "telegram.scenario.saveFlowNode": {
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          if (!p.node || typeof p.node !== "object") {
            fail("node is required");
            break;
          }
          const fn = p.node as Partial<FlowNode>;
          const sfScope: "personal" | "shared" = p.scope === "shared" ? "shared" : "personal";
          const now = new Date().toISOString();
          const flowNode: FlowNode = {
            id: fn.id ?? randomUUID(),
            agentId: String(p.agentId),
            scope: sfScope,
            title: String(fn.title ?? ""),
            description: fn.description ?? undefined,
            chatNodeIds: Array.isArray(fn.chatNodeIds) ? fn.chatNodeIds.map(String) : [],
            nextFlowNodeIds: Array.isArray(fn.nextFlowNodeIds)
              ? fn.nextFlowNodeIds.map(String)
              : [],
            position: fn.position ?? undefined,
            createdAt: fn.createdAt ?? now,
          };
          this.storage.saveFlowNode(flowNode);
          respond(flowNode);
          break;
        }

        case "telegram.scenario.deleteFlowNode": {
          if (!p.nodeId) {
            fail("nodeId is required");
            break;
          }
          this.storage.deleteFlowNode(String(p.nodeId));
          respond({ ok: true });
          break;
        }

        // ── Scenario: Visual Diagrams ──────────────────────────────────────

        case "telegram.scenario.getDiagram": {
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          const gdScope = p.scope === "shared" ? "shared" : "personal";
          respond(this.storage.getDiagram(String(p.agentId), gdScope));
          break;
        }

        case "telegram.scenario.saveDiagram": {
          if (!p.diagram || typeof p.diagram !== "object") {
            fail("diagram object is required");
            break;
          }
          const d = p.diagram as Record<string, unknown>;
          if (!d.agentId) {
            fail("diagram.agentId is required");
            break;
          }
          const sdScope: "personal" | "shared" = d.scope === "shared" ? "shared" : "personal";
          const now = new Date().toISOString();
          const diagram = {
            id: typeof d.id === "string" && d.id ? d.id : randomUUID(),
            agentId: String(d.agentId),
            scope: sdScope,
            title: typeof d.title === "string" ? d.title : "Схема",
            nodes: Array.isArray(d.nodes) ? d.nodes : [],
            edges: Array.isArray(d.edges) ? d.edges : [],
            groups: Array.isArray(d.groups) ? d.groups : [],
            createdAt: typeof d.createdAt === "string" ? d.createdAt : now,
            updatedAt: now,
          };
          this.storage.saveDiagram(diagram);
          respond(diagram);
          break;
        }

        case "telegram.scenario.listDiagrams": {
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          const ldScope = p.scope === "shared" ? "shared" : "personal";
          respond(this.storage.listDiagrams(String(p.agentId), ldScope));
          break;
        }

        case "telegram.scenario.deleteDiagram": {
          if (!p.id) {
            fail("id is required");
            break;
          }
          this.storage.deleteDiagram(String(p.id));
          respond({ ok: true });
          break;
        }

        case "telegram.scenario.renameDiagram": {
          if (!p.id) {
            fail("id is required");
            break;
          }
          if (typeof p.title !== "string") {
            fail("title is required");
            break;
          }
          this.storage.renameDiagram(String(p.id), String(p.title));
          respond({ ok: true });
          break;
        }

        case "telegram.scenario.diagramFromImage": {
          // Receive a base64-encoded image, analyze it with the configured AI provider (vision).
          if (!p.imageBase64 || typeof p.imageBase64 !== "string") {
            fail("imageBase64 is required");
            break;
          }
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          const mediaType = typeof p.mediaType === "string" ? p.mediaType : "image/jpeg";
          const diagramScope: "personal" | "shared" = p.scope === "shared" ? "shared" : "personal";

          const diagramSystemPrompt = `You are a diagram analysis assistant. The user will show you an image of a flowchart, business process, or diagram. Extract the structure and return it as a JSON object matching this TypeScript type:

interface FlowDiagram {
  title: string;
  nodes: Array<{ id: string; type: "start"|"end"|"process"|"decision"; text: string; x: number; y: number; groupId?: string }>;
  edges: Array<{ id: string; sourceId: string; targetId: string; label?: string }>;
  groups: Array<{ id: string; label: string; color: "blue"|"green"|"orange"|"purple"; x: number; y: number; w: number; h: number }>;
}

Rules:
- Use short unique IDs (8 random chars) for all id fields
- Place nodes in a readable layout: x in 0-800, y in 0-800 range, spaced 120-160px apart
- For groups, set x/y to enclose the contained nodes with 30px padding on each side
- If the image has no clear start/end, infer them
- Return ONLY the JSON object, no markdown, no explanation`;

          let rawText: string;
          try {
            rawText = await analyzeImageOnce(
              p.imageBase64 as string,
              mediaType,
              "Analyze this diagram image and return the FlowDiagram JSON.",
              diagramSystemPrompt,
            );
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err));
            break;
          }

          let parsed: {
            title?: string;
            nodes?: unknown[];
            edges?: unknown[];
            groups?: unknown[];
          };
          try {
            parsed = extractJsonFromAiReply(rawText) as typeof parsed;
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err));
            break;
          }

          const now = new Date().toISOString();
          const diagramResult = {
            id: randomUUID(),
            agentId: String(p.agentId),
            scope: diagramScope,
            title: typeof parsed.title === "string" ? parsed.title : "Схема из изображения",
            nodes: (Array.isArray(parsed.nodes) ? parsed.nodes : []) as DiagramNode[],
            edges: (Array.isArray(parsed.edges) ? parsed.edges : []) as DiagramEdge[],
            groups: (Array.isArray(parsed.groups) ? parsed.groups : []) as DiagramGroup[],
            createdAt: now,
            updatedAt: now,
          };
          this.storage.saveDiagram(diagramResult);
          respond(diagramResult);
          break;
        }

        case "telegram.scenario.diagramFromText": {
          // Generate a new diagram from a text description, or modify the existing diagram.
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          if (!p.prompt || typeof p.prompt !== "string" || !p.prompt.trim()) {
            fail("prompt is required");
            break;
          }
          const dftScope: "personal" | "shared" = p.scope === "shared" ? "shared" : "personal";
          const isModify =
            p.currentDiagram &&
            typeof p.currentDiagram === "object" &&
            Array.isArray((p.currentDiagram as { nodes?: unknown[] }).nodes) &&
            (p.currentDiagram as { nodes: unknown[] }).nodes.length > 0;

          const diagramSchema = `interface FlowDiagram {
  title: string;
  nodes: Array<{ id: string; type: "start"|"end"|"process"|"decision"; text: string; x: number; y: number; groupId?: string }>;
  edges: Array<{ id: string; sourceId: string; targetId: string; label?: string }>;
  groups: Array<{ id: string; label: string; color: "blue"|"green"|"orange"|"purple"; x: number; y: number; w: number; h: number }>;
}`;

          const systemPrompt = isModify
            ? `You are a flowchart editor. Output ONLY a single JSON object matching the FlowDiagram schema below. No prose, no questions, no explanations — just the JSON.

${diagramSchema}

Rules:
- Keep all existing node IDs/positions unless the change explicitly requires moving or deleting them
- Use short unique IDs (8 random chars) for any NEW nodes/edges/groups
- Keep x in 0-900, y in 0-900 range; space nodes 130-160px apart
- YOUR ENTIRE RESPONSE MUST BE THE JSON OBJECT. Nothing before or after it.`
            : `You are a flowchart generator. Output ONLY a single JSON object matching the FlowDiagram schema below. No prose, no questions, no explanations — just the JSON.

${diagramSchema}

Rules:
- Use short unique IDs (8 random chars) for all id fields
- Place nodes in a readable top-to-bottom layout, x in 0-900, y in 0-900, spaced 130-160px apart
- Always include at least one "start" and one "end" node
- For groups, set x/y to enclose the contained nodes with 30px padding on each side
- YOUR ENTIRE RESPONSE MUST BE THE JSON OBJECT. Nothing before or after it.`;

          const userPrompt = isModify
            ? `Current diagram:\n${JSON.stringify(p.currentDiagram)}\n\nModification request:\n${String(p.prompt)}`
            : `Generate a FlowDiagram JSON for this workflow:\n${String(p.prompt)}`;

          let rawText: string;
          try {
            rawText = await callAdapterOnceJson(userPrompt, systemPrompt);
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err));
            break;
          }

          let parsed: { title?: string; nodes?: unknown[]; edges?: unknown[]; groups?: unknown[] };
          try {
            parsed = extractJsonFromAiReply(rawText) as typeof parsed;
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err));
            break;
          }

          const now = new Date().toISOString();
          // Preserve the original diagram id when modifying so it updates in-place
          const existingId =
            isModify && typeof (p.currentDiagram as { id?: unknown }).id === "string"
              ? (p.currentDiagram as { id: string }).id
              : randomUUID();
          const dftResult = {
            id: existingId,
            agentId: String(p.agentId),
            scope: dftScope,
            title: typeof parsed.title === "string" ? parsed.title : "Схема",
            nodes: (Array.isArray(parsed.nodes) ? parsed.nodes : []) as DiagramNode[],
            edges: (Array.isArray(parsed.edges) ? parsed.edges : []) as DiagramEdge[],
            groups: (Array.isArray(parsed.groups) ? parsed.groups : []) as DiagramGroup[],
            createdAt: now,
            updatedAt: now,
          };
          this.storage.saveDiagram(dftResult);
          respond(dftResult);
          break;
        }

        // ── Scenario: Coaching tips ───────────────────────────────────────

        case "telegram.scenario.getCoachingTips": {
          // Analyse a single dialogue and return manager coaching tips.
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          if (!Array.isArray(p.pairs) || p.pairs.length === 0) {
            fail("pairs array is required");
            break;
          }
          const ctPairs = p.pairs as Array<{ input: string; response: string }>;
          const dialogText = ctPairs
            .map((pair, i) => `[${i + 1}] Клиент: ${pair.input}\n    Менеджер: ${pair.response}`)
            .join("\n\n");

          // Load agent settings to adapt coaching style for buyer mode.
          const ctAgentSettings = this.storage.getAgentSettings(String(p.agentId));
          const ctIsBuyer = ctAgentSettings.schemaDeliveryStyle === "buyer";
          const ctAggression = ctAgentSettings.buyerAggressionLevel ?? "balanced";
          const ctCloseStyle = ctAgentSettings.buyerCloseStyle ?? "alternative";
          const ctProductCtx = ctAgentSettings.buyerProductContext ?? "";

          const ctCloseStyleHint =
            ctCloseStyle === "direct"
              ? "прямое закрытие («Давай оформим прямо сейчас»)"
              : ctCloseStyle === "micro-step"
                ? "уверенный следующий шаг («Давай сделаем X» — без обоснований)"
                : "альтернативный выбор («Удобнее X или Y?»)";

          const ctAggressionHint =
            ctAggression === "hard"
              ? "жёсткий стиль: прямые предложения, минимум вопросов, максимум давления"
              : ctAggression === "soft"
                ? "мягкий стиль: больше вопросов, минимум давления, фокус на понимании"
                : "сбалансированный стиль: ROI + умеренная срочность";

          const ctSystem = ctIsBuyer
            ? `Ты — опытный баер-тренер по продажам. Агент работает в режиме баера: ROI, цифры, уверенный тон, без воды.
${ctProductCtx ? `Продукт/ниша: ${ctProductCtx}\n` : ""}Настройки агента: стиль закрытия — ${ctCloseStyleHint}; напористость — ${ctAggressionHint}.

Проанализируй переписку и дай КОНКРЕТНЫЕ советы как улучшить результат в баер-стиле.

Формат ответа — ТОЛЬКО нумерованный список на русском языке, 4–6 пунктов.
Каждый пункт: 1–2 предложения. Без вводных слов, без заголовков, без пояснений вне списка.

Фокусируйся на:
• Где можно было перевести в ROI ("ты платишь X, получаешь Y за Z") — укажи номер реплики
• Упущенные моменты для закрытия техникой "${ctCloseStyleHint}" — укажи номер реплики
• Возражения (цена / сомнения / "подумаю" / конкурент) — что конкретно стоило сказать
• Где менеджер говорил расплывчато вместо цифр и конкретики
• Как довести до конкретного следующего шага с минимальным барьером`
            : `Ты — опытный тренер по продажам B2C/B2B.
Проанализируй переписку менеджера с клиентом и дай КОНКРЕТНЫЕ советы, как менеджер мог бы лучше дожать и закрыть этого лида.

Формат ответа — ТОЛЬКО нумерованный список на русском языке, 4–6 пунктов.
Каждый пункт: 1–2 предложения. Без вводных слов, без заголовков, без пояснений вне списка.

Фокусируйся на:
• Упущенные моменты для закрытия (конкретный номер реплики)
• Формулировки, которые стоило использовать
• Работа с возражениями
• Как довести до конкретного следующего шага`;

          const ctUser = `Диалог менеджера с клиентом:\n\n${dialogText}`;

          let ctRaw: string;
          try {
            ctRaw = await callAdapterOnce(ctUser, ctSystem);
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err));
            break;
          }

          const ctResult = {
            chatId: String(p.chatId ?? ""),
            content: ctRaw.trim(),
            generatedAt: new Date().toISOString(),
          };
          // Persist so tips survive page reloads / gateway restarts
          const ctScope: "personal" | "shared" = p.scope === "shared" ? "shared" : "personal";
          this.storage.saveCoachingTip(
            String(p.agentId),
            ctResult.chatId,
            ctResult.content,
            ctResult.generatedAt,
            ctScope,
          );
          respond(ctResult);
          break;
        }

        case "telegram.scenario.loadCoachingTips": {
          // Load all persisted coaching tips for an agent.
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          const lctScope: "personal" | "shared" = p.scope === "shared" ? "shared" : "personal";
          const allTips = this.storage.getCoachingTips(String(p.agentId), lctScope);
          respond(allTips);
          break;
        }

        // ── Translation proxy (CSP bypass) ────────────────────────────────

        case "telegram.translate.text": {
          // Proxy Google Translate free API from server side to bypass UI CSP.
          const text = typeof p.text === "string" ? p.text.trim() : "";
          const targetLang = typeof p.targetLang === "string" ? p.targetLang : "ru";
          if (!text) {
            respond({ translated: "" });
            break;
          }
          try {
            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
            const res = await fetch(url);
            if (!res.ok) {
              respond({ translated: text });
              break;
            }
            const data = (await res.json()) as unknown[][];
            const translated =
              (data[0] as unknown[][]).map((item) => String(item[0])).join("") || text;
            respond({ translated });
          } catch {
            respond({ translated: text });
          }
          break;
        }

        // ── Scenario: Training ─────────────────────────────────────────────

        case "telegram.scenario.processTraining": {
          // Parse Telegram export JSON, extract dialogue pairs. Does NOT save to DB.
          if (!p.json || typeof p.json !== "string") {
            fail("json string is required");
            break;
          }
          const result = extractTrainingPairs(p.json as string);
          respond(result);
          break;
        }

        case "telegram.scenario.saveTrainingPairs": {
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          if (!Array.isArray(p.pairs)) {
            fail("pairs array is required");
            break;
          }
          const agentId = String(p.agentId);
          const sourceFile = String(p.sourceFile ?? "");
          const now = new Date().toISOString();
          const pairs: TrainingPair[] = (p.pairs as { input: string; response: string }[]).map(
            (pr) => ({
              id: randomUUID(),
              agentId,
              input: String(pr.input ?? ""),
              response: String(pr.response ?? ""),
              sourceFile,
              createdAt: now,
            }),
          );
          // Replace all existing training pairs for this agent
          this.storage.clearTrainingPairs(agentId);
          this.storage.saveTrainingPairs(pairs);
          respond({ ok: true, count: pairs.length });
          break;
        }

        case "telegram.scenario.getTrainingPairs": {
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          respond(this.storage.getTrainingPairs(String(p.agentId)));
          break;
        }

        case "telegram.scenario.saveTrainingSnapshot": {
          // Persist full training UI state (groups + labels + analysisResults) to SQLite.
          // scope: "personal" (per-agent) or "shared" (all agents share one record).
          const agentId = String(p.agentId ?? "");
          const scope = String(p.scope ?? "personal");
          if (!agentId) {
            fail("agentId is required");
            break;
          }
          if (!p.snapshot || typeof p.snapshot !== "object") {
            fail("snapshot object is required");
            break;
          }
          this.storage.saveTrainingSnapshot(agentId, scope, p.snapshot as Record<string, unknown>);
          respond({ ok: true });
          break;
        }

        case "telegram.scenario.getTrainingSnapshot": {
          // Retrieve a previously saved training snapshot. Returns null if not found.
          const agentId = String(p.agentId ?? "");
          const scope = String(p.scope ?? "personal");
          if (!agentId) {
            fail("agentId is required");
            break;
          }
          respond(this.storage.getTrainingSnapshot(agentId, scope));
          break;
        }

        case "telegram.scenario.createNodesFromPairs": {
          // Convert saved training pairs into ChatNodes and FlowNodes
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          const cnpScope: "personal" | "shared" = p.scope === "shared" ? "shared" : "personal";
          const agentId = String(p.agentId);
          const pairs = this.storage.getTrainingPairs(agentId);
          if (pairs.length === 0) {
            respond({ ok: true, created: 0 });
            break;
          }
          const now = new Date().toISOString();
          // Clear existing chat nodes and create new ones from pairs
          this.storage.clearChatNodes(agentId);
          const chatNodes: ChatNode[] = [];
          for (let i = 0; i < pairs.length; i++) {
            const pr = pairs[i];
            const clientId = randomUUID();
            const managerId = randomUUID();
            const nextClientId = i < pairs.length - 1 ? randomUUID() : undefined;
            chatNodes.push({
              id: clientId,
              agentId,
              role: "client",
              text: pr.input,
              nextNodeId: managerId,
              branches: [],
              createdAt: now,
            });
            chatNodes.push({
              id: managerId,
              agentId,
              role: "manager",
              text: pr.response,
              nextNodeId: nextClientId,
              branches: [],
              createdAt: now,
            });
          }
          for (const n of chatNodes) {
            this.storage.saveChatNode(n);
          }
          // Create a single "Training Import" flow node grouping all chat nodes
          const flowNode: FlowNode = {
            id: randomUUID(),
            agentId,
            scope: cnpScope,
            title: "Обучение (импорт)",
            description: `Создано из ${pairs.length} пар диалога`,
            chatNodeIds: chatNodes.map((n) => n.id),
            nextFlowNodeIds: [],
            createdAt: now,
          };
          this.storage.saveFlowNode(flowNode);
          respond({ ok: true, created: chatNodes.length, flowNodeId: flowNode.id });
          break;
        }

        // ── Knowledge base (diagram ↔ training) ──────────────────────────────

        case "telegram.scenario.getKnowledgeBase": {
          const agentId = String(p.agentId ?? "");
          const kbScope: "personal" | "shared" = p.scope === "shared" ? "shared" : "personal";
          if (!agentId) {
            fail("agentId is required");
            break;
          }
          const raw = this.storage.getKnowledgeBase(agentId, kbScope);
          respond(
            raw
              ? {
                  agentId,
                  scope: kbScope,
                  entries: raw.entries ?? [],
                  updatedAt: raw.updatedAt ?? "",
                }
              : null,
          );
          break;
        }

        case "telegram.scenario.saveKnowledgeBase": {
          const agentId = String(p.agentId ?? "");
          const kbScope2: "personal" | "shared" = p.scope === "shared" ? "shared" : "personal";
          if (!agentId) {
            fail("agentId is required");
            break;
          }
          if (!Array.isArray(p.entries)) {
            fail("entries array is required");
            break;
          }
          const now = new Date().toISOString();
          this.storage.saveKnowledgeBase(agentId, kbScope2, { entries: p.entries, updatedAt: now });
          respond({ ok: true });
          break;
        }

        case "telegram.scenario.distributeTrainingToNodes": {
          const agentId = String(p.agentId ?? "");
          const distScope: "personal" | "shared" = p.scope === "shared" ? "shared" : "personal";
          if (!agentId) {
            fail("agentId is required");
            break;
          }

          // Load diagram to get node list.
          // Priority: activeDiagramId from agent settings → latest for scope.
          const agentSettingsForDist = this.storage.getAgentSettings(agentId);
          const diagram =
            (agentSettingsForDist.activeDiagramId
              ? this.storage.getDiagramById(agentSettingsForDist.activeDiagramId)
              : null) ?? this.storage.getDiagram(agentId, distScope);
          if (!diagram || diagram.nodes.length === 0) {
            fail(
              "Нет схемы или узлов для этого агента/области. " +
                "Сначала создайте схему и выберите её как активную в настройках агента.",
            );
            break;
          }

          // Resolve training groups: prefer data sent directly by the UI (avoids needing a
          // saved snapshot, handles the case where the gateway was just restarted),
          // then fall back to the persisted snapshot.
          type RawGroup = {
            chatId: string;
            pairs: Array<{ input: string; response: string }>;
            label?: string;
          };
          let rawGroups: RawGroup[] = [];
          let labelsMap: Record<string, string> = {};

          if (Array.isArray(p.groups) && (p.groups as RawGroup[]).length > 0) {
            // UI sent training groups directly — use them.
            rawGroups = p.groups as RawGroup[];
          } else {
            // Fall back to persisted snapshot.
            const snapshot = this.storage.getTrainingSnapshot(agentId, distScope);
            if (snapshot) {
              rawGroups = Array.isArray(snapshot.groups) ? (snapshot.groups as RawGroup[]) : [];
              labelsMap = (snapshot.labels as Record<string, string> | undefined) ?? {};
            }
          }

          const allPairs: Array<{
            input: string;
            response: string;
            score: number;
            label?: string;
          }> = [];
          for (const g of rawGroups) {
            const label = labelsMap[g.chatId] ?? g.label ?? "neutral";
            const score = label === "success" ? 3 : label === "fail" ? 1 : 2;
            for (const pair of g.pairs ?? []) {
              allPairs.push({
                input: String(pair.input ?? ""),
                response: String(pair.response ?? ""),
                score,
                label,
              });
            }
          }
          // Sort by score descending so we send the best examples first
          allPairs.sort((a, b) => b.score - a.score);
          const topPairs = allPairs.slice(0, 80);

          if (topPairs.length === 0) {
            fail(
              "Нет пар вопрос/ответ в данных обучения. Убедитесь, что в разделе «Обучение» загружены диалоги для области «" +
                (distScope === "shared" ? "Общая" : "Личная") +
                "».",
            );
            break;
          }

          // Build AI prompt for distribution
          const nodeList = diagram.nodes
            .map((n) => `${n.id}: ${n.text.replace(/\n/g, " ")}`)
            .join("\n");
          const pairsText = topPairs
            .map(
              (pair, i) =>
                `[${i}] Q: ${pair.input.slice(0, 120)}\nA: ${pair.response.slice(0, 120)}`,
            )
            .join("\n---\n");

          const distSystem =
            `Ты — система распределения диалогов по узлам схемы продаж.\n` +
            `Твоя задача: каждую пару вопрос/ответ назначить на ОДИН наиболее подходящий узел схемы.\n\n` +
            `Верни ТОЛЬКО валидный JSON-объект: ключи — ID узлов, значения — массивы индексов пар.\n` +
            `Пример: {"node_abc": [0, 2, 5], "node_xyz": [1, 3]}\n\n` +
            `Правила:\n` +
            `- Каждая пара назначается РОВНО в один узел.\n` +
            `- Назначай пару в узел, чья тема/назначение наиболее точно совпадает с темой разговора.\n` +
            `- Используй ТОЛЬКО ID узлов из предоставленного списка.\n` +
            `- Не пропускай пары — все индексы от 0 до N-1 должны быть в ответе.\n` +
            `- Не добавляй пояснений — только JSON.`;
          const distUser =
            `Узлы схемы продаж:\n${nodeList}\n\n` +
            `Обучающие пары (индекс: вопрос → ответ менеджера):\n${pairsText}\n\n` +
            `Верни JSON-маппинг: какие пары (по индексу) относятся к каким узлам.`;

          let rawText: string;
          try {
            rawText = await callAdapterOnceJson(distUser, distSystem);
          } catch (err) {
            fail(`Ошибка ИИ: ${err instanceof Error ? err.message : String(err)}`);
            break;
          }

          // Parse AI mapping response
          let mapping: Record<string, number[]>;
          try {
            mapping = extractJsonFromAiReply(rawText) as Record<string, number[]>;
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err));
            break;
          }

          const nodeMap = new Map(diagram.nodes.map((n) => [n.id, n.text]));
          const entries = Object.entries(mapping)
            .filter(([nodeId]) => nodeMap.has(nodeId))
            .map(([nodeId, idxs]) => ({
              nodeId,
              nodeText: nodeMap.get(nodeId) ?? "",
              // Keep only valid indexes; sort by score desc within each node
              pairs: (Array.isArray(idxs) ? idxs : [])
                .filter((i): i is number => typeof i === "number" && topPairs[i] !== undefined)
                .map((i) => topPairs[i])
                .sort((a, b) => b.score - a.score),
            }))
            .filter((e) => e.pairs.length > 0);

          const updatedAt = new Date().toISOString();
          this.storage.saveKnowledgeBase(agentId, distScope, { entries, updatedAt });
          respond({ agentId, scope: distScope, entries, updatedAt });
          break;
        }

        // ── Build schema + KB from top training chats ─────────────────────
        case "telegram.scenario.buildFromTraining": {
          const agentId = String(p.agentId ?? "");
          const bftScope: "personal" | "shared" = p.scope === "shared" ? "shared" : "personal";
          if (!agentId) {
            fail("agentId is required");
            break;
          }

          // ── 1. Resolve groups + labels ────────────────────────────────────
          type BftGroup = {
            chatId: string;
            pairs: Array<{ input: string; response: string }>;
            label?: string;
          };
          let bftGroups: BftGroup[] = [];
          let bftLabels: Record<string, string> = {};

          if (Array.isArray(p.groups) && (p.groups as BftGroup[]).length > 0) {
            bftGroups = p.groups as BftGroup[];
            bftLabels = (p.labels as Record<string, string> | undefined) ?? {};
          } else {
            const snap = this.storage.getTrainingSnapshot(agentId, bftScope);
            if (snap) {
              bftGroups = Array.isArray(snap.groups) ? (snap.groups as BftGroup[]) : [];
              bftLabels = (snap.labels as Record<string, string> | undefined) ?? {};
            }
          }

          if (bftGroups.length === 0) {
            fail("Нет обучающих данных. Загрузите экспорт переписки в разделе «Обучение».");
            break;
          }

          // Annotate groups with effective label + sort: success first, then by pair count desc
          type ScoredGroup = BftGroup & { effectiveLabel: string; pairCount: number };
          const scored: ScoredGroup[] = bftGroups.map((g) => ({
            ...g,
            effectiveLabel: bftLabels[g.chatId] ?? g.label ?? "neutral",
            pairCount: (g.pairs ?? []).length,
          }));
          const labelRank = (l: string) => (l === "success" ? 0 : l === "neutral" ? 1 : 2);
          scored.sort(
            (a, b) =>
              labelRank(a.effectiveLabel) - labelRank(b.effectiveLabel) ||
              b.pairCount - a.pairCount,
          );

          // Top chats for schema generation: up to 15 success + up to 5 neutral
          const topSuccess = scored.filter((g) => g.effectiveLabel === "success").slice(0, 15);
          const topNeutral = scored.filter((g) => g.effectiveLabel === "neutral").slice(0, 5);
          const corpusGroups = [...topSuccess, ...topNeutral];
          if (corpusGroups.length === 0) {
            // No success/neutral — use all
            corpusGroups.push(...scored.slice(0, 10));
          }

          // Build corpus text (cap per-chat to 15 pairs, total ≤ 200 pairs)
          let totalPairs = 0;
          const corpusLines: string[] = [];
          for (const g of corpusGroups) {
            const label =
              g.effectiveLabel === "success" ? "✅" : g.effectiveLabel === "fail" ? "❌" : "⚪";
            corpusLines.push(`\n=== Диалог ${label} (${g.pairCount} обменов) ===`);
            const maxPairs = Math.min(g.pairs.length, 15, 200 - totalPairs);
            for (let i = 0; i < maxPairs; i++) {
              const pr = g.pairs[i];
              corpusLines.push(`Клиент: ${pr.input.slice(0, 150)}`);
              corpusLines.push(`Менеджер: ${pr.response.slice(0, 150)}`);
            }
            totalPairs += maxPairs;
            if (totalPairs >= 200) break;
          }
          const corpus = corpusLines.join("\n");

          const successCount = topSuccess.length;
          const totalCount = bftGroups.length;

          // ── 2. AI Call 1: Generate FlowDiagram ───────────────────────────
          const diagramSchema = `interface FlowDiagram {
  title: string;
  nodes: Array<{ id: string; type: "start"|"end"|"process"|"decision"; text: string; x: number; y: number; groupId?: string }>;
  edges: Array<{ id: string; sourceId: string; targetId: string; label?: string }>;
  groups: Array<{ id: string; label: string; color: "blue"|"green"|"orange"|"purple"; x: number; y: number; w: number; h: number }>;
}`;
          const schemaSystem =
            `Ты — эксперт по построению воронок продаж. Тебе дан корпус реальных диалогов менеджеров с клиентами.\n` +
            `Проанализируй диалоги и построй СХЕМУ ПРОДАЖ — FlowDiagram который отражает этапы воронки.\n\n` +
            `Правила:\n` +
            `- Выяви 5–12 ключевых этапов которые ведут клиента к сделке\n` +
            `- В успешных диалогах ищи паттерны: что говорит менеджер на каждом этапе\n` +
            `- В неуспешных — где диалог обрывается, какие возражения не были обработаны\n` +
            `- Добавь узлы для ключевых возражений (цена, сомнение, откладывает) с обходными путями\n` +
            `- Схема должна вести от первого контакта к оплате/лиду\n` +
            `- Используй короткие уникальные ID (8 случайных символов)\n` +
            `- x: 0–900, y: 0–900, расстояние между узлами 130–160px, сверху вниз\n` +
            `- ОТВЕТ: ТОЛЬКО JSON объект FlowDiagram. Никакого текста до или после.\n\n` +
            `${diagramSchema}`;
          const schemaUser =
            `Корпус диалогов (${successCount} успешных из ${totalCount} всего):\n${corpus}\n\n` +
            `Построй FlowDiagram для этой воронки продаж.`;

          let rawDiagram: string;
          try {
            rawDiagram = await callAdapterOnceJson(schemaUser, schemaSystem);
          } catch (err) {
            fail(`Ошибка генерации схемы: ${err instanceof Error ? err.message : String(err)}`);
            break;
          }

          let parsedDiagram: {
            title?: string;
            nodes?: unknown[];
            edges?: unknown[];
            groups?: unknown[];
          };
          try {
            parsedDiagram = extractJsonFromAiReply(rawDiagram) as typeof parsedDiagram;
          } catch (err) {
            fail(
              `Не удалось распарсить схему: ${err instanceof Error ? err.message : String(err)}`,
            );
            break;
          }

          const now = new Date().toISOString();
          const newDiagram = {
            id: randomUUID(),
            agentId,
            scope: bftScope,
            title:
              typeof parsedDiagram.title === "string" ? parsedDiagram.title : "Схема из обучения",
            nodes: (Array.isArray(parsedDiagram.nodes) ? parsedDiagram.nodes : []) as DiagramNode[],
            edges: (Array.isArray(parsedDiagram.edges) ? parsedDiagram.edges : []) as DiagramEdge[],
            groups: (Array.isArray(parsedDiagram.groups)
              ? parsedDiagram.groups
              : []) as DiagramGroup[],
            createdAt: now,
            updatedAt: now,
          };
          this.storage.saveDiagram(newDiagram);

          // ── 3. AI Call 2: Distribute ALL pairs to KB nodes (buyer-style) ──
          // Collect all pairs from all groups sorted by score
          const allBftPairs: Array<{ input: string; response: string; score: number }> = [];
          for (const g of scored) {
            const s = g.effectiveLabel === "success" ? 3 : g.effectiveLabel === "neutral" ? 2 : 1;
            for (const pr of g.pairs ?? []) {
              allBftPairs.push({
                input: String(pr.input ?? ""),
                response: String(pr.response ?? ""),
                score: s,
              });
            }
          }
          allBftPairs.sort((a, b) => b.score - a.score);
          const topBftPairs = allBftPairs.slice(0, 100);

          const nodeList = newDiagram.nodes
            .filter((n) => n.type !== "start" && n.type !== "end")
            .map((n) => `${n.id}: ${(n.text as string).replace(/\n/g, " ")}`)
            .join("\n");

          const pairsText = topBftPairs
            .map((pr, i) => `[${i}] Q: ${pr.input.slice(0, 120)}\nA: ${pr.response.slice(0, 120)}`)
            .join("\n---\n");

          const kbSystem =
            `Ты — система распределения диалогов по узлам схемы продаж в стиле баера.\n` +
            `Для каждой пары вопрос/ответ выбери ОДИН наиболее подходящий узел схемы.\n` +
            `Верни ТОЛЬКО валидный JSON: ключи — ID узлов, значения — массивы индексов пар.\n` +
            `Пример: {"node_abc": [0, 2, 5], "node_xyz": [1, 3]}\n` +
            `Правила:\n` +
            `- Каждая пара назначается РОВНО в один узел\n` +
            `- Назначай пару туда где тема разговора совпадает с узлом\n` +
            `- Все индексы от 0 до ${topBftPairs.length - 1} должны присутствовать\n` +
            `- Только JSON, без пояснений`;
          const kbUser = `Узлы схемы:\n${nodeList}\n\nПары (индекс: вопрос → ответ):\n${pairsText}\n\nРаспредели пары по узлам.`;

          let rawMapping: string;
          try {
            rawMapping = await callAdapterOnceJson(kbUser, kbSystem);
          } catch (err) {
            // KB generation failed — still return the diagram
            respond({ diagram: newDiagram, kb: null, kbError: String(err) });
            break;
          }

          let mapping: Record<string, number[]>;
          try {
            mapping = extractJsonFromAiReply(rawMapping) as Record<string, number[]>;
          } catch {
            respond({ diagram: newDiagram, kb: null, kbError: "Не удалось распарсить маппинг KB" });
            break;
          }

          const nodeMap = new Map(newDiagram.nodes.map((n) => [n.id, n.text as string]));
          const kbEntries = Object.entries(mapping)
            .filter(([nodeId]) => nodeMap.has(nodeId))
            .map(([nodeId, idxs]) => ({
              nodeId,
              nodeText: nodeMap.get(nodeId) ?? "",
              pairs: (Array.isArray(idxs) ? idxs : [])
                .filter((i): i is number => typeof i === "number" && topBftPairs[i] !== undefined)
                .map((i) => topBftPairs[i])
                .sort((a, b) => b.score - a.score),
            }))
            .filter((e) => e.pairs.length > 0);

          const kbUpdatedAt = new Date().toISOString();
          this.storage.saveKnowledgeBase(agentId, bftScope, {
            entries: kbEntries,
            updatedAt: kbUpdatedAt,
          });

          respond({
            diagram: newDiagram,
            kb: { agentId, scope: bftScope, entries: kbEntries, updatedAt: kbUpdatedAt },
          });
          break;
        }

        default:
          fail(`Unknown method: ${msg.method}`);
      }
    } catch (err) {
      fail(String(err));
    }

    return true; // handled
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** Returns the workspace directory path for a given agent */
  private agentWorkspaceDir(agentId: string): string {
    return path.join(this.ctx.dataDir, "telegram", "agents", agentId, "workspace");
  }

  // ─── HTTP REST routes (optional, for non-WS clients) ─────────────────────

  httpRoutes(): HttpRoute[] {
    const mgr = this.manager;

    return [
      // GET /telegram/agents
      {
        method: "GET",
        path: "/telegram/agents",
        handler: (req, res) => res.json({ ok: true, data: mgr.list().map(safeRecord) }),
      },
      // GET /telegram/agents/:id
      {
        method: "GET",
        path: "/telegram/agents/:id",
        handler: (req, res) => {
          const r = mgr.get(req.params.id);
          r
            ? res.json({ ok: true, data: safeRecord(r) })
            : res.status(404).json({ ok: false, error: "Not found" });
        },
      },
      // POST /telegram/agents
      {
        method: "POST",
        path: "/telegram/agents",
        handler: async (req, res) => {
          const { name, credentials, behaviors } = req.body;
          const r = mgr.create(name, credentials, behaviors);
          res.status(201).json({ ok: true, data: safeRecord(r) });
        },
      },
      // DELETE /telegram/agents/:id
      {
        method: "DELETE",
        path: "/telegram/agents/:id",
        handler: async (req, res) => {
          await mgr.delete(req.params.id);
          res.json({ ok: true });
        },
      },
      // POST /telegram/agents/:id/start
      {
        method: "POST",
        path: "/telegram/agents/:id/start",
        handler: async (req, res) => {
          await mgr.start(req.params.id);
          res.json({ ok: true });
        },
      },
      // POST /telegram/agents/:id/stop
      {
        method: "POST",
        path: "/telegram/agents/:id/stop",
        handler: async (req, res) => {
          await mgr.stop(req.params.id);
          res.json({ ok: true });
        },
      },
      // POST /telegram/agents/:id/restart
      {
        method: "POST",
        path: "/telegram/agents/:id/restart",
        handler: async (req, res) => {
          await mgr.restart(req.params.id);
          res.json({ ok: true });
        },
      },
      // PUT /telegram/agents/:id/behaviors
      {
        method: "PUT",
        path: "/telegram/agents/:id/behaviors",
        handler: async (req, res) => {
          await mgr.setBehaviors(req.params.id, req.body.behaviors);
          res.json({ ok: true });
        },
      },
      // POST /telegram/agents/:id/auth/start
      {
        method: "POST",
        path: "/telegram/agents/:id/auth/start",
        handler: async (req, res) => {
          await mgr.authStart(req.params.id);
          res.json({ ok: true, step: "code_sent" });
        },
      },
      // POST /telegram/agents/:id/auth/submit
      {
        method: "POST",
        path: "/telegram/agents/:id/auth/submit",
        handler: async (req, res) => {
          await mgr.authSubmit(req.params.id, req.body.code, req.body.password);
          res.json({ ok: true, authenticated: true });
        },
      },
      // POST /telegram/agents/:id/tool
      {
        method: "POST",
        path: "/telegram/agents/:id/tool",
        handler: async (req, res) => {
          const data = await mgr.callTool(req.params.id, req.body.tool, req.body.args ?? {});
          res.json({ ok: true, data: safeSerialize(data) });
        },
      },
      // GET /telegram/agents/:id/events
      {
        method: "GET",
        path: "/telegram/agents/:id/events",
        handler: (req, res) =>
          res.json({
            ok: true,
            data: mgr.getEvents(req.params.id, parseInt(req.query.limit ?? "200")),
          }),
      },
      // GET /telegram/agents/:id/parsed
      {
        method: "GET",
        path: "/telegram/agents/:id/parsed",
        handler: (req, res) =>
          res.json({
            ok: true,
            data: mgr.getParsed(req.params.id, parseInt(req.query.limit ?? "1000")),
          }),
      },
      // GET /telegram/agents/:id/core-files
      {
        method: "GET",
        path: "/telegram/agents/:id/core-files",
        handler: (req, res) => {
          const workspaceDir = this.agentWorkspaceDir(req.params.id);
          const files = TelegramPlugin.CORE_FILE_NAMES.map((name) => {
            const filePath = path.join(workspaceDir, name);
            try {
              const stat = fs.statSync(filePath);
              return {
                name,
                sizeBytes: stat.size,
                updatedAt: stat.mtime.toISOString(),
                missing: false,
              };
            } catch {
              return { name, missing: true };
            }
          });
          res.json({ ok: true, data: { files, workspacePath: workspaceDir } });
        },
      },
      // GET /telegram/agents/:id/core-files/:filename
      {
        method: "GET",
        path: "/telegram/agents/:id/core-files/:filename",
        handler: (req, res) => {
          const filename = req.params.filename;
          if (!(TelegramPlugin.CORE_FILE_NAMES as readonly string[]).includes(filename)) {
            res.status(400).json({ ok: false, error: `Invalid filename: ${filename}` });
            return;
          }
          const filePath = path.join(this.agentWorkspaceDir(req.params.id), filename);
          try {
            const content = fs.readFileSync(filePath, "utf-8");
            res.json({ ok: true, data: { filename, content } });
          } catch {
            res.status(404).json({ ok: false, error: "File not found" });
          }
        },
      },
      // PUT /telegram/agents/:id/core-files/:filename
      {
        method: "PUT",
        path: "/telegram/agents/:id/core-files/:filename",
        handler: async (req, res) => {
          const filename = req.params.filename;
          if (!(TelegramPlugin.CORE_FILE_NAMES as readonly string[]).includes(filename)) {
            res.status(400).json({ ok: false, error: `Invalid filename: ${filename}` });
            return;
          }
          const workspaceDir = this.agentWorkspaceDir(req.params.id);
          fs.mkdirSync(workspaceDir, { recursive: true });
          fs.writeFileSync(
            path.join(workspaceDir, filename),
            String(req.body?.content ?? ""),
            "utf-8",
          );
          res.json({ ok: true });
        },
      },
    ];
  }
}

// ─── Training pair extraction ─────────────────────────────────────────────────

/** Flatten Telegram export text (string or array of strings/objects) to plain text. */
function flattenExportText(text: TelegramExportMessage["text"]): string {
  if (typeof text === "string") return text;
  return text
    .map((t) => (typeof t === "string" ? t : ((t as { text?: string }).text ?? "")))
    .join("");
}

/**
 * Parse a raw Telegram export JSON string, detect manager vs client, and
 * return dialogue pairs {input, response} plus metadata.
 */
function extractTrainingPairs(json: string): {
  pairs: { input: string; response: string }[];
  managerFromId: string;
  error?: string;
} {
  let chat: TelegramExportChat;
  try {
    chat = JSON.parse(json) as TelegramExportChat;
  } catch {
    return { pairs: [], managerFromId: "", error: "Invalid JSON" };
  }
  if (!Array.isArray(chat.messages)) {
    return { pairs: [], managerFromId: "", error: "No messages array found" };
  }

  // Skip entire bot-chat conversations — no useful human training signal.
  // Telegram exports use "bot_chat" in some versions; also guard by name pattern.
  const isBotName = (name: string | null) =>
    !!name && /bot$/i.test(name.trim().replace(/\s+/g, ""));
  if (chat.type === "bot_chat" || isBotName(chat.name)) {
    return { pairs: [], managerFromId: "", error: "Skipped: bot conversation" };
  }

  // Returns true if a message was sent by or through a bot:
  //  - via_bot field present (inline bot like @gif)
  //  - sender display name ends with "Bot" (case-insensitive)
  const isBotMessage = (m: TelegramExportMessage) => !!m.via_bot || isBotName(m.from);

  // Identify manager: sender with from === null is the account owner (exporter)
  const msgs = chat.messages.filter((m) => m.type === "message" && !isBotMessage(m));
  const nullSender = msgs.find((m) => m.from === null);
  let managerFromId = nullSender?.from_id ?? "";

  if (!managerFromId) {
    // Fallback: most frequent sender
    const counts: Record<string, number> = {};
    for (const m of msgs) counts[m.from_id] = (counts[m.from_id] ?? 0) + 1;
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    managerFromId = sorted[0]?.[0] ?? "";
  }

  // Build pairs: for each manager message, find the preceding client message
  const pairs: { input: string; response: string }[] = [];
  let pendingClient: string | null = null;

  for (const m of msgs) {
    const text = flattenExportText(m.text).trim();
    if (!text) continue;
    if (m.from_id === managerFromId) {
      if (pendingClient !== null) {
        pairs.push({ input: pendingClient, response: text });
        pendingClient = null;
      }
    } else {
      pendingClient = text;
    }
  }

  return { pairs, managerFromId };
}

// Mask token / sessionString in API responses
function safeRecord(r: any) {
  if (!r) return null;
  const masked = { ...r, credentials: { ...r.credentials } };
  if (masked.credentials.token)
    masked.credentials.token = masked.credentials.token.slice(0, 10) + "…";
  if (masked.credentials.sessionString) masked.credentials.sessionString = "[saved]";
  return masked;
}

/**
 * Deeply serialize a value to a plain JSON-safe object.
 *
 * gramjs callTool results (e.g. sendMessage, getMessages) return live gramjs
 * objects that contain PromisedNetSockets — non-cloneable internal TCP socket
 * wrappers. If these objects are returned as tool results, the pi-agent framework
 * stores them in the agent's message history and calls structuredClone on the
 * context at every subsequent turn, causing:
 *   DataCloneError: class PromisedNetSockets { ... } could not be cloned.
 *
 * Solution: force all tool results through JSON round-trip before they leave
 * TelegramPlugin, stripping any non-serializable values (replaced with null by
 * the replacer). This guarantees the agent context only ever contains plain data.
 */
function safeSerialize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, val) => {
        // Drop functions, Promises, Buffers, class instances with non-plain proto
        if (typeof val === "function") return undefined;
        if (typeof val === "bigint") return val.toString();
        if (val instanceof Promise) return undefined;
        if (Buffer.isBuffer(val)) return val.toString("base64");
        return val;
      }),
    );
  } catch {
    // If serialization fails entirely, return a safe placeholder
    return { serialized: false, type: typeof value };
  }
}
